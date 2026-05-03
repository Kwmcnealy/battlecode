import {
  ApprovalRequestId,
  OrchestrationEvent,
  ProjectId,
  SymphonyError,
  SymphonyEvent,
  SymphonyIssueId,
  SymphonyRun,
  ThreadId,
  type SymphonyLifecyclePhase,
  type SymphonyPullRequestSummary,
  type SymphonyRunProgress,
  type SymphonyRunStatus,
  type SymphonySecretStatus,
  type SymphonySettings,
  type SymphonySnapshot,
  type SymphonySubscribeEvent,
  type SymphonyWorkflowConfig,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { getSymphonyArchiveEligibility } from "@t3tools/shared/symphony";
import { Effect, FileSystem, Layer, Path, PubSub, Ref, Schema, Stream } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { runProcess } from "../../processRunner.ts";
import { SymphonyRepository } from "../Services/SymphonyRepository.ts";
import { SymphonyService, type SymphonyServiceShape } from "../Services/SymphonyService.ts";
import {
  branchNameForIssue,
  commandId,
  eventId,
  isSymphonyThreadId,
  messageId,
  projectSecretName,
  sanitizeIssueIdentifier,
  threadId,
} from "../identity.ts";
import {
  DEFAULT_LINEAR_ENDPOINT,
  fetchLinearCandidates,
  fetchLinearIssuesByIds,
  testLinearConnection as testLinearApiKey,
  type LinearIssueWorkflowContext,
} from "../linear.ts";
import {
  MONITORED_RUN_STATUSES,
  RECOVERABLE_MONITORED_RUN_STATUSES,
  isRecoverableLegacyCanceledRun,
} from "../lifecyclePolicy.ts";
import { lifecyclePhaseIsActive, nextPhaseAfterReview } from "../lifecyclePhase.ts";
import {
  buildFixPrompt,
  buildImplementationPrompt,
  buildPlanningPrompt,
  buildReviewPrompt,
  buildSimplificationPrompt,
} from "../phasePrompts.ts";
import {
  extractLatestAssistantText,
  extractLatestPlanMarkdown,
  extractReviewOutcome,
} from "../phaseOutput.ts";
import {
  transitionLinearState,
  upsertManagedComment,
} from "../linearWriter.ts";
// TODO(phase-4): Wire decideNextAction into reconcileRunWithThread once the
// phase prompts emit SYMPHONY_PLAN_BEGIN / SYMPHONY_PR_URL markers. Currently
// the inline planning/implementing dispatch uses extractLatestPlanMarkdown
// from phaseOutput.ts, which reads proposedPlans and checklist messages.
import { decideNextAction } from "../orchestrator.ts";
import { decideArchive } from "../reconciler.ts";
import { decideSchedulerActions } from "../scheduler.ts";
import { classifyLinearState, resolveRunLifecycle } from "../runLifecycle.ts";
import {
  buildContinuationPrompt,
  blockerIsTerminal,
  buildHookEnv,
  buildIssuePrompt,
  buildTotals,
  defaultSymphonyLocalModelSelection,
  makeRun,
  queueRuns,
  replaceLatestAttempt,
  retryAfterIso,
  retryIsReady,
  shouldPoll,
} from "../runModel.ts";
import {
  defaultSecretStatus,
  hashWorkflow,
  makeDefaultSettings,
  mapRuntimeStatus,
} from "../settingsModel.ts";
import {
  STARTER_WORKFLOW_TEMPLATE,
  defaultWorkflowPath,
  parseWorkflowMarkdown,
  resolveWorkflowPath,
} from "../workflow.ts";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const DASHBOARD_EVENT_LIMIT = 80;
const SIGNAL_WARNING_COOLDOWN_MS = 30_000;
const CONTINUATION_RETRY_DELAY_MS = 1_000;
const NON_INTERACTIVE_USER_INPUT_RESPONSE =
  "Continue if possible. If this cannot be answered non-interactively, record the blocker clearly in the thread.";

type ReconcileReason =
  | "scheduler"
  | "manual-refresh"
  | "cloud-refresh"
  | "thread-event"
  | "candidate-refresh";

interface ReconciledRunResult {
  readonly run: SymphonyRun;
  readonly changed: boolean;
  readonly statusChanged: boolean;
  readonly prChanged: boolean;
  readonly currentStepChanged: boolean;
  readonly archivedChanged: boolean;
}

interface WarningEmissionState {
  readonly lastEmittedAt: number;
  readonly suppressedCount: number;
}

interface WarningEmissionDecision {
  readonly emit: boolean;
  readonly suppressedCount: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toSymphonyError(message: string) {
  return (cause: unknown): SymphonyError =>
    Schema.is(SymphonyError)(cause) ? cause : new SymphonyError({ message, cause });
}

function runProgressChanged(
  left: SymphonyRunProgress | null,
  right: SymphonyRunProgress | null,
): boolean {
  return (
    left?.source !== right?.source ||
    left?.label !== right?.label ||
    left?.detail !== right?.detail ||
    left?.updatedAt !== right?.updatedAt
  );
}

function pullRequestChanged(
  left: SymphonyPullRequestSummary | null,
  right: SymphonyPullRequestSummary | null,
): boolean {
  return (
    left?.number !== right?.number ||
    left?.title !== right?.title ||
    left?.url !== right?.url ||
    left?.baseBranch !== right?.baseBranch ||
    left?.headBranch !== right?.headBranch ||
    left?.state !== right?.state ||
    left?.updatedAt !== right?.updatedAt
  );
}

function stateMatches(states: readonly string[], stateName: string): boolean {
  const normalized = stateName.trim().toLocaleLowerCase();
  return states.some((state) => state.trim().toLocaleLowerCase() === normalized);
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

function intakeStateNames(tracker: SymphonyWorkflowConfig["tracker"]): readonly string[] {
  return tracker.intakeStates ?? ["To Do", "Todo"];
}

function monitoredLinearStateNames(tracker: SymphonyWorkflowConfig["tracker"]): readonly string[] {
  return dedupeStrings([
    ...intakeStateNames(tracker),
    ...tracker.activeStates,
    ...tracker.reviewStates,
  ]);
}

function hasReachedTurnLimit(
  run: SymphonyRun,
  workflow: { readonly config: SymphonyWorkflowConfig },
) {
  return run.attempts.length >= workflow.config.agent.maxTurns;
}

function isWarningEvent(event: SymphonyEvent): boolean {
  return event.type.toLocaleLowerCase().includes("warning");
}

function isErrorEvent(event: SymphonyEvent): boolean {
  const type = event.type.toLocaleLowerCase();
  return type.includes("error") || type.includes("failed") || type.includes("invalid");
}

function diagnosticSummary(
  events: readonly SymphonyEvent[],
  predicate: (event: SymphonyEvent) => boolean,
) {
  const matching = events.filter(predicate);
  return {
    count: matching.length,
    latestMessage: matching.at(-1)?.message ?? null,
  };
}

function latestLinearCandidateCount(events: readonly SymphonyEvent[]): number | null {
  const event = events.toReversed().find((item) => item.type === "linear.refreshed");
  const count = event?.payload.count;
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : null;
}

function queueExistingIntakeRun(input: {
  readonly run: SymphonyRun;
  readonly issue: SymphonyRun["issue"];
  readonly updatedAt: string;
}): SymphonyRun {
  return {
    ...input.run,
    issue: input.issue,
    status: "target-pending",
    lifecyclePhase: "intake",
    pullRequest: null,
    prUrl: null,
    currentStep: null,
    archivedAt: null,
    nextRetryAt: null,
    lastError: null,
    updatedAt: input.updatedAt,
  };
}

function phaseFromPullRequestState(
  pullRequest: SymphonyPullRequestSummary | null,
  fallback: SymphonyLifecyclePhase,
): SymphonyLifecyclePhase {
  if (pullRequest?.state === "open") return "in-review";
  if (pullRequest?.state === "merged") return "done";
  if (pullRequest?.state === "closed") return "canceled";
  return fallback;
}

function issuePromptInput(run: SymphonyRun) {
  return {
    issueId: run.issue.identifier,
    title: run.issue.title,
    description: run.issue.description,
  };
}

function runPlanMarkdown(run: SymphonyRun): string | null {
  const detail = run.currentStep?.detail?.trim();
  if (detail?.includes("- [")) return detail;
  return null;
}

function continuationDelayIso(now = Date.now()): string {
  return new Date(now + CONTINUATION_RETRY_DELAY_MS).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function activityPayloadRecord(activity: OrchestrationThread["activities"][number]) {
  return isRecord(activity.payload) ? activity.payload : null;
}

function requestIdFromActivity(
  activity: OrchestrationThread["activities"][number],
): ApprovalRequestId | null {
  const payload = activityPayloadRecord(activity);
  return typeof payload?.requestId === "string" ? ApprovalRequestId.make(payload.requestId) : null;
}

function isStalePendingRequestFailure(detail: unknown): boolean {
  if (typeof detail !== "string") return false;
  const normalized = detail.toLocaleLowerCase();
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending user-input request")
  );
}

function pendingApprovalRequestIds(thread: OrchestrationThread): readonly ApprovalRequestId[] {
  const openByRequestId = new Map<ApprovalRequestId, ApprovalRequestId>();
  const activities = thread.activities.toSorted((left, right) => {
    const sequenceDelta = (left.sequence ?? 0) - (right.sequence ?? 0);
    if (sequenceDelta !== 0) return sequenceDelta;
    return Date.parse(left.createdAt) - Date.parse(right.createdAt);
  });

  for (const activity of activities) {
    const requestId = requestIdFromActivity(activity);
    if (!requestId) continue;
    if (activity.kind === "approval.requested") {
      openByRequestId.set(requestId, requestId);
      continue;
    }
    if (activity.kind === "approval.resolved") {
      openByRequestId.delete(requestId);
      continue;
    }
    const detail = activityPayloadRecord(activity)?.detail;
    if (
      activity.kind === "provider.approval.respond.failed" &&
      isStalePendingRequestFailure(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()];
}

function preferredNonInteractiveOption(question: Record<string, unknown>): string {
  const options = Array.isArray(question.options)
    ? question.options
        .filter(isRecord)
        .map((option) => option.label)
        .filter((label): label is string => typeof label === "string" && label.trim().length > 0)
    : [];
  const preferred =
    options.find((label) => /approve.*session|remember/i.test(label)) ??
    options.find((label) => /continue|proceed|approve/i.test(label)) ??
    options[0];
  return preferred ?? NON_INTERACTIVE_USER_INPUT_RESPONSE;
}

function pendingUserInputResponses(
  thread: OrchestrationThread,
): readonly { readonly requestId: ApprovalRequestId; readonly answers: Record<string, unknown> }[] {
  const openByRequestId = new Map<ApprovalRequestId, Record<string, unknown>>();
  const activities = thread.activities.toSorted((left, right) => {
    const sequenceDelta = (left.sequence ?? 0) - (right.sequence ?? 0);
    if (sequenceDelta !== 0) return sequenceDelta;
    return Date.parse(left.createdAt) - Date.parse(right.createdAt);
  });

  for (const activity of activities) {
    const requestId = requestIdFromActivity(activity);
    if (!requestId) continue;
    const payload = activityPayloadRecord(activity);
    if (activity.kind === "user-input.requested") {
      const questions = Array.isArray(payload?.questions) ? payload.questions.filter(isRecord) : [];
      openByRequestId.set(
        requestId,
        Object.fromEntries(
          questions.flatMap((question) => {
            const id = typeof question.id === "string" ? question.id : null;
            return id ? [[id, preferredNonInteractiveOption(question)] as const] : [];
          }),
        ),
      );
      continue;
    }
    if (activity.kind === "user-input.resolved") {
      openByRequestId.delete(requestId);
      continue;
    }
    if (
      activity.kind === "provider.user-input.respond.failed" &&
      isStalePendingRequestFailure(payload?.detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.entries()].map(([requestId, answers]) => ({ requestId, answers }));
}

function recoveredLegacyBaselineStatus(run: SymphonyRun): SymphonyRunStatus {
  return run.threadId ? "running" : "eligible";
}

function issueChanged(left: SymphonyRun["issue"], right: SymphonyRun["issue"]): boolean {
  if (
    left.id !== right.id ||
    left.identifier !== right.identifier ||
    left.title !== right.title ||
    left.description !== right.description ||
    left.priority !== right.priority ||
    left.state !== right.state ||
    left.branchName !== right.branchName ||
    left.url !== right.url ||
    left.createdAt !== right.createdAt ||
    left.updatedAt !== right.updatedAt ||
    left.labels.length !== right.labels.length ||
    left.blockedBy.length !== right.blockedBy.length
  ) {
    return true;
  }
  if (left.labels.some((label, index) => label !== right.labels[index])) {
    return true;
  }
  return left.blockedBy.some((blocker, index) => {
    const other = right.blockedBy[index];
    return (
      other === undefined ||
      blocker.id !== other.id ||
      blocker.identifier !== other.identifier ||
      blocker.state !== other.state
    );
  });
}

const makeSymphonyService = Effect.gen(function* () {
  const repository = yield* SymphonyRepository;
  const secretStore = yield* ServerSecretStore;
  const serverConfig = yield* ServerConfig;
  const git = yield* GitCore;
  const gitManager = yield* GitManager;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const events = yield* PubSub.unbounded<SymphonySubscribeEvent>();
  const schedulerInFlight = yield* Ref.make<ReadonlySet<string>>(new Set());
  const snapshotPublishedAtByProject = yield* Ref.make<ReadonlyMap<ProjectId, number>>(new Map());
  const warningEmissionByKey = yield* Ref.make<ReadonlyMap<string, WarningEmissionState>>(
    new Map(),
  );

  const readProject = (projectId: ProjectId) =>
    repository.getProjectWorkspaceRoot(projectId).pipe(
      Effect.flatMap((workspaceRoot) =>
        workspaceRoot
          ? Effect.succeed({ projectId, workspaceRoot })
          : Effect.fail(new SymphonyError({ message: `Project ${projectId} was not found.` })),
      ),
      Effect.mapError(toSymphonyError("Failed to resolve Symphony project.")),
    );

  const readStoredSecret = (projectId: ProjectId) =>
    secretStore.get(projectSecretName(projectId)).pipe(
      Effect.map((bytes) => (bytes ? TEXT_DECODER.decode(bytes).trim() : null)),
      Effect.mapError(toSymphonyError("Failed to read Linear API key.")),
    );

  const readLinearApiKey = (projectId: ProjectId) =>
    readStoredSecret(projectId).pipe(
      Effect.map((stored) => {
        if (stored) return stored;
        return process.env.LINEAR_API_KEY?.trim() || null;
      }),
    );

  const getSecretStatus = (
    projectId: ProjectId,
  ): Effect.Effect<SymphonySecretStatus, SymphonyError> =>
    readStoredSecret(projectId).pipe(
      Effect.map((stored) => {
        if (stored) {
          return {
            source: "stored",
            configured: true,
            lastTestedAt: null,
            lastError: null,
          };
        }
        if (process.env.LINEAR_API_KEY?.trim()) {
          return {
            source: "env",
            configured: true,
            lastTestedAt: null,
            lastError: null,
          };
        }
        return defaultSecretStatus();
      }),
    );

  const loadSettings = (projectId: ProjectId): Effect.Effect<SymphonySettings, SymphonyError> =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const secretStatus = yield* getSecretStatus(projectId);
      const stored = yield* repository
        .getSettings(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load Symphony settings.")));
      const settings =
        stored ??
        makeDefaultSettings({
          projectId,
          projectRoot: project.workspaceRoot,
          linearSecret: secretStatus,
          now: nowIso(),
        });
      return {
        ...settings,
        linearSecret: {
          ...secretStatus,
          lastTestedAt: settings.linearSecret.lastTestedAt,
          lastError:
            secretStatus.configured && settings.linearSecret.configured
              ? settings.linearSecret.lastError
              : secretStatus.lastError,
        },
      };
    });

  const saveSettings = (settings: SymphonySettings) =>
    repository
      .upsertSettings(settings)
      .pipe(Effect.mapError(toSymphonyError("Failed to save Symphony settings.")));

  const appendEvent = (event: SymphonyEvent) =>
    repository.appendEvent(event).pipe(
      Effect.mapError(toSymphonyError("Failed to append Symphony event.")),
      Effect.flatMap((persisted) =>
        buildSnapshot(persisted.projectId).pipe(
          Effect.flatMap((snapshot) =>
            PubSub.publish(events, { kind: "event", event: persisted, snapshot }),
          ),
          Effect.as(persisted),
        ),
      ),
    );

  const emitProjectEvent = (input: {
    readonly projectId: ProjectId;
    readonly type: string;
    readonly message: string;
    readonly payload?: Record<string, unknown>;
    readonly runId?: SymphonyRun["runId"] | null;
    readonly issueId?: SymphonyIssueId | null;
  }) =>
    appendEvent({
      eventId: eventId(),
      projectId: input.projectId,
      runId: input.runId ?? null,
      issueId: input.issueId ?? null,
      type: input.type,
      message: input.message,
      payload: input.payload ?? {},
      createdAt: nowIso(),
    });

  const emitCoalescedWarningEvent = (input: {
    readonly projectId: ProjectId;
    readonly type: string;
    readonly message: string;
    readonly payload?: Record<string, unknown>;
    readonly runId?: SymphonyRun["runId"] | null;
    readonly issueId?: SymphonyIssueId | null;
  }): Effect.Effect<SymphonyEvent | void, SymphonyError> =>
    Ref.modify(
      warningEmissionByKey,
      (current): readonly [WarningEmissionDecision, ReadonlyMap<string, WarningEmissionState>] => {
        const reason = typeof input.payload?.reason === "string" ? input.payload.reason : "";
        const key = [
          input.projectId,
          input.runId ?? "",
          input.issueId ?? "",
          input.type,
          input.message,
          reason,
        ].join("\u0000");
        const nowMs = Date.now();
        const previous = current.get(key);
        const next = new Map(current);
        if (previous && nowMs - previous.lastEmittedAt < SIGNAL_WARNING_COOLDOWN_MS) {
          next.set(key, {
            lastEmittedAt: previous.lastEmittedAt,
            suppressedCount: previous.suppressedCount + 1,
          });
          return [{ emit: false as const, suppressedCount: 0 }, next] as const;
        }
        next.set(key, { lastEmittedAt: nowMs, suppressedCount: 0 });
        return [
          { emit: true as const, suppressedCount: previous?.suppressedCount ?? 0 },
          next,
        ] as const;
      },
    ).pipe(
      Effect.flatMap((decision) => {
        if (!decision.emit) {
          return Effect.void;
        }

        const payload =
          decision.suppressedCount > 0
            ? { ...input.payload, suppressedCount: decision.suppressedCount }
            : input.payload;

        return emitProjectEvent({
          projectId: input.projectId,
          type: input.type,
          message: input.message,
          ...(payload ? { payload } : {}),
          ...(input.runId ? { runId: input.runId } : {}),
          ...(input.issueId ? { issueId: input.issueId } : {}),
        });
      }),
    );

  const runWorkflowHook = (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly workflowPath: string;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly run: SymphonyRun;
    readonly hookName: "afterCreate" | "beforeRun" | "afterRun";
    readonly command: string | null | undefined;
    readonly workspacePath: string;
    readonly branchName: string;
    readonly failRunOnError: boolean;
  }): Effect.Effect<void, SymphonyError> => {
    const command = input.command?.trim();
    if (!command) return Effect.void;

    const shell = process.platform === "win32" ? "cmd.exe" : "sh";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
    const startedAt = nowIso();

    return emitProjectEvent({
      projectId: input.projectId,
      issueId: input.run.issue.id,
      runId: input.run.runId,
      type: `hook.${input.hookName}.started`,
      message: `Started ${input.hookName} hook for ${input.run.issue.identifier}`,
      payload: { command },
    }).pipe(
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: () =>
            runProcess(shell, args, {
              cwd: input.workspacePath,
              timeoutMs: input.workflow.config.hooks.timeoutMs,
              env: buildHookEnv({
                projectRoot: input.projectRoot,
                workflowPath: input.workflowPath,
                workspacePath: input.workspacePath,
                branchName: input.branchName,
                run: input.run,
              }),
              maxBufferBytes: 64 * 1024,
              outputMode: "truncate",
            }),
          catch: (cause) =>
            new SymphonyError({
              message: `${input.hookName} hook failed.`,
              cause,
            }),
        }),
      ),
      Effect.flatMap((result) =>
        emitProjectEvent({
          projectId: input.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: `hook.${input.hookName}.completed`,
          message: `Completed ${input.hookName} hook for ${input.run.issue.identifier}`,
          payload: {
            code: result.code,
            signal: result.signal,
            timedOut: result.timedOut,
            durationMs: Date.now() - new Date(startedAt).getTime(),
            stdout: result.stdout,
            stderr: result.stderr,
            stdoutTruncated: result.stdoutTruncated ?? false,
            stderrTruncated: result.stderrTruncated ?? false,
          },
        }),
      ),
      Effect.catchTag("SymphonyError", (error) =>
        emitProjectEvent({
          projectId: input.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: `hook.${input.hookName}.failed`,
          message: `${input.hookName} hook failed for ${input.run.issue.identifier}`,
          payload: { error: error.message },
        }).pipe(Effect.flatMap(() => (input.failRunOnError ? Effect.fail(error) : Effect.void))),
      ),
      Effect.asVoid,
    );
  };

  const readWorkspaceHeadCommit = (cwd: string): Effect.Effect<string | null, never> =>
    Effect.tryPromise({
      try: () =>
        runProcess("git", ["rev-parse", "HEAD"], {
          cwd,
          timeoutMs: 10_000,
          maxBufferBytes: 16 * 1024,
          outputMode: "truncate",
        }),
      catch: () => null,
    }).pipe(
      Effect.map((result) => {
        if (result === null || result.code !== 0) return null;
        const commit = result.stdout.trim();
        return commit.length > 0 ? commit : null;
      }),
      Effect.catch(() => Effect.succeed(null)),
    );

  function buildSnapshot(projectId: ProjectId): Effect.Effect<SymphonySnapshot, SymphonyError> {
    return Effect.gen(function* () {
      const settings = yield* loadSettings(projectId);
      const [runs, runtimeState, dashboardEvents] = yield* Effect.all(
        [
          repository
            .listRuns(projectId)
            .pipe(Effect.mapError(toSymphonyError("Failed to load Symphony runs."))),
          repository
            .getRuntimeState(projectId)
            .pipe(Effect.mapError(toSymphonyError("Failed to load Symphony runtime state."))),
          repository
            .listEvents({ projectId, limit: DASHBOARD_EVENT_LIMIT })
            .pipe(Effect.mapError(toSymphonyError("Failed to load Symphony events."))),
        ],
        { concurrency: "unbounded" },
      );
      const workflow = yield* loadValidatedWorkflow(projectId).pipe(
        Effect.map((validated) => validated.config),
        Effect.catchTag("SymphonyError", () => Effect.succeed(null)),
      );
      const readModel = yield* orchestrationEngine.getReadModel();
      const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
      const enrichedRuns =
        workflow === null
          ? runs
          : runs.map((run) => {
              const lifecycle = resolveRunLifecycle({
                run,
                config: workflow,
                thread: run.threadId ? (threadById.get(run.threadId) ?? null) : null,
                now: nowIso(),
              });
              return Object.assign({}, run, { currentStep: lifecycle.currentStep });
            });
      const queues = queueRuns(enrichedRuns);
      return {
        projectId,
        status: mapRuntimeStatus({
          runtimeStatus: runtimeState?.status ?? "idle",
          settings,
        }),
        settings,
        queues,
        totals: buildTotals(queues),
        events: [...dashboardEvents],
        diagnostics: {
          lastPollAt: runtimeState?.lastPollAt ?? null,
          queriedStates: workflow === null ? [] : monitoredLinearStateNames(workflow.tracker),
          candidateCount: latestLinearCandidateCount(dashboardEvents),
          warningSummary: diagnosticSummary(dashboardEvents, isWarningEvent),
          errorSummary: diagnosticSummary(dashboardEvents, isErrorEvent),
        },
        updatedAt: nowIso(),
      };
    });
  }

  const persistRuntimeState = (input: {
    readonly projectId: ProjectId;
    readonly status: "idle" | "running" | "paused" | "error";
    readonly lastPollAt?: string | null;
    readonly lastError?: string | null;
  }) =>
    repository
      .setRuntimeState({
        projectId: input.projectId,
        status: input.status,
        lastPollAt: input.lastPollAt ?? null,
        lastError: input.lastError ?? null,
        updatedAt: nowIso(),
      })
      .pipe(Effect.mapError(toSymphonyError("Failed to update Symphony runtime state.")));

  const invalidateWorkflowForProject = (input: {
    readonly projectId: ProjectId;
    readonly error: SymphonyError;
  }): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const invalidatedAt = nowIso();
      const current = yield* loadSettings(input.projectId);
      yield* saveSettings({
        ...current,
        workflowStatus: {
          status: "invalid",
          message: input.error.message,
          validatedAt: invalidatedAt,
          configHash: null,
        },
        updatedAt: invalidatedAt,
      });
      yield* persistRuntimeState({
        projectId: input.projectId,
        status: "error",
        lastError: input.error.message,
      });
      yield* emitProjectEvent({
        projectId: input.projectId,
        type: "workflow.invalidated",
        message: "Symphony workflow became invalid",
        payload: { error: input.error.message },
      });
    });

  const ensureInsideProjectRoot = (input: {
    readonly projectRoot: string;
    readonly candidatePath: string;
  }): Effect.Effect<string, SymphonyError> => {
    const root = path.resolve(input.projectRoot);
    const candidate = path.resolve(input.candidatePath);
    const relative = path.relative(root, candidate);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return Effect.succeed(candidate);
    }
    return Effect.fail(
      new SymphonyError({ message: "Workflow file must stay inside the project root." }),
    );
  };

  const resolveExistingWorkflowPath = (input: {
    readonly projectRoot: string;
    readonly requestedPath: string;
  }): Effect.Effect<string, SymphonyError> =>
    Effect.gen(function* () {
      const root = path.resolve(input.projectRoot);
      const logicalPath = path.isAbsolute(input.requestedPath)
        ? path.resolve(input.requestedPath)
        : path.resolve(root, input.requestedPath);
      const [realProjectRoot, realWorkflowPath] = yield* Effect.all(
        [fs.realPath(root), fs.realPath(logicalPath)],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SymphonyError({
              message: `Failed to resolve canonical workflow path at ${logicalPath}.`,
              cause,
            }),
        ),
      );
      return yield* ensureInsideProjectRoot({
        projectRoot: realProjectRoot,
        candidatePath: realWorkflowPath,
      });
    });

  const validateWorkflow = (projectId: ProjectId): Effect.Effect<SymphonySettings, SymphonyError> =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const current = yield* loadSettings(projectId);
      const workflowPath = yield* resolveExistingWorkflowPath({
        projectRoot: project.workspaceRoot,
        requestedPath: current.workflowPath,
      });
      const raw = yield* fs.readFileString(workflowPath).pipe(
        Effect.mapError(
          (cause) =>
            new SymphonyError({
              message: `Failed to read workflow file at ${workflowPath}.`,
              cause,
            }),
        ),
      );

      const workflow = yield* Effect.try({
        try: () => parseWorkflowMarkdown(raw),
        catch: (cause) =>
          new SymphonyError({
            message: cause instanceof Error ? cause.message : "Failed to parse WORKFLOW.md.",
            cause,
          }),
      });
      const next = yield* saveSettings({
        ...current,
        workflowPath,
        workflowStatus: {
          status: "valid",
          message: `Workflow validated for Linear project ${workflow.config.tracker.projectSlugId || "(unset)"}.`,
          validatedAt: nowIso(),
          configHash: hashWorkflow(raw),
        },
        updatedAt: nowIso(),
      });
      yield* emitProjectEvent({
        projectId,
        type: "workflow.validated",
        message: "Workflow validated",
        payload: {
          workflowPath,
          trackerProjectSlug: workflow.config.tracker.projectSlugId,
        },
      });
      return next;
    }).pipe(
      Effect.catchTag("SymphonyError", (error) =>
        loadSettings(projectId).pipe(
          Effect.flatMap((current) =>
            saveSettings({
              ...current,
              workflowStatus: {
                status: "invalid",
                message: error.message,
                validatedAt: nowIso(),
                configHash: null,
              },
              updatedAt: nowIso(),
            }),
          ),
          Effect.flatMap(() => Effect.fail(error)),
        ),
      ),
    );

  const loadValidatedWorkflow = (
    projectId: ProjectId,
  ): Effect.Effect<
    { readonly config: SymphonyWorkflowConfig; readonly promptTemplate: string },
    SymphonyError
  > =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const settings = yield* loadSettings(projectId);
      const workflowPath = yield* resolveExistingWorkflowPath({
        projectRoot: project.workspaceRoot,
        requestedPath: settings.workflowPath,
      });
      const raw = yield* fs
        .readFileString(workflowPath)
        .pipe(Effect.mapError(toSymphonyError(`Failed to read workflow file at ${workflowPath}.`)));
      const workflow = yield* Effect.try({
        try: () => parseWorkflowMarkdown(raw),
        catch: toSymphonyError("Failed to parse WORKFLOW.md."),
      });
      const configHash = hashWorkflow(raw);
      if (settings.workflowStatus.configHash !== configHash) {
        yield* saveSettings({
          ...settings,
          workflowPath,
          workflowStatus: {
            status: "valid",
            message: `Workflow validated for Linear project ${workflow.config.tracker.projectSlugId || "(unset)"}.`,
            validatedAt: nowIso(),
            configHash,
          },
          updatedAt: nowIso(),
        });
        yield* emitProjectEvent({
          projectId,
          type: "workflow.validated",
          message: "Workflow revalidated after file change",
          payload: {
            workflowPath,
            trackerProjectSlug: workflow.config.tracker.projectSlugId,
          },
        });
      }
      return workflow;
    });

  const fetchTrackedLinearIssues = (input: {
    readonly projectId: ProjectId;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly issueIds: readonly SymphonyIssueId[];
  }): Effect.Effect<readonly LinearIssueWorkflowContext[], SymphonyError> =>
    Effect.gen(function* () {
      const apiKey = yield* readLinearApiKey(input.projectId);
      if (!apiKey) return [];
      return yield* fetchLinearIssuesByIds({
        endpoint: input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
        apiKey,
        issueIds: input.issueIds,
      });
    });

  const linearWriterDeps = {
    readLinearApiKey,
    emitProjectEvent,
    upsertRun: (run: SymphonyRun) =>
      repository
        .upsertRun(run)
        .pipe(Effect.mapError(toSymphonyError("Failed to persist Symphony progress comment."))),
  };

  const transitionLinearRunState = (input: {
    readonly projectId: ProjectId;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly run: SymphonyRun;
    readonly stateName: string | null | undefined;
    readonly reason: string;
  }): Effect.Effect<void, never> => transitionLinearState(linearWriterDeps, input);

  const updateManagedProgressComment = (input: {
    readonly projectId: ProjectId;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly run: SymphonyRun;
    readonly planMarkdown: string | null;
    readonly statusLine: string;
    readonly milestone?: string | null;
    readonly milestoneDetail?: string | null;
  }): Effect.Effect<SymphonyRun, never> => upsertManagedComment(linearWriterDeps, input);

  const fetchLinearIssueForRun = (input: {
    readonly projectId: ProjectId;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly run: SymphonyRun;
  }): Effect.Effect<LinearIssueWorkflowContext | null, never> =>
    fetchTrackedLinearIssues({
      projectId: input.projectId,
      workflow: input.workflow,
      issueIds: [input.run.issue.id],
    }).pipe(
      Effect.map((issues) => issues.find((issue) => issue.issue.id === input.run.issue.id) ?? null),
      Effect.catchTag("SymphonyError", (error) =>
        emitCoalescedWarningEvent({
          projectId: input.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "run.signal-warning",
          message: `Linear issue lookup failed: ${error.message}`,
          payload: { reason: "by-id-reconciliation" },
        }).pipe(
          Effect.as(null),
          Effect.orElseSucceed(() => null),
        ),
      ),
    );

  const warnMissingTrackedLinearIssue = (input: {
    readonly projectId: ProjectId;
    readonly run: SymphonyRun;
    readonly reason: ReconcileReason;
  }): Effect.Effect<void, never> =>
    emitCoalescedWarningEvent({
      projectId: input.projectId,
      issueId: input.run.issue.id,
      runId: input.run.runId,
      type: "run.signal-warning",
      message: `${input.run.issue.identifier} was not returned by Linear by-id reconciliation; keeping current Symphony status.`,
      payload: { reason: input.reason },
    }).pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));

  const runForLegacyRecovery = (run: SymphonyRun): SymphonyRun =>
    isRecoverableLegacyCanceledRun(run)
      ? {
          ...run,
          status: recoveredLegacyBaselineStatus(run),
          nextRetryAt: null,
          lastError: null,
        }
      : run;

  const autoResolveLocalSymphonyPendingRequests = (input: {
    readonly projectId: ProjectId;
    readonly run: SymphonyRun;
    readonly thread: OrchestrationThread;
  }): Effect.Effect<boolean, never> =>
    Effect.gen(function* () {
      let responded = false;
      yield* Effect.forEach(
        pendingApprovalRequestIds(input.thread),
        (requestId) =>
          orchestrationEngine
            .dispatch({
              type: "thread.approval.respond",
              commandId: commandId("symphony-approval-accept"),
              threadId: input.thread.id,
              requestId,
              decision: "acceptForSession",
              createdAt: nowIso(),
            })
            .pipe(
              Effect.tap(() =>
                emitProjectEvent({
                  projectId: input.projectId,
                  issueId: input.run.issue.id,
                  runId: input.run.runId,
                  type: "run.approval-auto-accepted",
                  message: `${input.run.issue.identifier} auto-accepted a Symphony local approval`,
                  payload: { requestId },
                }).pipe(Effect.ignoreCause({ log: true })),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  responded = true;
                }),
              ),
              Effect.ignoreCause({ log: true }),
            ),
        { concurrency: 4 },
      );
      yield* Effect.forEach(
        pendingUserInputResponses(input.thread),
        ({ requestId, answers }) =>
          orchestrationEngine
            .dispatch({
              type: "thread.user-input.respond",
              commandId: commandId("symphony-user-input-continue"),
              threadId: input.thread.id,
              requestId,
              answers,
              createdAt: nowIso(),
            })
            .pipe(
              Effect.tap(() =>
                emitProjectEvent({
                  projectId: input.projectId,
                  issueId: input.run.issue.id,
                  runId: input.run.runId,
                  type: "run.user-input-auto-answered",
                  message: `${input.run.issue.identifier} auto-answered a Symphony local prompt`,
                  payload: { requestId },
                }).pipe(Effect.ignoreCause({ log: true })),
              ),
              Effect.tap(() =>
                Effect.sync(() => {
                  responded = true;
                }),
              ),
              Effect.ignoreCause({ log: true }),
            ),
        { concurrency: 4 },
      );
      return responded;
    });

  const ensureLocalSymphonyThreadFullAccess = (input: {
    readonly projectId: ProjectId;
    readonly run: SymphonyRun;
    readonly threadId: ThreadId;
    readonly branchName: string;
    readonly workspacePath: string;
  }): Effect.Effect<boolean, SymphonyError> =>
    Effect.gen(function* () {
      const ensuredAt = nowIso();
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((entry) => entry.id === input.threadId) ?? null;
      let changed = false;

      if (!thread) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: commandId("thread-create"),
            threadId: input.threadId,
            projectId: input.projectId,
            title: `Symphony ${input.run.issue.identifier}: ${input.run.issue.title}`,
            modelSelection: defaultSymphonyLocalModelSelection(),
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: input.branchName,
            worktreePath: input.workspacePath,
            createdAt: ensuredAt,
          })
          .pipe(Effect.mapError(toSymphonyError("Failed to create Symphony thread.")));
        changed = true;
      } else {
        if (thread.branch !== input.branchName || thread.worktreePath !== input.workspacePath) {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.meta.update",
              commandId: commandId("symphony-thread-meta-sync"),
              threadId: input.threadId,
              branch: input.branchName,
              worktreePath: input.workspacePath,
            })
            .pipe(Effect.mapError(toSymphonyError("Failed to sync Symphony thread metadata.")));
          changed = true;
        }
        if (thread.runtimeMode !== "full-access") {
          yield* orchestrationEngine
            .dispatch({
              type: "thread.runtime-mode.set",
              commandId: commandId("symphony-full-access"),
              threadId: input.threadId,
              runtimeMode: "full-access",
              createdAt: ensuredAt,
            })
            .pipe(Effect.mapError(toSymphonyError("Failed to set Symphony thread full access.")));
          changed = true;
          yield* emitProjectEvent({
            projectId: input.projectId,
            issueId: input.run.issue.id,
            runId: input.run.runId,
            type: "run.runtime-mode-corrected",
            message: `${input.run.issue.identifier} Symphony thread set to full-access`,
            payload: {
              previousRuntimeMode: thread.runtimeMode,
              threadId: input.threadId,
            },
          });
        }
        const responded = yield* autoResolveLocalSymphonyPendingRequests({
          projectId: input.projectId,
          run: input.run,
          thread,
        });
        changed = changed || responded;
      }

      if (changed) {
        yield* publishSnapshotUpdate(input.projectId, { force: true });
      }
      return changed;
    });

  const reconcileRunSignals = (input: {
    readonly projectRoot: string;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly run: SymphonyRun;
    readonly linearIssue?: LinearIssueWorkflowContext | null;
    readonly thread?: OrchestrationThread | null;
    readonly reason: ReconcileReason;
  }): Effect.Effect<ReconciledRunResult, SymphonyError> =>
    Effect.gen(function* () {
      const reconciledAt = nowIso();
      const branchName = input.run.branchName ?? null;
      const runWithBranch: SymphonyRun =
        branchName === input.run.branchName ? input.run : { ...input.run, branchName };
      const storedPullRequest = runWithBranch.pullRequest ?? null;
      const lifecycle = resolveRunLifecycle({
        run: input.linearIssue
          ? {
              ...runWithBranch,
              issue: input.linearIssue.issue,
            }
          : runWithBranch,
        config: input.workflow.config,
        linear: input.linearIssue
          ? {
              stateName: input.linearIssue.state.name,
              updatedAt: input.linearIssue.issue.updatedAt,
            }
          : null,
        pullRequest: storedPullRequest,
        thread: input.thread ?? null,
        now: reconciledAt,
      });
      const preserveActiveLocalPhase =
        runWithBranch.status === "running" &&
        lifecyclePhaseIsActive(runWithBranch.lifecyclePhase) &&
        lifecycle.status !== "completed" &&
        lifecycle.status !== "canceled" &&
        lifecycle.status !== "failed";
      const nextStatus = preserveActiveLocalPhase ? runWithBranch.status : lifecycle.status;
      const nextPrUrl = lifecycle.pullRequest?.url ?? runWithBranch.prUrl;
      const nextCurrentStep = lifecycle.currentStep;
      // TODO(phase-5): switch to Linear-state-driven inputs.
      // We currently feed the post-classified `nextStatus` as `linearState`,
      // and SymphonyRunStatus literals as the state lists, to preserve
      // behavior of the pre-extraction inline ternary. Phase 5's reconciler
      // tick will introduce a separate caller that uses linearIssue.state.name
      // and workflow.config.tracker.doneStates/canceledStates.
      const archiveDecision = decideArchive({
        run: {
          runId: runWithBranch.runId,
          issueId: runWithBranch.issue.id,
          status: runWithBranch.status,
          archivedAt: runWithBranch.archivedAt,
          lastSeenLinearState: input.linearIssue?.state.name ?? null,
        },
        linearState: nextStatus,
        doneStates: ["completed"],
        canceledStates: ["canceled"],
      });
      const nextArchivedAt = archiveDecision.archive
        ? (runWithBranch.archivedAt ?? reconciledAt)
        : runWithBranch.archivedAt;
      const nextLifecyclePhase = preserveActiveLocalPhase
        ? runWithBranch.lifecyclePhase
        : nextStatus === "completed"
          ? "done"
          : nextStatus === "canceled"
            ? "canceled"
            : nextStatus === "review-ready"
              ? "in-review"
              : phaseFromPullRequestState(lifecycle.pullRequest, runWithBranch.lifecyclePhase);
      const nextLastError =
        nextStatus === "failed" ? runWithBranch.lastError : runWithBranch.lastError;
      const nextRun: SymphonyRun = {
        ...runWithBranch,
        issue: input.linearIssue?.issue ?? runWithBranch.issue,
        status: nextStatus,
        lifecyclePhase: nextLifecyclePhase,
        pullRequest: lifecycle.pullRequest,
        currentStep: nextCurrentStep,
        prUrl: nextPrUrl,
        archivedAt: nextArchivedAt,
        lastError: nextLastError,
        updatedAt: input.run.updatedAt,
      };
      const statusChanged = nextRun.status !== input.run.status;
      const prChanged =
        nextRun.prUrl !== input.run.prUrl ||
        pullRequestChanged(nextRun.pullRequest ?? null, input.run.pullRequest ?? null);
      const currentStepChanged = runProgressChanged(
        nextRun.currentStep ?? null,
        input.run.currentStep ?? null,
      );
      const archivedChanged = nextRun.archivedAt !== input.run.archivedAt;
      const lifecyclePhaseChanged = nextRun.lifecyclePhase !== input.run.lifecyclePhase;
      const changed =
        statusChanged ||
        lifecyclePhaseChanged ||
        input.run.branchName !== nextRun.branchName ||
        issueChanged(nextRun.issue, input.run.issue) ||
        prChanged ||
        currentStepChanged ||
        archivedChanged ||
        nextRun.lastError !== input.run.lastError;
      const persistedRun: SymphonyRun = changed
        ? {
            ...nextRun,
            updatedAt: reconciledAt,
          }
        : nextRun;

      if (changed) {
        yield* repository
          .upsertRun(persistedRun)
          .pipe(Effect.mapError(toSymphonyError("Failed to reconcile Symphony run lifecycle.")));
      }

      if (
        persistedRun.pullRequest?.url &&
        persistedRun.pullRequest.url !== input.run.pullRequest?.url
      ) {
        yield* emitCoalescedWarningEvent({
          projectId: input.run.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "run.pr-detected",
          message: `Detected pull request for ${input.run.issue.identifier}`,
          payload: {
            prUrl: persistedRun.pullRequest.url,
            pullRequest: persistedRun.pullRequest,
            reason: input.reason,
          },
        });
      }

      if (statusChanged) {
        yield* emitProjectEvent({
          projectId: input.run.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: `run.${persistedRun.status}`,
          message: `${input.run.issue.identifier} moved to ${persistedRun.status}`,
          payload: {
            previousStatus: input.run.status,
            nextStatus: persistedRun.status,
            reason: input.reason,
          },
        });
        if (persistedRun.status === "review-ready") {
          yield* transitionLinearRunState({
            projectId: input.run.projectId,
            workflow: input.workflow,
            run: persistedRun,
            stateName: input.workflow.config.tracker.transitionStates.review,
            reason: "review-ready",
          });
        }
        if (persistedRun.status === "completed") {
          yield* transitionLinearRunState({
            projectId: input.run.projectId,
            workflow: input.workflow,
            run: persistedRun,
            stateName: input.workflow.config.tracker.transitionStates.done,
            reason: "completed",
          });
        }
        if (persistedRun.status === "canceled") {
          yield* transitionLinearRunState({
            projectId: input.run.projectId,
            workflow: input.workflow,
            run: persistedRun,
            stateName: input.workflow.config.tracker.transitionStates.canceled,
            reason: "canceled",
          });
        }
      }

      if (archivedChanged && persistedRun.archivedAt !== null) {
        yield* emitProjectEvent({
          projectId: input.run.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "run.archived",
          message: `${input.run.issue.identifier} archived`,
          payload: {
            archivedAt: persistedRun.archivedAt,
            reason: input.reason,
          },
        });
      }

      if (
        persistedRun.status === "canceled" &&
        input.run.status !== "canceled" &&
        input.run.threadId
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.stop",
            commandId: commandId("linear-canceled-stop"),
            threadId: input.run.threadId,
            createdAt: nowIso(),
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }

      if (changed) {
        yield* publishSnapshotUpdate(input.run.projectId, { force: true });
      }

      return {
        run: persistedRun,
        changed,
        statusChanged,
        prChanged,
        currentStepChanged,
        archivedChanged,
      };
    });

  const refreshCandidates = (
    projectId: ProjectId,
  ): Effect.Effect<SymphonySnapshot, SymphonyError> =>
    Effect.gen(function* () {
      const settings = yield* loadSettings(projectId);
      if (settings.workflowStatus.status !== "valid") {
        return yield* buildSnapshot(projectId);
      }
      const apiKey = yield* readLinearApiKey(projectId);
      if (!apiKey) {
        return yield* buildSnapshot(projectId);
      }

      const workflow = yield* loadValidatedWorkflow(projectId);
      if (!workflow.config.tracker.projectSlugId) {
        return yield* new SymphonyError({
          message: "WORKFLOW.md tracker.project_slug is required before polling Linear.",
        });
      }

      const issues = yield* fetchLinearCandidates({
        endpoint: workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
        apiKey,
        config: workflow.config,
      });
      const fetchedAt = nowIso();
      const project = yield* readProject(projectId);
      const existingRunsBeforeRefresh = yield* repository
        .listRuns(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load existing Symphony runs.")));
      const trackedRuns = existingRunsBeforeRefresh.filter(
        (run) =>
          run.archivedAt === null &&
          (MONITORED_RUN_STATUSES.includes(run.status) ||
            run.status === "eligible" ||
            run.status === "retry-queued" ||
            run.status === "target-pending" ||
            isRecoverableLegacyCanceledRun(run)),
      );
      const trackedLinearIssues = yield* fetchTrackedLinearIssues({
        projectId,
        workflow,
        issueIds: trackedRuns.map((run) => run.issue.id),
      }).pipe(
        Effect.catchTag("SymphonyError", (error) =>
          Effect.forEach(
            trackedRuns,
            (run) =>
              emitCoalescedWarningEvent({
                projectId,
                issueId: run.issue.id,
                runId: run.runId,
                type: "run.signal-warning",
                message: `Linear issue lookup failed: ${error.message}`,
                payload: { reason: "candidate-refresh" },
              }),
            { concurrency: 4 },
          ).pipe(Effect.as([] as readonly LinearIssueWorkflowContext[])),
        ),
      );
      const trackedLinearIssueById = new Map(
        trackedLinearIssues.map((issue) => [issue.issue.id, issue] as const),
      );
      // Load existing runs for all candidate issues, then use decideSchedulerActions
      // to determine what to create, archive, or update.
      // TODO(phase-4): Pass actual lastSeenLinearState from the DB column added by
      // Migration 032. For now, null is passed for all runs, which treats every
      // failed/released run as eligible for re-engagement (equivalent to the prior
      // shouldQueueIntakeRun behavior).
      const existingRunsForCandidates = yield* Effect.forEach(
        issues,
        (issue) =>
          repository
            .getRunByIssue({ projectId, issueId: issue.id })
            .pipe(Effect.mapError(toSymphonyError("Failed to read Symphony run."))),
        { concurrency: 6 },
      );
      const existingRunsByCandidateMap = new Map(
        existingRunsForCandidates
          .filter((run): run is NonNullable<typeof run> => run !== null)
          .map((run) => [run.issue.id, run] as const),
      );
      const runningCount = existingRunsBeforeRefresh.filter(
        (run) => run.archivedAt === null && run.status === "running",
      ).length;
      const schedulerDecisions = decideSchedulerActions({
        candidates: issues.map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          state: issue.state,
        })),
        existingRuns: [...existingRunsByCandidateMap.values()].map((run) => ({
          runId: run.runId,
          issueId: run.issue.id,
          status: run.status,
          archivedAt: run.archivedAt,
          // TODO(phase-4): use run.lastSeenLinearState once Migration 032 is applied.
          lastSeenLinearState: null,
        })),
        intakeStates: intakeStateNames(workflow.config.tracker),
        capacity: workflow.config.agent.maxConcurrentAgents,
        runningCount,
      });

      // Apply archive decisions from scheduler.
      yield* Effect.forEach(
        schedulerDecisions.archive,
        ({ runId }) =>
          Effect.gen(function* () {
            const run = existingRunsBeforeRefresh.find((r) => r.runId === runId);
            if (!run) return;
            const archivedRun: SymphonyRun = {
              ...run,
              archivedAt: fetchedAt,
              updatedAt: fetchedAt,
            };
            yield* repository
              .upsertRun(archivedRun)
              .pipe(
                Effect.mapError(toSymphonyError("Failed to archive Symphony run for re-queue.")),
              );
          }),
        { concurrency: 4 },
      );

      // Upsert all candidate issues (create or update runs).
      yield* Effect.forEach(
        issues,
        (issue) =>
          Effect.gen(function* () {
            const existing = existingRunsByCandidateMap.get(issue.id) ?? null;
            const shouldCreate = schedulerDecisions.create.some((c) => c.issueId === issue.id);
            // If the scheduler decided to create, re-queue the run via queueExistingIntakeRun
            // (for existing runs) or make a fresh run (for truly new ones).
            const wasArchived = existing !== null && existing.archivedAt !== null;
            const nextRun =
              shouldCreate && existing !== null
                ? queueExistingIntakeRun({ run: existing, issue, updatedAt: fetchedAt })
                : {
                    ...(existing ?? makeRun(projectId, issue, fetchedAt)),
                    issue,
                    updatedAt: fetchedAt,
                  };
            yield* repository
              .upsertRun(nextRun)
              .pipe(Effect.mapError(toSymphonyError("Failed to upsert Symphony run.")));
            if (wasArchived && shouldCreate) {
              yield* emitProjectEvent({
                projectId,
                issueId: issue.id,
                runId: nextRun.runId,
                type: "run.reactivated",
                message: `${issue.identifier} reactivated from Linear intake`,
                payload: {
                  reason: "linear-intake",
                  previousStatus: existing?.status,
                  nextStatus: nextRun.status,
                },
              });
            }
          }),
        { concurrency: 6 },
      );

      const fetchedIssueIds = new Set(issues.map((issue) => issue.id));
      const readModel = yield* orchestrationEngine.getReadModel();
      const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
      const existingRuns = yield* repository
        .listRuns(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load existing Symphony runs.")));
      yield* Effect.forEach(
        existingRuns.filter(
          (run) =>
            run.archivedAt === null &&
            (MONITORED_RUN_STATUSES.includes(run.status) || isRecoverableLegacyCanceledRun(run)),
        ),
        (run) => {
          const trackedIssue = trackedLinearIssueById.get(run.issue.id) ?? null;
          return reconcileRunSignals({
            projectRoot: project.workspaceRoot,
            workflow,
            run: trackedIssue ? runForLegacyRecovery(run) : run,
            linearIssue: trackedIssue,
            thread: run.threadId ? (threadById.get(run.threadId) ?? null) : null,
            reason: "candidate-refresh",
          });
        },
        { concurrency: 4 },
      );
      const reconciledRuns = yield* repository
        .listRuns(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load reconciled Symphony runs.")));
      yield* Effect.forEach(
        reconciledRuns.filter((run) => {
          if (run.archivedAt !== null) {
            return false;
          }
          if (fetchedIssueIds.has(run.issue.id)) {
            return false;
          }
          return (
            run.status === "eligible" ||
            run.status === "target-pending" ||
            run.status === "retry-queued" ||
            run.status === "running" ||
            isRecoverableLegacyCanceledRun(run)
          );
        }),
        (run) => {
          const releasedAt = nowIso();
          const trackedIssue = trackedLinearIssueById.get(run.issue.id) ?? null;
          if (!trackedIssue) {
            return warnMissingTrackedLinearIssue({
              projectId,
              run,
              reason: "candidate-refresh",
            });
          }
          const linearClassification = classifyLinearState(
            trackedIssue.state.name,
            workflow.config.tracker,
          );
          if (
            linearClassification === "active" ||
            linearClassification === "review" ||
            linearClassification === "done" ||
            linearClassification === "canceled"
          ) {
            return reconcileRunSignals({
              projectRoot: project.workspaceRoot,
              workflow,
              run: runForLegacyRecovery(run),
              linearIssue: trackedIssue,
              thread: run.threadId ? (threadById.get(run.threadId) ?? null) : null,
              reason: "candidate-refresh",
            }).pipe(Effect.asVoid);
          }
          const nextRun: SymphonyRun = {
            ...run,
            issue: trackedIssue.issue,
            status: "released",
            nextRetryAt: null,
            lastError: null,
            updatedAt: releasedAt,
          };
          return repository.upsertRun(nextRun).pipe(
            Effect.mapError(toSymphonyError("Failed to reconcile ineligible Symphony run.")),
            Effect.flatMap(() =>
              emitProjectEvent({
                projectId,
                issueId: run.issue.id,
                runId: run.runId,
                type: "run.released",
                message: `${run.issue.identifier} released because Linear is no longer eligible`,
                payload: { previousStatus: run.status, nextStatus: "released" },
              }),
            ),
            Effect.tap(() => publishSnapshotUpdate(projectId, { force: true })),
          );
        },
        { concurrency: 4 },
      );

      yield* persistRuntimeState({
        projectId,
        status: "running",
        lastPollAt: fetchedAt,
        lastError: null,
      });
      const stateCounts = Object.fromEntries(
        [...new Set(issues.map((issue) => issue.state))].map((state) => [
          state,
          issues.filter((issue) => issue.state === state).length,
        ]),
      );
      yield* emitProjectEvent({
        projectId,
        type: "linear.refreshed",
        message: `Fetched ${issues.length} Linear issues`,
        payload: {
          count: issues.length,
          projectSlug: workflow.config.tracker.projectSlugId,
          states: monitoredLinearStateNames(workflow.config.tracker),
          stateCounts,
        },
      });
      return yield* buildSnapshot(projectId);
    });

  const prepareRunWorkspace = (input: {
    readonly projectRoot: string;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly run: SymphonyRun;
  }): Effect.Effect<
    { readonly workspacePath: string; readonly branchName: string; readonly created: boolean },
    SymphonyError
  > =>
    Effect.gen(function* () {
      const branchName = input.run.branchName ?? branchNameForIssue(input.run.issue.identifier);
      const workspaceRoot =
        input.workflow.config.workspace.root.trim().length > 0
          ? input.workflow.config.workspace.root
          : path.join(serverConfig.worktreesDir, "symphony");
      const workspacePath =
        input.run.workspacePath ??
        path.join(workspaceRoot, sanitizeIssueIdentifier(input.run.issue.identifier));
      const workspaceExists = yield* fs
        .exists(workspacePath)
        .pipe(Effect.orElseSucceed(() => false));
      if (!workspaceExists) {
        yield* fs
          .makeDirectory(workspaceRoot, { recursive: true })
          .pipe(Effect.mapError(toSymphonyError("Failed to create Symphony workspace root.")));
        const gitStatus = yield* git
          .statusDetails(input.projectRoot)
          .pipe(Effect.mapError(toSymphonyError("Failed to resolve base Git branch.")));
        const baseBranch = gitStatus.branch ?? "HEAD";
        yield* git
          .createWorktree({
            cwd: input.projectRoot,
            branch: baseBranch,
            newBranch: branchName,
            path: workspacePath,
          })
          .pipe(
            Effect.catch(() =>
              git.createWorktree({
                cwd: input.projectRoot,
                branch: branchName,
                path: workspacePath,
              }),
            ),
            Effect.mapError(toSymphonyError("Failed to create Symphony Git worktree.")),
          );
      }
      return { workspacePath, branchName, created: !workspaceExists };
    });

  const startPhaseTurn = (input: {
    readonly projectId: ProjectId;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly run: SymphonyRun;
    readonly phase: SymphonyLifecyclePhase;
    readonly prompt: string;
    readonly currentStepLabel: string;
    readonly currentStepDetail?: string | null;
  }): Effect.Effect<SymphonyRun, SymphonyError> =>
    Effect.gen(function* () {
      if (!input.run.workspacePath || !input.run.branchName || !input.run.threadId) {
        return yield* new SymphonyError({
          message: "Cannot start a Symphony phase without a thread, workspace, and branch.",
        });
      }
      if (hasReachedTurnLimit(input.run, input.workflow)) {
        const failedAt = nowIso();
        const message = `Symphony reached the configured max_turns (${input.workflow.config.agent.maxTurns}) before ${input.phase}.`;
        const failedRun: SymphonyRun = {
          ...input.run,
          lifecyclePhase: "failed",
          status: "failed",
          nextRetryAt: null,
          lastError: message,
          currentStep: {
            source: "symphony",
            label: "Turn limit reached",
            detail: message,
            updatedAt: failedAt,
          },
          updatedAt: failedAt,
        };
        yield* repository
          .upsertRun(failedRun)
          .pipe(Effect.mapError(toSymphonyError("Failed to mark Symphony turn limit.")));
        yield* updateManagedProgressComment({
          projectId: input.projectId,
          workflow: input.workflow,
          run: failedRun,
          planMarkdown: runPlanMarkdown(input.run),
          statusLine: message,
          milestone: "Turn limit reached",
        });
        yield* emitProjectEvent({
          projectId: input.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "run.failed",
          message,
          payload: {
            phase: input.phase,
            maxTurns: input.workflow.config.agent.maxTurns,
          },
        });
        yield* publishSnapshotUpdate(input.projectId, { force: true });
        return failedRun;
      }
      const startedAt = nowIso();
      const attemptNumber = input.run.attempts.length + 1;
      const nextRun: SymphonyRun = {
        ...input.run,
        lifecyclePhase: input.phase,
        status: "running",
        attempts: [
          ...input.run.attempts,
          {
            attempt: attemptNumber,
            status: "launching-agent-process",
            startedAt,
            completedAt: null,
            error: null,
          },
        ],
        nextRetryAt: null,
        lastError: null,
        currentStep: {
          source: "symphony",
          label: input.currentStepLabel,
          detail: input.currentStepDetail ?? null,
          updatedAt: startedAt,
        },
        updatedAt: startedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to update Symphony phase.")));
      yield* ensureLocalSymphonyThreadFullAccess({
        projectId: input.projectId,
        run: nextRun,
        threadId: input.run.threadId,
        branchName: input.run.branchName,
        workspacePath: input.run.workspacePath,
      });
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: commandId(`${input.phase}-turn-start`),
          threadId: input.run.threadId,
          message: {
            messageId: messageId(),
            role: "user",
            text: input.prompt,
            attachments: [],
          },
          modelSelection: defaultSymphonyLocalModelSelection(),
          titleSeed: `Symphony ${input.run.issue.identifier} ${input.phase}`,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: startedAt,
        })
        .pipe(Effect.mapError(toSymphonyError("Failed to launch Symphony phase turn.")));
      yield* publishSnapshotUpdate(input.projectId, { force: true });
      return nextRun;
    });

  const startPlanningTurn = (input: {
    readonly projectId: ProjectId;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly run: SymphonyRun;
    readonly workspacePath: string;
    readonly branchName: string;
  }): Effect.Effect<SymphonyRun, SymphonyError> =>
    Effect.gen(function* () {
      const planningStartedAt = nowIso();
      const runThreadId = input.run.threadId ?? threadId(input.projectId, input.run.issue.id);
      const planningRun: SymphonyRun = {
        ...input.run,
        status: "running",
        lifecyclePhase: "planning",
        workspacePath: input.workspacePath,
        branchName: input.branchName,
        threadId: runThreadId,
        nextRetryAt: null,
        lastError: null,
        currentStep: {
          source: "symphony",
          label: "Planning",
          detail: "Creating implementation plan",
          updatedAt: planningStartedAt,
        },
        updatedAt: planningStartedAt,
      };
      yield* repository
        .upsertRun(planningRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to mark Symphony planning start.")));
      yield* transitionLinearRunState({
        projectId: input.projectId,
        workflow: input.workflow,
        run: planningRun,
        stateName: input.workflow.config.tracker.transitionStates.started,
        reason: "planning-started",
      });
      const withProgress = yield* updateManagedProgressComment({
        projectId: input.projectId,
        workflow: input.workflow,
        run: planningRun,
        planMarkdown: null,
        statusLine: "Planning started; creating implementation plan",
        milestone: "Planning started",
      });
      return yield* startPhaseTurn({
        projectId: input.projectId,
        workflow: input.workflow,
        run: withProgress,
        phase: "planning",
        prompt: buildPlanningPrompt({
          issue: issuePromptInput(input.run),
          workflowPrompt: input.workflow.promptTemplate,
        }),
        currentStepLabel: "Planning",
        currentStepDetail: "Creating implementation plan",
      });
    });

  const createPullRequestForRun = (input: {
    readonly projectId: ProjectId;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly run: SymphonyRun;
  }): Effect.Effect<SymphonyRun, SymphonyError> =>
    Effect.gen(function* () {
      const cwd = input.run.workspacePath;
      if (!cwd) {
        return yield* new SymphonyError({
          message: "Cannot create a PR without a Symphony workspace.",
        });
      }
      const baseBranch = input.workflow.config.pullRequest?.baseBranch ?? null;
      const result = yield* gitManager
        .runStackedAction({
          actionId: commandId("symphony-create-pr"),
          cwd,
          action: "commit_push_pr",
          commitMessage: `${input.run.issue.identifier}: ${input.run.issue.title}`,
          ...(baseBranch ? { baseBranch } : {}),
        })
        .pipe(Effect.mapError(toSymphonyError("Failed to create Symphony pull request.")));
      const pr =
        result.pr.status === "created" || result.pr.status === "opened_existing" ? result.pr : null;
      const prUrl = pr?.url ?? input.run.prUrl;
      const prTitle = pr?.title ?? input.run.issue.title;
      const publishedCommit =
        result.commit.commitSha ?? (yield* readWorkspaceHeadCommit(cwd)) ?? null;
      const openedAt = nowIso();
      const nextRun: SymphonyRun = {
        ...input.run,
        lifecyclePhase: "in-review",
        status: "review-ready",
        prUrl: prUrl ?? null,
        pullRequest:
          pr?.url && pr.number
            ? {
                number: pr.number,
                title: prTitle,
                url: pr.url,
                baseBranch: pr.baseBranch ?? baseBranch ?? "development",
                headBranch: pr.headBranch ?? input.run.branchName ?? input.run.issue.identifier,
                state: "open",
                updatedAt: openedAt,
              }
            : (input.run.pullRequest ?? null),
        qualityGate: {
          ...input.run.qualityGate,
          lastPublishedCommit: publishedCommit ?? input.run.qualityGate.lastPublishedCommit,
        },
        currentStep: {
          source: "github",
          label: "Pull request open",
          detail: pr?.number ? `#${pr.number} ${prTitle}` : prUrl,
          updatedAt: openedAt,
        },
        updatedAt: openedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to persist Symphony PR state.")));
      yield* transitionLinearRunState({
        projectId: input.projectId,
        workflow: input.workflow,
        run: nextRun,
        stateName: input.workflow.config.tracker.transitionStates.review,
        reason: "pr-opened",
      });
      const withProgress = yield* updateManagedProgressComment({
        projectId: input.projectId,
        workflow: input.workflow,
        run: nextRun,
        planMarkdown: runPlanMarkdown(input.run),
        statusLine: "PR opened; waiting for review",
        milestone: "PR opened",
        milestoneDetail: prUrl ?? null,
      });
      yield* emitProjectEvent({
        projectId: input.projectId,
        issueId: input.run.issue.id,
        runId: input.run.runId,
        type: "run.pr-opened",
        message: `${input.run.issue.identifier} opened a pull request`,
        payload: { prUrl },
      });
      return withProgress;
    });

  const launchLocalRun = (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly workflowPath: string;
    readonly run: SymphonyRun;
  }): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const launchedAt = nowIso();
      const runThreadId = input.run.threadId ?? threadId(input.projectId, input.run.issue.id);
      const attemptNumber = input.run.attempts.length + 1;
      const { workspacePath, branchName, created } = yield* prepareRunWorkspace({
        projectRoot: input.projectRoot,
        workflow: input.workflow,
        run: input.run,
      });
      if (created) {
        yield* runWorkflowHook({
          projectId: input.projectId,
          projectRoot: input.projectRoot,
          workflowPath: input.workflowPath,
          workflow: input.workflow,
          run: input.run,
          hookName: "afterCreate",
          command: input.workflow.config.hooks.afterCreate,
          workspacePath,
          branchName,
          failRunOnError: true,
        });
      }
      const nextRun: SymphonyRun = {
        ...input.run,
        status: "running",
        workspacePath,
        branchName,
        threadId: runThreadId,
        attempts: [
          ...input.run.attempts,
          {
            attempt: attemptNumber,
            status: "launching-agent-process",
            startedAt: launchedAt,
            completedAt: null,
            error: null,
          },
        ],
        lastError: null,
        updatedAt: launchedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to mark Symphony run as running.")));
      yield* transitionLinearRunState({
        projectId: input.projectId,
        workflow: input.workflow,
        run: nextRun,
        stateName: input.workflow.config.tracker.transitionStates.started,
        reason: "started",
      });

      yield* runWorkflowHook({
        projectId: input.projectId,
        projectRoot: input.projectRoot,
        workflowPath: input.workflowPath,
        workflow: input.workflow,
        run: nextRun,
        hookName: "beforeRun",
        command: input.workflow.config.hooks.beforeRun,
        workspacePath,
        branchName,
        failRunOnError: true,
      });

      yield* ensureLocalSymphonyThreadFullAccess({
        projectId: input.projectId,
        run: nextRun,
        threadId: runThreadId,
        branchName,
        workspacePath,
      });

      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: commandId("turn-start"),
          threadId: runThreadId,
          message: {
            messageId: messageId(),
            role: "user",
            text: buildIssuePrompt({
              issue: input.run.issue,
              workflowPrompt: input.workflow.promptTemplate,
              workflowPath: input.workflowPath,
              workspacePath,
              branchName,
            }),
            attachments: [],
          },
          modelSelection: defaultSymphonyLocalModelSelection(),
          titleSeed: `Symphony ${input.run.issue.identifier}`,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: nowIso(),
        })
        .pipe(Effect.mapError(toSymphonyError("Failed to launch Symphony Codex turn.")));

      yield* emitProjectEvent({
        projectId: input.projectId,
        issueId: input.run.issue.id,
        runId: input.run.runId,
        type: "run.launched",
        message: `Launched Codex turn for ${input.run.issue.identifier}`,
        payload: {
          branchName,
          workspacePath,
          threadId: runThreadId,
        },
      });
    }).pipe(
      Effect.catch((error: SymphonyError) =>
        repository
          .upsertRun({
            ...input.run,
            status: "failed",
            attempts: [
              ...input.run.attempts,
              {
                attempt: input.run.attempts.length + 1,
                status: "failed",
                startedAt: nowIso(),
                completedAt: nowIso(),
                error: error.message,
              },
            ],
            lastError: error.message,
            updatedAt: nowIso(),
          })
          .pipe(
            Effect.mapError(toSymphonyError("Failed to mark Symphony run as failed.")),
            Effect.flatMap(() =>
              emitProjectEvent({
                projectId: input.projectId,
                issueId: input.run.issue.id,
                runId: input.run.runId,
                type: "run.failed",
                message: `Failed to launch ${input.run.issue.identifier}`,
                payload: { error: error.message },
              }),
            ),
          ),
      ),
    );

  const readLaunchContext = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const settings = yield* loadSettings(projectId);
      const workflow = yield* loadValidatedWorkflow(projectId);
      const workflowPath = path.isAbsolute(settings.workflowPath)
        ? settings.workflowPath
        : resolveWorkflowPath(project.workspaceRoot, settings.workflowPath);
      return { project, settings, workflow, workflowPath };
    });

  const launchIssueRun = (input: {
    readonly projectId: ProjectId;
    readonly issueId: SymphonyIssueId;
  }): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const run = yield* repository
        .getRunByIssue({ projectId: input.projectId, issueId: input.issueId })
        .pipe(Effect.mapError(toSymphonyError("Failed to read Symphony run.")));
      if (!run) {
        return yield* new SymphonyError({ message: "Symphony issue was not found." });
      }
      if (run.status === "running" || run.status === "review-ready") {
        return yield* new SymphonyError({ message: `${run.issue.identifier} is already running.` });
      }

      const { project, workflow, workflowPath } = yield* readLaunchContext(input.projectId);
      const launchableRun: SymphonyRun = {
        ...run,
        status: "eligible",
        archivedAt: null,
        nextRetryAt: null,
        lastError: null,
        updatedAt: nowIso(),
      };

      yield* launchLocalRun({
        projectId: input.projectId,
        projectRoot: project.workspaceRoot,
        workflow,
        workflowPath,
        run: launchableRun,
      });
    });

  const launchQueuedRuns = (projectId: ProjectId): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const settings = yield* loadSettings(projectId);
      const workflow = yield* loadValidatedWorkflow(projectId);
      const workflowPath = path.isAbsolute(settings.workflowPath)
        ? settings.workflowPath
        : resolveWorkflowPath(project.workspaceRoot, settings.workflowPath);
      const runs = yield* repository
        .listRuns(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load Symphony runs.")));
      const readModel = yield* orchestrationEngine.getReadModel();
      const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
      const runningCount = runs.filter((run) => {
        if (run.archivedAt !== null) return false;
        if (run.status !== "running") return false;
        if (!run.threadId) return true;
        return threadById.get(run.threadId)?.latestTurn?.state === "running";
      }).length;
      const capacity = Math.max(0, workflow.config.agent.maxConcurrentAgents - runningCount);
      if (capacity === 0) return;

      const candidates = runs
        .filter((run) => {
          const intakeCandidate =
            run.lifecyclePhase === "intake" &&
            stateMatches(intakeStateNames(workflow.config.tracker), run.issue.state);
          return (
            run.archivedAt === null &&
            (run.status === "eligible" ||
              run.status === "retry-queued" ||
              (intakeCandidate && run.status === "target-pending"))
          );
        })
        .filter((run) => retryIsReady(run.nextRetryAt))
        .filter(
          (run) =>
            !run.issue.blockedBy.some(
              (blocker) =>
                !blockerIsTerminal(blocker.state, workflow.config.tracker.terminalStates),
            ),
        )
        .toSorted((left, right) => {
          const priorityDelta =
            (left.issue.priority ?? Number.MAX_SAFE_INTEGER) -
            (right.issue.priority ?? Number.MAX_SAFE_INTEGER);
          if (priorityDelta !== 0) return priorityDelta;
          const leftCreated = left.issue.createdAt ? new Date(left.issue.createdAt).getTime() : 0;
          const rightCreated = right.issue.createdAt
            ? new Date(right.issue.createdAt).getTime()
            : 0;
          if (leftCreated !== rightCreated) return leftCreated - rightCreated;
          return left.issue.identifier.localeCompare(right.issue.identifier);
        })
        .slice(0, capacity);

      yield* Effect.forEach(
        candidates,
        (run) =>
          Effect.gen(function* () {
            if (
              run.lifecyclePhase === "intake" &&
              stateMatches(intakeStateNames(workflow.config.tracker), run.issue.state)
            ) {
              const prepared = yield* prepareRunWorkspace({
                projectRoot: project.workspaceRoot,
                workflow,
                run,
              });
              if (prepared.created) {
                yield* runWorkflowHook({
                  projectId,
                  projectRoot: project.workspaceRoot,
                  workflowPath,
                  workflow,
                  run,
                  hookName: "afterCreate",
                  command: workflow.config.hooks.afterCreate,
                  workspacePath: prepared.workspacePath,
                  branchName: prepared.branchName,
                  failRunOnError: true,
                });
              }
              yield* startPlanningTurn({
                projectId,
                workflow,
                run,
                workspacePath: prepared.workspacePath,
                branchName: prepared.branchName,
              });
              return;
            }
            yield* launchLocalRun({
              projectId,
              projectRoot: project.workspaceRoot,
              workflow,
              workflowPath,
              run,
            });
          }),
        { concurrency: workflow.config.agent.maxConcurrentAgents },
      );
    });

  const readThread = (
    threadId: ThreadId,
  ): Effect.Effect<OrchestrationThread | null, SymphonyError> =>
    orchestrationEngine.getReadModel().pipe(
      Effect.map((readModel) => readModel.threads.find((thread) => thread.id === threadId) ?? null),
      Effect.mapError(toSymphonyError("Failed to read Symphony linked thread.")),
    );

  const runAfterRunHook = (input: {
    readonly run: SymphonyRun;
    readonly projectId: ProjectId;
  }): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      if (!input.run.workspacePath || !input.run.branchName) return;
      const project = yield* readProject(input.projectId);
      const settings = yield* loadSettings(input.projectId);
      const workflow = yield* loadValidatedWorkflow(input.projectId);
      const workflowPath = path.isAbsolute(settings.workflowPath)
        ? settings.workflowPath
        : resolveWorkflowPath(project.workspaceRoot, settings.workflowPath);
      yield* runWorkflowHook({
        projectId: input.projectId,
        projectRoot: project.workspaceRoot,
        workflowPath,
        workflow,
        run: input.run,
        hookName: "afterRun",
        command: workflow.config.hooks.afterRun,
        workspacePath: input.run.workspacePath,
        branchName: input.run.branchName,
        failRunOnError: false,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  const startLocalContinuationTurn = (input: {
    readonly projectId: ProjectId;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly run: SymphonyRun;
  }): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      if (!input.run.workspacePath || !input.run.branchName || !input.run.threadId) {
        return yield* new SymphonyError({
          message: "Cannot continue a local Symphony run without a thread, workspace, and branch.",
        });
      }

      const startedAt = nowIso();
      const attemptNumber = input.run.attempts.length + 1;
      const turnNumber = Math.min(attemptNumber, input.workflow.config.agent.maxTurns);
      const nextRun: SymphonyRun = {
        ...input.run,
        status: "running",
        attempts: [
          ...input.run.attempts,
          {
            attempt: attemptNumber,
            status: "launching-agent-process",
            startedAt,
            completedAt: null,
            error: null,
          },
        ],
        nextRetryAt: null,
        lastError: null,
        currentStep: {
          source: "local-thread",
          label: "Starting continuation turn",
          detail: `Continuation turn #${turnNumber} of ${input.workflow.config.agent.maxTurns}`,
          updatedAt: startedAt,
        },
        updatedAt: startedAt,
      };

      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to queue Symphony continuation turn.")));
      yield* ensureLocalSymphonyThreadFullAccess({
        projectId: input.projectId,
        run: nextRun,
        threadId: input.run.threadId,
        branchName: input.run.branchName,
        workspacePath: input.run.workspacePath,
      });
      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: commandId("continuation-turn-start"),
          threadId: input.run.threadId,
          message: {
            messageId: messageId(),
            role: "user",
            text: buildContinuationPrompt({
              turnNumber,
              maxTurns: input.workflow.config.agent.maxTurns,
            }),
            attachments: [],
          },
          modelSelection: defaultSymphonyLocalModelSelection(),
          titleSeed: `Symphony ${input.run.issue.identifier}`,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: nowIso(),
        })
        .pipe(Effect.mapError(toSymphonyError("Failed to launch Symphony continuation turn.")));
      yield* emitProjectEvent({
        projectId: input.projectId,
        issueId: input.run.issue.id,
        runId: input.run.runId,
        type: "run.continuation-started",
        message: `Started continuation turn for ${input.run.issue.identifier}`,
        payload: {
          threadId: input.run.threadId,
          attempt: attemptNumber,
          turnNumber,
        },
      });
      yield* publishSnapshotUpdate(input.projectId, { force: true });
    });

  const scheduleLocalContinuationDelay = (input: {
    readonly projectId: ProjectId;
    readonly run: SymphonyRun;
  }): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const scheduledAt = nowIso();
      const nextRetryAt = continuationDelayIso();
      const nextRun: SymphonyRun = {
        ...input.run,
        status: "running",
        nextRetryAt,
        lastError: null,
        currentStep: {
          source: "symphony",
          label: "Continuation scheduled",
          detail: "Waiting briefly before checking the active Linear issue again.",
          updatedAt: scheduledAt,
        },
        updatedAt: scheduledAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to schedule Symphony continuation.")));
      yield* emitProjectEvent({
        projectId: input.projectId,
        issueId: input.run.issue.id,
        runId: input.run.runId,
        type: "run.continuation-scheduled",
        message: `${input.run.issue.identifier} scheduled a continuation check`,
        payload: { nextRetryAt },
      });
      yield* publishSnapshotUpdate(input.projectId, { force: true });
    });

  const reconcileRunWithThread = (input: {
    readonly projectRoot: string;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly run: SymphonyRun;
    readonly linearIssue?: LinearIssueWorkflowContext | null;
    readonly thread?: OrchestrationThread | null;
    readonly reason: ReconcileReason;
  }): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const run = input.run;
      const thread = input.thread ?? null;
      const latestTurn = thread?.latestTurn ?? null;
      if (!run.threadId || !thread || !latestTurn) {
        yield* reconcileRunSignals({
          projectRoot: input.projectRoot,
          workflow: input.workflow,
          run,
          linearIssue: input.linearIssue ?? null,
          thread,
          reason: input.reason,
        });
        return;
      }

      if (latestTurn.state === "running") {
        const attempts = replaceLatestAttempt(run, { status: "streaming-turn" });
        const nextRun =
          attempts === run.attempts
            ? run
            : {
                ...run,
                attempts,
                updatedAt: nowIso(),
              };
        if (nextRun !== run) {
          yield* repository
            .upsertRun(nextRun)
            .pipe(Effect.mapError(toSymphonyError("Failed to update Symphony run attempt.")));
        }
        yield* reconcileRunSignals({
          projectRoot: input.projectRoot,
          workflow: input.workflow,
          run: nextRun,
          linearIssue: input.linearIssue ?? null,
          thread,
          reason: input.reason,
        });
        return;
      }

      if (run.status !== "running") {
        yield* reconcileRunSignals({
          projectRoot: input.projectRoot,
          workflow: input.workflow,
          run,
          linearIssue: input.linearIssue ?? null,
          thread,
          reason: input.reason,
        });
        return;
      }

      const completedAt = latestTurn.completedAt ?? nowIso();
      if (latestTurn.state === "completed") {
        const latestAttempt = run.attempts.at(-1);
        if (
          latestAttempt?.completedAt === null &&
          Date.parse(latestAttempt.startedAt) > Date.parse(completedAt)
        ) {
          return;
        }
        const attemptAlreadySucceeded =
          latestAttempt?.status === "succeeded" && latestAttempt.completedAt === completedAt;
        const attemptedRun: SymphonyRun = attemptAlreadySucceeded
          ? run
          : {
              ...run,
              attempts: replaceLatestAttempt(run, {
                status: "succeeded",
                completedAt,
                error: null,
              }),
              nextRetryAt: null,
              lastError: null,
              updatedAt: completedAt,
            };
        if (!attemptAlreadySucceeded) {
          yield* repository
            .upsertRun(attemptedRun)
            .pipe(Effect.mapError(toSymphonyError("Failed to update completed Symphony attempt.")));
        }
        if (attemptedRun.lifecyclePhase === "planning") {
          // TODO(phase-4): Replace extractLatestPlanMarkdown with
          // decideNextAction once prompts emit SYMPHONY_PLAN_BEGIN markers.
          // decideNextAction currently handles marker-based output:
          //   decideNextAction({ run: { ...attemptedRun, lifecyclePhase: "planning", lastSeenLinearState: null }, threadOutput: assistantText, threadComplete: true })
          // For now, use decideNextAction for a structural no-op check so the
          // import is wired to this call site; the actual plan is read via
          // extractLatestPlanMarkdown from phaseOutput.ts.
          void decideNextAction;
          const planMarkdown = extractLatestPlanMarkdown(thread);
          if (!planMarkdown) {
            const failedRun: SymphonyRun = {
              ...attemptedRun,
              lifecyclePhase: "failed",
              status: "failed",
              lastError: "Planning completed without a checklist plan.",
              updatedAt: completedAt,
            };
            yield* repository
              .upsertRun(failedRun)
              .pipe(Effect.mapError(toSymphonyError("Failed to mark planning as failed.")));
            return;
          }
          const plannedRun: SymphonyRun = {
            ...attemptedRun,
            lifecyclePhase: "implementing",
            currentStep: {
              source: "symphony",
              label: "Planning complete",
              detail: planMarkdown,
              updatedAt: completedAt,
            },
            updatedAt: completedAt,
          };
          yield* repository
            .upsertRun(plannedRun)
            .pipe(Effect.mapError(toSymphonyError("Failed to persist Symphony plan.")));
          const withProgress = yield* updateManagedProgressComment({
            projectId: run.projectId,
            workflow: input.workflow,
            run: plannedRun,
            planMarkdown,
            statusLine: "Planning complete; implementation starting",
            milestone: "Plan posted; moving to In Progress",
          });
          yield* transitionLinearRunState({
            projectId: run.projectId,
            workflow: input.workflow,
            run: withProgress,
            stateName: input.workflow.config.tracker.transitionStates.started,
            reason: "plan-posted",
          });
          yield* startPhaseTurn({
            projectId: run.projectId,
            workflow: input.workflow,
            run: withProgress,
            phase: "implementing",
            prompt: buildImplementationPrompt({
              issue: issuePromptInput(run),
              workflowPrompt: input.workflow.promptTemplate,
              planMarkdown,
            }),
            currentStepLabel: "Implementing approved plan",
            currentStepDetail: planMarkdown,
          });
          return;
        }

        if (attemptedRun.lifecyclePhase === "implementing") {
          const planMarkdown = runPlanMarkdown(attemptedRun);
          yield* startPhaseTurn({
            projectId: run.projectId,
            workflow: input.workflow,
            run: attemptedRun,
            phase: "simplifying",
            prompt: buildSimplificationPrompt({
              issue: issuePromptInput(run),
              workflowPrompt: input.workflow.promptTemplate,
              planMarkdown: planMarkdown ?? "",
              phaseInstructions: input.workflow.config.quality?.simplificationPrompt ?? null,
            }),
            currentStepLabel: "Simplifying implementation",
            currentStepDetail: planMarkdown,
          });
          return;
        }

        if (attemptedRun.lifecyclePhase === "simplifying") {
          const planMarkdown = runPlanMarkdown(attemptedRun);
          yield* startPhaseTurn({
            projectId: run.projectId,
            workflow: input.workflow,
            run: attemptedRun,
            phase: "reviewing",
            prompt: buildReviewPrompt({
              issue: issuePromptInput(run),
              workflowPrompt: input.workflow.promptTemplate,
              planMarkdown: planMarkdown ?? "",
              phaseInstructions: input.workflow.config.quality?.reviewPrompt ?? null,
            }),
            currentStepLabel: "Reviewing implementation",
            currentStepDetail: planMarkdown,
          });
          return;
        }

        if (attemptedRun.lifecyclePhase === "reviewing") {
          const outcome = extractReviewOutcome(extractLatestAssistantText(thread) ?? "");
          if (outcome.status === "unknown") {
            const failedRun: SymphonyRun = {
              ...attemptedRun,
              lifecyclePhase: "failed",
              status: "failed",
              lastError: "Review completed without REVIEW_PASS or REVIEW_FAIL marker.",
              updatedAt: completedAt,
            };
            yield* repository
              .upsertRun(failedRun)
              .pipe(Effect.mapError(toSymphonyError("Failed to mark review as failed.")));
            return;
          }
          const passed = outcome.status === "pass";
          const maxReviewFixLoops = input.workflow.config.quality?.maxReviewFixLoops ?? 1;
          const nextPhase = nextPhaseAfterReview({
            passed,
            remainingReviewLoops: maxReviewFixLoops - attemptedRun.qualityGate.reviewFixLoops,
          });
          const reviewedCommit = attemptedRun.workspacePath
            ? yield* readWorkspaceHeadCommit(attemptedRun.workspacePath)
            : null;
          const nextRun: SymphonyRun = {
            ...attemptedRun,
            lifecyclePhase: nextPhase,
            status: nextPhase === "failed" ? "failed" : "running",
            qualityGate: {
              ...attemptedRun.qualityGate,
              reviewFixLoops: passed
                ? attemptedRun.qualityGate.reviewFixLoops
                : attemptedRun.qualityGate.reviewFixLoops + 1,
              lastReviewPassedAt: passed
                ? completedAt
                : attemptedRun.qualityGate.lastReviewPassedAt,
              lastReviewSummary: outcome.summary,
              lastReviewFindings: [...outcome.findings],
              lastReviewedCommit: reviewedCommit ?? attemptedRun.qualityGate.lastReviewedCommit,
            },
            lastError: nextPhase === "failed" ? (outcome.summary ?? "Review failed.") : null,
            currentStep: {
              source: "symphony",
              label: passed ? "Review passed" : "Review failed",
              detail: outcome.summary,
              updatedAt: completedAt,
            },
            updatedAt: completedAt,
          };
          yield* repository
            .upsertRun(nextRun)
            .pipe(Effect.mapError(toSymphonyError("Failed to persist review outcome.")));
          const withProgress = yield* updateManagedProgressComment({
            projectId: run.projectId,
            workflow: input.workflow,
            run: nextRun,
            planMarkdown: runPlanMarkdown(attemptedRun),
            statusLine: passed ? "Review passed" : "Review failed",
          });
          if (nextPhase === "pr-ready") {
            yield* createPullRequestForRun({
              projectId: run.projectId,
              workflow: input.workflow,
              run: withProgress,
            });
            return;
          }
          if (nextPhase === "fixing") {
            yield* startPhaseTurn({
              projectId: run.projectId,
              workflow: input.workflow,
              run: withProgress,
              phase: "fixing",
              prompt: buildFixPrompt({
                issue: issuePromptInput(run),
                workflowPrompt: input.workflow.promptTemplate,
                findings: outcome.findings,
                pullRequestUrl: withProgress.prUrl ?? withProgress.pullRequest?.url ?? null,
              }),
              currentStepLabel: "Fixing review findings",
              currentStepDetail: outcome.findings.join("\n"),
            });
          }
          return;
        }

        if (attemptedRun.lifecyclePhase === "fixing") {
          const planMarkdown = runPlanMarkdown(attemptedRun);
          const currentCommit = attemptedRun.workspacePath
            ? yield* readWorkspaceHeadCommit(attemptedRun.workspacePath)
            : null;
          const workspaceStatus = attemptedRun.workspacePath
            ? yield* git.statusDetails(attemptedRun.workspacePath).pipe(
                Effect.mapError(() => null),
                Effect.catch(() => Effect.succeed(null)),
              )
            : null;
          const reviewedCommit = attemptedRun.qualityGate.lastReviewedCommit;
          if (
            reviewedCommit !== null &&
            currentCommit === reviewedCommit &&
            workspaceStatus?.hasWorkingTreeChanges !== true
          ) {
            const message =
              "Fix phase completed without code, test, or documentation changes for the active feedback.";
            const failedRun: SymphonyRun = {
              ...attemptedRun,
              lifecyclePhase: "failed",
              status: "failed",
              nextRetryAt: null,
              lastError: message,
              currentStep: {
                source: "symphony",
                label: "Fix made no changes",
                detail: message,
                updatedAt: completedAt,
              },
              updatedAt: completedAt,
            };
            yield* repository
              .upsertRun(failedRun)
              .pipe(Effect.mapError(toSymphonyError("Failed to mark no-op fix as failed.")));
            yield* updateManagedProgressComment({
              projectId: run.projectId,
              workflow: input.workflow,
              run: failedRun,
              planMarkdown,
              statusLine: message,
              milestone: "Fix made no changes",
            });
            yield* emitProjectEvent({
              projectId: run.projectId,
              issueId: run.issue.id,
              runId: run.runId,
              type: "run.failed",
              message,
              payload: { phase: "fixing", reviewedCommit },
            });
            return;
          }
          const fixedRun: SymphonyRun = {
            ...attemptedRun,
            qualityGate: {
              ...attemptedRun.qualityGate,
              lastFixCommit: currentCommit ?? attemptedRun.qualityGate.lastFixCommit,
            },
          };
          if (fixedRun !== attemptedRun) {
            yield* repository
              .upsertRun(fixedRun)
              .pipe(Effect.mapError(toSymphonyError("Failed to persist fixed commit marker.")));
          }
          yield* startPhaseTurn({
            projectId: run.projectId,
            workflow: input.workflow,
            run: fixedRun,
            phase: "simplifying",
            prompt: buildSimplificationPrompt({
              issue: issuePromptInput(run),
              workflowPrompt: input.workflow.promptTemplate,
              planMarkdown: planMarkdown ?? "",
              phaseInstructions: input.workflow.config.quality?.simplificationPrompt ?? null,
            }),
            currentStepLabel: "Simplifying fixes",
            currentStepDetail: planMarkdown,
          });
          return;
        }

        const linearIssue =
          input.linearIssue !== undefined
            ? input.linearIssue
            : yield* fetchLinearIssueForRun({
                projectId: run.projectId,
                workflow: input.workflow,
                run: attemptedRun,
              });
        if (linearIssue === null) {
          yield* warnMissingTrackedLinearIssue({
            projectId: run.projectId,
            run: attemptedRun,
            reason: input.reason,
          });
        }
        const reconciled = yield* reconcileRunSignals({
          projectRoot: input.projectRoot,
          workflow: input.workflow,
          run: attemptedRun,
          linearIssue,
          thread,
          reason: input.reason,
        });
        const nextRun = reconciled.run;
        if (!attemptAlreadySucceeded) {
          yield* runAfterRunHook({ projectId: run.projectId, run: nextRun });
        }
        const linearClassification = linearIssue
          ? classifyLinearState(linearIssue.state.name, input.workflow.config.tracker)
          : "released";
        if (nextRun.status === "running" && linearClassification === "active") {
          if (nextRun.nextRetryAt && !retryIsReady(nextRun.nextRetryAt)) {
            return;
          }
          if (
            nextRun.attempts.length >= input.workflow.config.agent.maxTurns &&
            nextRun.nextRetryAt === null
          ) {
            yield* scheduleLocalContinuationDelay({
              projectId: run.projectId,
              run: nextRun,
            });
            return;
          }
          yield* startLocalContinuationTurn({
            projectId: run.projectId,
            workflow: input.workflow,
            run: nextRun,
          });
        }
        return;
      }

      if (latestTurn.state === "interrupted") {
        const attemptNumber = Math.max(1, run.attempts.at(-1)?.attempt ?? run.attempts.length);
        const canRetry = attemptNumber < input.workflow.config.agent.maxTurns;
        const attemptedRun: SymphonyRun = {
          ...run,
          status: canRetry ? "retry-queued" : "failed",
          attempts: replaceLatestAttempt(run, {
            status: "failed",
            completedAt,
            error: "Codex turn was interrupted.",
          }),
          nextRetryAt: canRetry
            ? retryAfterIso(attemptNumber, input.workflow.config.agent.maxRetryBackoffMs)
            : null,
          lastError: "Codex turn was interrupted.",
          updatedAt: completedAt,
        };
        yield* repository
          .upsertRun(attemptedRun)
          .pipe(Effect.mapError(toSymphonyError("Failed to update interrupted Symphony attempt.")));
        const reconciled = canRetry
          ? { run: attemptedRun }
          : yield* reconcileRunSignals({
              projectRoot: input.projectRoot,
              workflow: input.workflow,
              run: attemptedRun,
              linearIssue: input.linearIssue ?? null,
              thread,
              reason: input.reason,
            });
        yield* runAfterRunHook({ projectId: run.projectId, run: reconciled.run });
        yield* emitProjectEvent({
          projectId: run.projectId,
          issueId: run.issue.id,
          runId: run.runId,
          type: canRetry ? "run.retry-queued" : "run.failed",
          message: canRetry
            ? `${run.issue.identifier} was interrupted and queued for retry`
            : `${run.issue.identifier} was interrupted`,
          payload: {
            threadId: run.threadId,
            nextRetryAt: attemptedRun.nextRetryAt,
            error: attemptedRun.lastError,
          },
        });
        return;
      }

      const attemptNumber = Math.max(1, run.attempts.at(-1)?.attempt ?? run.attempts.length);
      const canRetry = attemptNumber < input.workflow.config.agent.maxTurns;
      const errorMessage = thread.session?.lastError ?? "Codex turn failed.";
      const nextRun: SymphonyRun = {
        ...run,
        status: canRetry ? "retry-queued" : "failed",
        attempts: replaceLatestAttempt(run, {
          status: "failed",
          completedAt,
          error: errorMessage,
        }),
        nextRetryAt: canRetry
          ? retryAfterIso(attemptNumber, input.workflow.config.agent.maxRetryBackoffMs)
          : null,
        lastError: errorMessage,
        updatedAt: completedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to reconcile failed Symphony run.")));
      const reconciled = canRetry
        ? { run: nextRun }
        : yield* reconcileRunSignals({
            projectRoot: input.projectRoot,
            workflow: input.workflow,
            run: nextRun,
            linearIssue: input.linearIssue ?? null,
            thread,
            reason: input.reason,
          });
      yield* runAfterRunHook({ projectId: run.projectId, run: reconciled.run });
      yield* emitProjectEvent({
        projectId: run.projectId,
        issueId: run.issue.id,
        runId: run.runId,
        type: canRetry ? "run.retry-queued" : "run.failed",
        message: canRetry
          ? `${run.issue.identifier} failed and was queued for retry`
          : `${run.issue.identifier} failed`,
        payload: {
          threadId: run.threadId,
          nextRetryAt: nextRun.nextRetryAt,
          error: errorMessage,
        },
      });
    });

  const reconcileProjectRuns = (projectId: ProjectId): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const workflow = yield* loadValidatedWorkflow(projectId);
      const runs = yield* repository
        .listRunsForMonitoring(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load Symphony runs for monitoring.")));
      if (runs.length === 0) return;

      const trackedLinearIssues = yield* fetchTrackedLinearIssues({
        projectId,
        workflow,
        issueIds: runs.map((run) => run.issue.id),
      }).pipe(
        Effect.catchTag("SymphonyError", (error) =>
          Effect.forEach(
            runs,
            (run) =>
              emitCoalescedWarningEvent({
                projectId,
                issueId: run.issue.id,
                runId: run.runId,
                type: "run.signal-warning",
                message: `Linear issue lookup failed: ${error.message}`,
                payload: { reason: "scheduler" },
              }),
            { concurrency: 4 },
          ).pipe(Effect.as([] as readonly LinearIssueWorkflowContext[])),
        ),
      );
      const trackedLinearIssueById = new Map(
        trackedLinearIssues.map((issue) => [issue.issue.id, issue] as const),
      );
      const readModel = yield* orchestrationEngine.getReadModel();
      const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));

      yield* Effect.forEach(
        runs,
        (run) =>
          Effect.gen(function* () {
            const thread = run.threadId ? (threadById.get(run.threadId) ?? null) : null;
            const linearIssue = trackedLinearIssueById.get(run.issue.id) ?? null;
            const runForReconciliation = linearIssue ? runForLegacyRecovery(run) : run;
            if (!linearIssue && isRecoverableLegacyCanceledRun(run)) {
              yield* warnMissingTrackedLinearIssue({
                projectId,
                run,
                reason: "scheduler",
              });
            }

            yield* reconcileRunWithThread({
              projectRoot: project.workspaceRoot,
              workflow,
              run: runForReconciliation,
              linearIssue,
              thread,
              reason: "scheduler",
            });
          }),
        { concurrency: 4 },
      );
    });

  const publishSnapshotUpdate = (
    projectId: ProjectId,
    options: { readonly force?: boolean } = {},
  ): Effect.Effect<void, never> =>
    Ref.modify(snapshotPublishedAtByProject, (current) => {
      const now = Date.now();
      const lastPublishedAt = current.get(projectId) ?? 0;
      if (options.force !== true && now - lastPublishedAt < 1_000) {
        return [false, current] as const;
      }
      const next = new Map(current);
      next.set(projectId, now);
      return [true, next] as const;
    }).pipe(
      Effect.flatMap((shouldPublish) =>
        shouldPublish
          ? buildSnapshot(projectId).pipe(
              Effect.flatMap((snapshot) => PubSub.publish(events, { kind: "snapshot", snapshot })),
              Effect.asVoid,
              Effect.ignoreCause({ log: true }),
            )
          : Effect.void,
      ),
    );

  const handleOrchestrationEvent = (event: OrchestrationEvent): Effect.Effect<void, never> => {
    if (event.aggregateKind !== "thread" || !isSymphonyThreadId(event.aggregateId)) {
      return Effect.void;
    }
    const threadId = ThreadId.make(event.aggregateId);
    return repository.getRunByThreadId(threadId).pipe(
      Effect.mapError(toSymphonyError("Failed to find Symphony run for thread event.")),
      Effect.flatMap((run) =>
        run
          ? Effect.gen(function* () {
              const project = yield* readProject(run.projectId);
              const workflow = yield* loadValidatedWorkflow(run.projectId);
              const thread = run.threadId ? yield* readThread(run.threadId) : null;
              yield* reconcileRunWithThread({
                projectRoot: project.workspaceRoot,
                workflow,
                run,
                thread,
                reason: "thread-event",
              });
              yield* publishSnapshotUpdate(run.projectId);
            })
          : Effect.void,
      ),
      Effect.ignoreCause({ log: true }),
    );
  };

  const runSchedulerTick = (projectId: ProjectId): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const runtimeState = yield* repository
        .getRuntimeState(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load Symphony runtime state.")));

      yield* reconcileProjectRuns(projectId);

      if (runtimeState?.status !== "running") return;

      const settings = yield* loadSettings(projectId);
      if (settings.workflowStatus.status !== "valid" || !settings.linearSecret.configured) {
        return;
      }
      const workflow = yield* loadValidatedWorkflow(projectId).pipe(
        Effect.catchTag("SymphonyError", (error) =>
          invalidateWorkflowForProject({ projectId, error }).pipe(Effect.as(null)),
        ),
      );
      if (workflow === null) return;
      if (shouldPoll(runtimeState.lastPollAt, workflow.config.polling.schedulerIntervalMs)) {
        yield* refreshCandidates(projectId);
      }
      yield* launchQueuedRuns(projectId);
    });

  const runExclusiveSchedulerTick = (projectId: ProjectId): Effect.Effect<void, never> =>
    Ref.modify(schedulerInFlight, (current) => {
      if (current.has(projectId)) {
        return [false, current] as const;
      }
      const next = new Set(current);
      next.add(projectId);
      return [true, next] as const;
    }).pipe(
      Effect.flatMap((shouldRun) =>
        shouldRun
          ? runSchedulerTick(projectId).pipe(
              Effect.ignoreCause({ log: true }),
              Effect.ensuring(
                Ref.update(schedulerInFlight, (current) => {
                  const next = new Set(current);
                  next.delete(projectId);
                  return next;
                }),
              ),
            )
          : Effect.void,
      ),
    );

  const tickRunningProjects = Effect.gen(function* () {
    const runtimeStates = yield* repository
      .listRuntimeStates()
      .pipe(Effect.mapError(toSymphonyError("Failed to list Symphony runtime states.")));
    const monitoredProjectIds = yield* repository
      .listProjectIdsWithRunsInStatuses({
        statuses: RECOVERABLE_MONITORED_RUN_STATUSES,
        includeArchived: false,
      })
      .pipe(Effect.mapError(toSymphonyError("Failed to list Symphony monitored run projects.")));
    const projectIds = [
      ...new Set([
        ...runtimeStates
          .filter((state) => state.status === "running")
          .map((state) => state.projectId),
        ...monitoredProjectIds,
      ]),
    ];
    yield* Effect.forEach(projectIds, runExclusiveSchedulerTick, { concurrency: 2 });
  }).pipe(Effect.ignoreCause({ log: true }));

  const setLinearApiKey: SymphonyServiceShape["setLinearApiKey"] = ({ projectId, key }) =>
    Effect.gen(function* () {
      yield* readProject(projectId);
      yield* secretStore
        .set(projectSecretName(projectId), TEXT_ENCODER.encode(key))
        .pipe(Effect.mapError(toSymphonyError("Failed to save Linear API key.")));
      const current = yield* loadSettings(projectId);
      const linearSecret: SymphonySecretStatus = {
        source: "stored",
        configured: true,
        lastTestedAt: null,
        lastError: null,
      };
      yield* saveSettings({ ...current, linearSecret, updatedAt: nowIso() });
      yield* emitProjectEvent({
        projectId,
        type: "linear.secret-set",
        message: "Linear API key configured",
      });
      return linearSecret;
    });

  const testLinearConnection: SymphonyServiceShape["testLinearConnection"] = ({ projectId }) =>
    Effect.gen(function* () {
      const apiKey = yield* readLinearApiKey(projectId);
      const current = yield* loadSettings(projectId);
      if (!apiKey) {
        const linearSecret: SymphonySecretStatus = {
          source: "missing",
          configured: false,
          lastTestedAt: nowIso(),
          lastError: "Linear API key is missing.",
        };
        yield* saveSettings({ ...current, linearSecret, updatedAt: nowIso() });
        return linearSecret;
      }

      const endpoint = yield* loadValidatedWorkflow(projectId).pipe(
        Effect.map((workflow) => workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT),
        Effect.catchTag("SymphonyError", () => Effect.succeed(DEFAULT_LINEAR_ENDPOINT)),
      );

      const testedAt = nowIso();
      const result = yield* Effect.exit(testLinearApiKey({ endpoint, apiKey }));
      const linearSecret: SymphonySecretStatus =
        result._tag === "Success"
          ? {
              source: process.env.LINEAR_API_KEY?.trim() === apiKey ? "env" : "stored",
              configured: true,
              lastTestedAt: testedAt,
              lastError: null,
            }
          : {
              source: current.linearSecret.source,
              configured: true,
              lastTestedAt: testedAt,
              lastError: "Linear connection test failed.",
            };
      yield* saveSettings({ ...current, linearSecret, updatedAt: nowIso() });
      return linearSecret;
    });

  const deleteLinearApiKey: SymphonyServiceShape["deleteLinearApiKey"] = ({ projectId }) =>
    Effect.gen(function* () {
      yield* secretStore
        .remove(projectSecretName(projectId))
        .pipe(Effect.mapError(toSymphonyError("Failed to delete Linear API key.")));
      const current = yield* loadSettings(projectId);
      const linearSecret = defaultSecretStatus();
      yield* saveSettings({ ...current, linearSecret, updatedAt: nowIso() });
      yield* emitProjectEvent({
        projectId,
        type: "linear.secret-deleted",
        message: "Stored Linear API key deleted",
      });
      return linearSecret;
    });

  const updateWorkflowPath: SymphonyServiceShape["updateWorkflowPath"] = ({
    projectId,
    path: nextPath,
  }) =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const current = yield* loadSettings(projectId);
      const workflowPath = resolveWorkflowPath(project.workspaceRoot, nextPath);
      const next = yield* saveSettings({
        ...current,
        workflowPath,
        workflowStatus: {
          status: "unvalidated",
          message: "Workflow path changed. Validate before starting Symphony.",
          validatedAt: null,
          configHash: null,
        },
        updatedAt: nowIso(),
      });
      yield* emitProjectEvent({
        projectId,
        type: "workflow.path-updated",
        message: "Workflow path updated",
        payload: { workflowPath },
      });
      return next;
    }).pipe(Effect.mapError(toSymphonyError("Failed to update workflow path.")));

  const createStarterWorkflow: SymphonyServiceShape["createStarterWorkflow"] = ({ projectId }) =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const workflowPath = defaultWorkflowPath(project.workspaceRoot);
      const exists = yield* fs.exists(workflowPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        yield* fs
          .writeFileString(workflowPath, STARTER_WORKFLOW_TEMPLATE)
          .pipe(
            Effect.mapError(
              toSymphonyError(`Failed to create starter workflow at ${workflowPath}.`),
            ),
          );
      }
      yield* updateWorkflowPath({ projectId, path: workflowPath });
      return yield* validateWorkflow(projectId);
    });

  const getSettings: SymphonyServiceShape["getSettings"] = ({ projectId }) =>
    loadSettings(projectId);

  const getSnapshot: SymphonyServiceShape["getSnapshot"] = ({ projectId }) =>
    buildSnapshot(projectId);

  const start: SymphonyServiceShape["start"] = ({ projectId }) =>
    Effect.gen(function* () {
      yield* persistRuntimeState({ projectId, status: "running" });
      yield* emitProjectEvent({
        projectId,
        type: "runtime.started",
        message: "Symphony started",
      });
      yield* refreshCandidates(projectId);
      yield* launchQueuedRuns(projectId);
      return yield* buildSnapshot(projectId);
    });

  const pause: SymphonyServiceShape["pause"] = ({ projectId }) =>
    persistRuntimeState({ projectId, status: "paused" }).pipe(
      Effect.flatMap(() =>
        emitProjectEvent({ projectId, type: "runtime.paused", message: "Symphony paused" }),
      ),
      Effect.flatMap(() => buildSnapshot(projectId)),
    );

  const resume: SymphonyServiceShape["resume"] = ({ projectId }) =>
    persistRuntimeState({ projectId, status: "running" }).pipe(
      Effect.flatMap(() =>
        emitProjectEvent({ projectId, type: "runtime.resumed", message: "Symphony resumed" }),
      ),
      Effect.flatMap(() => refreshCandidates(projectId)),
      Effect.flatMap(() => launchQueuedRuns(projectId)),
      Effect.flatMap(() => buildSnapshot(projectId)),
    );

  const refresh: SymphonyServiceShape["refresh"] = ({ projectId }) =>
    reconcileProjectRuns(projectId).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.flatMap(() => refreshCandidates(projectId)),
    );

  const launchIssue: SymphonyServiceShape["launchIssue"] = ({ projectId, issueId }) =>
    launchIssueRun({ projectId, issueId }).pipe(Effect.flatMap(() => buildSnapshot(projectId)));

  const stopIssue: SymphonyServiceShape["stopIssue"] = ({ projectId, issueId }) =>
    Effect.gen(function* () {
      const run = yield* repository
        .getRunByIssue({ projectId, issueId })
        .pipe(Effect.mapError(toSymphonyError("Failed to read Symphony run.")));
      const stoppedAt = nowIso();
      if (run) {
        const nextRun: SymphonyRun = {
          ...run,
          status: "canceled",
          attempts:
            run.status === "running"
              ? replaceLatestAttempt(run, {
                  status: "canceled-by-reconciliation",
                  completedAt: stoppedAt,
                  error: "Canceled from the Symphony dashboard.",
                })
              : run.attempts,
          nextRetryAt: null,
          lastError: null,
          updatedAt: stoppedAt,
        };
        yield* repository
          .upsertRun(nextRun)
          .pipe(Effect.mapError(toSymphonyError("Failed to stop Symphony issue.")));
        const workflow = yield* loadValidatedWorkflow(projectId).pipe(
          Effect.catchTag("SymphonyError", () => Effect.succeed(null)),
        );
        if (workflow) {
          yield* transitionLinearRunState({
            projectId,
            workflow,
            run: nextRun,
            stateName: workflow.config.tracker.transitionStates.canceled,
            reason: "stopped",
          });
        }
      }
      if (run?.threadId) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.session.stop",
            commandId: commandId("thread-session-stop"),
            threadId: run.threadId,
            createdAt: stoppedAt,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      yield* emitProjectEvent({
        projectId,
        issueId,
        type: "issue.stopped",
        message: "Issue run stopped",
      });
      return yield* buildSnapshot(projectId);
    });

  const retryIssue: SymphonyServiceShape["retryIssue"] = ({ projectId, issueId }) =>
    repository.getRunByIssue({ projectId, issueId }).pipe(
      Effect.mapError(toSymphonyError("Failed to read Symphony run.")),
      Effect.flatMap((run) =>
        run
          ? repository
              .upsertRun({
                ...run,
                status: "target-pending",
                archivedAt: null,
                nextRetryAt: null,
                lastError: null,
                updatedAt: nowIso(),
              })
              .pipe(Effect.mapError(toSymphonyError("Failed to retry Symphony issue.")))
          : Effect.void,
      ),
      Effect.flatMap(() =>
        emitProjectEvent({
          projectId,
          issueId,
          type: "issue.retry-queued",
          message: "Issue run queued for retry",
        }),
      ),
      Effect.flatMap(() => buildSnapshot(projectId)),
    );

  const archiveIssue: SymphonyServiceShape["archiveIssue"] = ({ projectId, issueId }) =>
    Effect.gen(function* () {
      const run = yield* repository
        .getRunByIssue({ projectId, issueId })
        .pipe(Effect.mapError(toSymphonyError("Failed to read Symphony run.")));
      if (!run) {
        return yield* buildSnapshot(projectId);
      }
      const eligibility = getSymphonyArchiveEligibility(run);
      if (!eligibility.canArchive) {
        return yield* new SymphonyError({
          message: eligibility.reason ?? "Symphony run cannot be archived right now.",
        });
      }
      if (run.archivedAt !== null) {
        return yield* buildSnapshot(projectId);
      }

      const archivedAt = nowIso();
      const nextRun: SymphonyRun = {
        ...run,
        archivedAt,
        updatedAt: archivedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to archive Symphony issue.")));
      yield* emitProjectEvent({
        projectId,
        issueId,
        runId: run.runId,
        type: "run.archived",
        message: `${run.issue.identifier} archived`,
        payload: {
          archivedAt,
          reason: "manual",
        },
      });
      return yield* buildSnapshot(projectId);
    });

  const openLinkedThread: SymphonyServiceShape["openLinkedThread"] = ({ projectId, issueId }) =>
    repository.getRunByIssue({ projectId, issueId }).pipe(
      Effect.mapError(toSymphonyError("Failed to read linked Symphony thread.")),
      Effect.map((run) => ({ threadId: run?.threadId ?? null })),
    );

  const subscribe: SymphonyServiceShape["subscribe"] = ({ projectId }) =>
    Stream.concat(
      Stream.fromEffect(
        buildSnapshot(projectId).pipe(
          Effect.map((snapshot) => ({ kind: "snapshot" as const, snapshot })),
        ),
      ),
      Stream.fromPubSub(events).pipe(
        Stream.filter((event): event is SymphonySubscribeEvent =>
          event.kind === "snapshot"
            ? event.snapshot.projectId === projectId
            : event.snapshot.projectId === projectId,
        ),
      ),
    );

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, handleOrchestrationEvent).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );
  yield* Effect.forever(tickRunningProjects.pipe(Effect.flatMap(() => Effect.sleep(5_000))), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  return {
    getSettings,
    updateWorkflowPath,
    createStarterWorkflow,
    validateWorkflow: ({ projectId }) => validateWorkflow(projectId),
    setLinearApiKey,
    testLinearConnection,
    deleteLinearApiKey,
    getSnapshot,
    subscribe,
    start,
    pause,
    resume,
    refresh,
    launchIssue,
    stopIssue,
    retryIssue,
    archiveIssue,
    openLinkedThread,
  } satisfies SymphonyServiceShape;
});

export const SymphonyServiceLive = Layer.effect(SymphonyService, makeSymphonyService);
