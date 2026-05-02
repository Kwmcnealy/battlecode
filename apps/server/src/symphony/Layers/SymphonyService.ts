import {
  OrchestrationEvent,
  ProjectId,
  SymphonyError,
  SymphonyEvent,
  SymphonyIssueId,
  SymphonyRun,
  ThreadId,
  type SymphonyCloudTask,
  type SymphonyExecutionTarget,
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
import { Effect, FileSystem, Layer, Path, PubSub, Ref, Schema, Stream } from "effect";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli, type GitHubPullRequestSummary } from "../../git/Services/GitHubCli.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { runProcess } from "../../processRunner.ts";
import { SymphonyRepository } from "../Services/SymphonyRepository.ts";
import { SymphonyService, type SymphonyServiceShape } from "../Services/SymphonyService.ts";
import {
  buildCodexCloudDelegationComment,
  parseGitHubRepositoryFromRemoteUrl,
  type CodexCloudRepositoryContext,
} from "../codexCloud.ts";
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
  createLinearComment,
  detectLinearCodexTask,
  fetchLinearCandidates,
  fetchLinearIssuesByIds,
  testLinearConnection as testLinearApiKey,
  updateLinearIssueState,
  type LinearIssueWorkflowContext,
} from "../linear.ts";
import { resolveRunLifecycle } from "../runLifecycle.ts";
import {
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
const SIGNAL_WARNING_PREFIX = "GitHub PR lookup failed: ";
const MONITORED_RUN_STATUSES: readonly SymphonyRunStatus[] = [
  "running",
  "cloud-submitted",
  "cloud-running",
  "review-ready",
  "completed",
];

type ReconcileReason =
  | "scheduler"
  | "manual-refresh"
  | "cloud-refresh"
  | "thread-event"
  | "candidate-refresh";

interface PullRequestLookupResult {
  readonly pullRequest: SymphonyPullRequestSummary | null;
  readonly warning: string | null;
}

interface ReconciledRunResult {
  readonly run: SymphonyRun;
  readonly changed: boolean;
  readonly statusChanged: boolean;
  readonly prChanged: boolean;
  readonly currentStepChanged: boolean;
  readonly archivedChanged: boolean;
  readonly warningChanged: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function toSymphonyError(message: string) {
  return (cause: unknown): SymphonyError =>
    Schema.is(SymphonyError)(cause) ? cause : new SymphonyError({ message, cause });
}

function errorDetail(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message.trim();
  }
  return String(cause);
}

function warningFromLastError(lastError: string | null): string | null {
  return lastError?.startsWith(SIGNAL_WARNING_PREFIX) === true ? lastError : null;
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

const emptyCodexCloudTask = (): SymphonyCloudTask => ({
  provider: "codex-cloud-linear",
  status: "unknown",
  taskUrl: null,
  linearCommentId: null,
  linearCommentUrl: null,
  repository: null,
  repositoryUrl: null,
  lastMessage: null,
  delegatedAt: null,
  lastCheckedAt: null,
});

const submittedCodexCloudTask = (input: {
  readonly comment: { readonly id: string; readonly url: string | null };
  readonly repository: CodexCloudRepositoryContext;
  readonly delegatedAt: string;
}): SymphonyCloudTask => ({
  ...emptyCodexCloudTask(),
  status: "submitted",
  linearCommentId: input.comment.id,
  linearCommentUrl: input.comment.url,
  repository: input.repository.nameWithOwner,
  repositoryUrl: input.repository.httpsUrl,
  delegatedAt: input.delegatedAt,
  lastCheckedAt: input.delegatedAt,
});

const failedCodexCloudTask = (input: {
  readonly previous: SymphonyCloudTask | null;
  readonly comment: { readonly id: string; readonly url: string | null } | null;
  readonly repository: CodexCloudRepositoryContext | null;
  readonly delegatedAt: string | null;
  readonly failedAt: string;
  readonly message: string;
}): SymphonyCloudTask => {
  const previous = input.previous ?? emptyCodexCloudTask();
  return {
    ...previous,
    status: "failed",
    taskUrl: previous.taskUrl ?? null,
    linearCommentId: input.comment?.id ?? previous.linearCommentId ?? null,
    linearCommentUrl: input.comment?.url ?? previous.linearCommentUrl ?? null,
    repository: input.repository?.nameWithOwner ?? previous.repository ?? null,
    repositoryUrl: input.repository?.httpsUrl ?? previous.repositoryUrl ?? null,
    lastMessage: input.message,
    delegatedAt: input.delegatedAt ?? previous.delegatedAt ?? null,
    lastCheckedAt: input.failedAt,
  };
};

function toSymphonyPullRequestSummary(
  pullRequest: GitHubPullRequestSummary,
  fallbackUpdatedAt: string,
): SymphonyPullRequestSummary {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    baseBranch: pullRequest.baseRefName,
    headBranch: pullRequest.headRefName,
    state: pullRequest.state ?? "open",
    updatedAt: pullRequest.updatedAt ?? fallbackUpdatedAt,
  };
}

const makeSymphonyService = Effect.gen(function* () {
  const repository = yield* SymphonyRepository;
  const secretStore = yield* ServerSecretStore;
  const serverConfig = yield* ServerConfig;
  const git = yield* GitCore;
  const github = yield* GitHubCli;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const events = yield* PubSub.unbounded<SymphonySubscribeEvent>();
  const schedulerInFlight = yield* Ref.make<ReadonlySet<string>>(new Set());
  const snapshotPublishedAtByProject = yield* Ref.make<ReadonlyMap<ProjectId, number>>(new Map());

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

  const resolveCodexCloudRepository = (
    projectRoot: string,
  ): Effect.Effect<CodexCloudRepositoryContext, SymphonyError> =>
    Effect.gen(function* () {
      const originUrl = yield* git
        .readConfigValue(projectRoot, "remote.origin.url")
        .pipe(Effect.mapError(toSymphonyError("Failed to read project Git remote.")));
      if (!originUrl) {
        return yield* new SymphonyError({
          message: "Codex Cloud requires a GitHub origin remote for this project.",
        });
      }
      const repository = parseGitHubRepositoryFromRemoteUrl(originUrl);
      if (!repository) {
        return yield* new SymphonyError({
          message: `Codex Cloud requires a GitHub repository remote. Found: ${originUrl}`,
        });
      }
      return repository;
    });

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

  const resolvePullRequestSummary = (input: {
    readonly run: SymphonyRun;
    readonly projectRoot: string;
  }): Effect.Effect<PullRequestLookupResult, never> => {
    const cwd =
      input.run.executionTarget === "codex-cloud"
        ? input.projectRoot
        : (input.run.workspacePath ?? input.projectRoot);
    const checkedAt = nowIso();
    const knownReference = input.run.pullRequest?.url ?? input.run.prUrl;
    if (knownReference) {
      return github
        .getPullRequest({
          cwd,
          reference: knownReference,
        })
        .pipe(
          Effect.map((pullRequest) => ({
            pullRequest: toSymphonyPullRequestSummary(pullRequest, checkedAt),
            warning: null,
          })),
          Effect.catch((cause) =>
            Effect.succeed({
              pullRequest: input.run.pullRequest ?? null,
              warning: `${SIGNAL_WARNING_PREFIX}${errorDetail(cause)}`,
            }),
          ),
        );
    }
    if (!input.run.branchName) {
      return Effect.succeed({ pullRequest: input.run.pullRequest ?? null, warning: null });
    }
    return github
      .listOpenPullRequests({
        cwd,
        headSelector: input.run.branchName,
        state: "all",
        limit: 20,
      })
      .pipe(
        Effect.map((pullRequests) => {
          const sortedPullRequests = pullRequests.toSorted((left, right) => {
            const leftUpdatedAt = left.updatedAt ? Date.parse(left.updatedAt) : 0;
            const rightUpdatedAt = right.updatedAt ? Date.parse(right.updatedAt) : 0;
            return rightUpdatedAt - leftUpdatedAt;
          });
          const preferred =
            sortedPullRequests.find((pullRequest) => pullRequest.state === "open") ??
            sortedPullRequests.find((pullRequest) => pullRequest.state === "merged") ??
            sortedPullRequests[0] ??
            null;
          return {
            pullRequest: preferred ? toSymphonyPullRequestSummary(preferred, checkedAt) : null,
            warning: null,
          };
        }),
        Effect.catch((cause) =>
          Effect.succeed({
            pullRequest: input.run.pullRequest ?? null,
            warning: `${SIGNAL_WARNING_PREFIX}${errorDetail(cause)}`,
          }),
        ),
      );
  };

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
      const logicalPath = resolveWorkflowPath(input.projectRoot, input.requestedPath);
      const [realProjectRoot, realWorkflowPath] = yield* Effect.all(
        [fs.realPath(input.projectRoot), fs.realPath(logicalPath)],
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
          message: `Workflow validated for Linear project ${workflow.config.tracker.projectSlug || "(unset)"}.`,
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
          trackerProjectSlug: workflow.config.tracker.projectSlug,
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
      return yield* Effect.try({
        try: () => parseWorkflowMarkdown(raw),
        catch: toSymphonyError("Failed to parse WORKFLOW.md."),
      });
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

  const transitionLinearRunState = (input: {
    readonly projectId: ProjectId;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly run: SymphonyRun;
    readonly stateName: string | null | undefined;
    readonly reason: string;
  }): Effect.Effect<void, never> => {
    const stateName = input.stateName?.trim();
    if (!stateName) return Effect.void;
    return Effect.gen(function* () {
      const apiKey = yield* readLinearApiKey(input.projectId);
      if (!apiKey) return;
      const issues = yield* fetchLinearIssuesByIds({
        endpoint: input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
        apiKey,
        issueIds: [input.run.issue.id],
      });
      const issue = issues.find((trackedIssue) => trackedIssue.issue.id === input.run.issue.id);
      if (!issue) {
        return;
      }
      const result = yield* updateLinearIssueState({
        endpoint: input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
        apiKey,
        issue,
        stateName,
      });
      if (result.changed) {
        yield* emitProjectEvent({
          projectId: input.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "linear.state-updated",
          message: `${input.run.issue.identifier} moved to ${result.stateName}`,
          payload: {
            stateId: result.stateId,
            stateName: result.stateName,
            reason: input.reason,
          },
        });
      }
    }).pipe(Effect.ignoreCause({ log: true }));
  };

  const reconcileRunSignals = (input: {
    readonly projectRoot: string;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly run: SymphonyRun;
    readonly linearIssue?: LinearIssueWorkflowContext | null;
    readonly thread?: OrchestrationThread | null;
    readonly reason: ReconcileReason;
  }): Effect.Effect<ReconciledRunResult, SymphonyError> =>
    Effect.gen(function* () {
      const reconciledAt = nowIso();
      const branchName =
        input.run.branchName ??
        (input.run.executionTarget === "codex-cloud"
          ? (input.run.issue.branchName ?? branchNameForIssue(input.run.issue.identifier))
          : null);
      const runWithBranch: SymphonyRun =
        branchName === input.run.branchName ? input.run : { ...input.run, branchName };
      const pullRequestLookup = yield* resolvePullRequestSummary({
        run: runWithBranch,
        projectRoot: input.projectRoot,
      });
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
        pullRequest: pullRequestLookup.pullRequest,
        thread: input.thread ?? null,
        now: reconciledAt,
      });
      const nextPrUrl = lifecycle.pullRequest?.url ?? runWithBranch.prUrl;
      const warning = pullRequestLookup.warning;
      const nextCurrentStep =
        warning && lifecycle.pullRequest === null
          ? {
              ...lifecycle.currentStep,
              detail: warning,
              updatedAt: reconciledAt,
            }
          : lifecycle.currentStep;
      const nextArchivedAt =
        lifecycle.status === "completed"
          ? (runWithBranch.archivedAt ?? reconciledAt)
          : runWithBranch.archivedAt;
      const previousWarning = warningFromLastError(input.run.lastError);
      const nextLastError =
        warning ??
        (lifecycle.status === "failed"
          ? runWithBranch.lastError
          : previousWarning !== null
            ? null
            : runWithBranch.lastError);
      const nextRun: SymphonyRun = {
        ...runWithBranch,
        issue: input.linearIssue?.issue ?? runWithBranch.issue,
        status: lifecycle.status,
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
      const warningChanged = previousWarning !== warning;
      const changed =
        statusChanged ||
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
        yield* emitProjectEvent({
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

      if (warningChanged && warning) {
        yield* emitProjectEvent({
          projectId: input.run.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "run.signal-warning",
          message: warning,
          payload: {
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
        warningChanged,
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
      if (!workflow.config.tracker.projectSlug) {
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
          (run.status === "running" ||
            run.status === "cloud-submitted" ||
            run.status === "cloud-running" ||
            run.status === "review-ready" ||
            run.status === "eligible" ||
            run.status === "retry-queued" ||
            run.status === "target-pending"),
      );
      const trackedLinearIssues = yield* fetchTrackedLinearIssues({
        projectId,
        workflow,
        issueIds: trackedRuns.map((run) => run.issue.id),
      });
      const trackedLinearIssueById = new Map(
        trackedLinearIssues.map((issue) => [issue.issue.id, issue] as const),
      );
      yield* Effect.forEach(
        issues,
        (issue) =>
          repository.getRunByIssue({ projectId, issueId: issue.id }).pipe(
            Effect.mapError(toSymphonyError("Failed to read Symphony run.")),
            Effect.flatMap((existing) =>
              repository
                .upsertRun({
                  ...(existing ?? makeRun(projectId, issue, fetchedAt)),
                  issue,
                  updatedAt: fetchedAt,
                })
                .pipe(Effect.mapError(toSymphonyError("Failed to upsert Symphony run."))),
            ),
          ),
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
            (run.status === "running" ||
              run.status === "cloud-submitted" ||
              run.status === "cloud-running" ||
              run.status === "review-ready"),
        ),
        (run) =>
          reconcileRunSignals({
            projectRoot: project.workspaceRoot,
            workflow,
            run,
            linearIssue: trackedLinearIssueById.get(run.issue.id) ?? null,
            thread: run.threadId ? (threadById.get(run.threadId) ?? null) : null,
            reason: "candidate-refresh",
          }),
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
          const trackedIssue = trackedLinearIssueById.get(run.issue.id);
          const lifecycle = trackedIssue
            ? resolveRunLifecycle({
                run,
                config: workflow.config,
                linear: {
                  stateName: trackedIssue.state.name,
                  updatedAt: trackedIssue.issue.updatedAt,
                },
              })
            : null;
          if (
            lifecycle?.status === "review-ready" ||
            lifecycle?.status === "completed" ||
            lifecycle?.status === "canceled"
          ) {
            return false;
          }
          return (
            run.status === "eligible" ||
            run.status === "target-pending" ||
            run.status === "retry-queued" ||
            run.status === "running" ||
            run.status === "cloud-submitted" ||
            run.status === "cloud-running"
          );
        }),
        (run) => {
          const releasedAt = nowIso();
          const activeRun =
            run.status === "running" ||
            run.status === "cloud-submitted" ||
            run.status === "cloud-running";
          const nextStatus = activeRun ? "canceled" : "released";
          const nextRun: SymphonyRun = {
            ...run,
            status: nextStatus,
            attempts:
              run.status === "running"
                ? replaceLatestAttempt(run, {
                    status: "canceled-by-reconciliation",
                    completedAt: releasedAt,
                    error: "Linear issue is no longer eligible for Symphony.",
                  })
                : run.attempts,
            nextRetryAt: null,
            lastError: activeRun
              ? "Linear issue is no longer eligible for Symphony."
              : run.lastError,
            updatedAt: releasedAt,
          };
          return repository.upsertRun(nextRun).pipe(
            Effect.mapError(toSymphonyError("Failed to reconcile ineligible Symphony run.")),
            Effect.flatMap(() =>
              run.status === "running" && run.threadId
                ? orchestrationEngine
                    .dispatch({
                      type: "thread.session.stop",
                      commandId: commandId("reconcile-stop"),
                      threadId: run.threadId,
                      createdAt: releasedAt,
                    })
                    .pipe(Effect.ignoreCause({ log: true }))
                : Effect.void,
            ),
            Effect.flatMap(() =>
              emitProjectEvent({
                projectId,
                issueId: run.issue.id,
                runId: run.runId,
                type: activeRun ? "run.canceled-by-linear" : "run.released",
                message: activeRun
                  ? `${run.issue.identifier} canceled because Linear is no longer eligible`
                  : `${run.issue.identifier} released because Linear is no longer eligible`,
                payload: { previousStatus: run.status, nextStatus },
              }),
            ),
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
      yield* emitProjectEvent({
        projectId,
        type: "linear.refreshed",
        message: `Fetched ${issues.length} Linear issues`,
        payload: { count: issues.length },
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
        executionTarget: "local",
        cloudTask: null,
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

      if (!input.run.threadId) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: commandId("thread-create"),
            threadId: runThreadId,
            projectId: input.projectId,
            title: `Symphony ${input.run.issue.identifier}: ${input.run.issue.title}`,
            modelSelection: defaultSymphonyLocalModelSelection(),
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: branchName,
            worktreePath: workspacePath,
            createdAt: launchedAt,
          })
          .pipe(Effect.mapError(toSymphonyError("Failed to create Symphony thread.")));
      }

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
            executionTarget: "local",
            cloudTask: null,
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

  const launchCodexCloudRun = (input: {
    readonly projectId: ProjectId;
    readonly projectRoot: string;
    readonly workflowPath: string;
    readonly workflow: {
      readonly config: SymphonyWorkflowConfig;
      readonly promptTemplate: string;
    };
    readonly run: SymphonyRun;
  }): Effect.Effect<void, SymphonyError> => {
    let delegatedAt: string | null = null;
    let repositoryContext: CodexCloudRepositoryContext | null = null;
    let createdComment: { readonly id: string; readonly url: string | null } | null = null;

    return Effect.gen(function* () {
      const apiKey = yield* readLinearApiKey(input.projectId);
      if (!apiKey) {
        return yield* new SymphonyError({
          message: "Linear API key is required to send a run to Codex Cloud.",
        });
      }

      delegatedAt = nowIso();
      repositoryContext = yield* resolveCodexCloudRepository(input.projectRoot);
      const branchName = input.run.branchName ?? branchNameForIssue(input.run.issue.identifier);
      const body = buildCodexCloudDelegationComment({
        issue: input.run.issue,
        repository: repositoryContext,
        branchName,
        workflowPath: input.workflowPath,
        requestedModel: "GPT-5.5",
        requestedReasoning: "high",
      });
      createdComment = yield* createLinearComment({
        endpoint: input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
        apiKey,
        issueId: input.run.issue.id,
        body,
      });

      const nextRun: SymphonyRun = {
        ...input.run,
        status: "cloud-submitted",
        workspacePath: null,
        branchName,
        threadId: null,
        executionTarget: "codex-cloud",
        cloudTask: submittedCodexCloudTask({
          comment: createdComment,
          repository: repositoryContext,
          delegatedAt,
        }),
        nextRetryAt: null,
        lastError: null,
        updatedAt: delegatedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to mark Symphony run as cloud-submitted.")));
      yield* transitionLinearRunState({
        projectId: input.projectId,
        workflow: input.workflow,
        run: nextRun,
        stateName: input.workflow.config.tracker.transitionStates.started,
        reason: "started",
      });
      yield* emitProjectEvent({
        projectId: input.projectId,
        issueId: input.run.issue.id,
        runId: input.run.runId,
        type: "cloud.submitted",
        message: `Submitted ${input.run.issue.identifier} to Codex Cloud`,
        payload: {
          linearCommentId: createdComment.id,
          commentUrl: createdComment.url,
        },
      }).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catch((error: SymphonyError) => {
        const failedAt = nowIso();
        return repository
          .upsertRun({
            ...input.run,
            status: "failed",
            workspacePath: null,
            threadId: null,
            executionTarget: "codex-cloud",
            cloudTask: failedCodexCloudTask({
              previous: input.run.cloudTask,
              comment: createdComment,
              repository: repositoryContext,
              delegatedAt,
              failedAt,
              message: error.message,
            }),
            nextRetryAt: null,
            lastError: error.message,
            updatedAt: failedAt,
          })
          .pipe(
            Effect.mapError(toSymphonyError("Failed to mark Symphony cloud run as failed.")),
            Effect.flatMap(() =>
              emitProjectEvent({
                projectId: input.projectId,
                issueId: input.run.issue.id,
                runId: input.run.runId,
                type: "cloud.failed",
                message: `Failed to submit ${input.run.issue.identifier} to Codex Cloud`,
                payload: { error: error.message },
              }),
            ),
          );
      }),
    );
  };

  const readLaunchContext = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const project = yield* readProject(projectId);
      const settings = yield* loadSettings(projectId);
      const workflow = yield* loadValidatedWorkflow(projectId);
      const workflowPath = resolveWorkflowPath(project.workspaceRoot, settings.workflowPath);
      return { project, settings, workflow, workflowPath };
    });

  const launchIssueRun = (input: {
    readonly projectId: ProjectId;
    readonly issueId: SymphonyIssueId;
    readonly target: SymphonyExecutionTarget;
  }): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const run = yield* repository
        .getRunByIssue({ projectId: input.projectId, issueId: input.issueId })
        .pipe(Effect.mapError(toSymphonyError("Failed to read Symphony run.")));
      if (!run) {
        return yield* new SymphonyError({ message: "Symphony issue was not found." });
      }
      if (
        run.status === "running" ||
        run.status === "cloud-submitted" ||
        run.status === "cloud-running" ||
        run.status === "review-ready"
      ) {
        return yield* new SymphonyError({ message: `${run.issue.identifier} is already running.` });
      }

      const { project, workflow, workflowPath } = yield* readLaunchContext(input.projectId);
      const launchableRun: SymphonyRun = {
        ...run,
        status: input.target === "local" ? "eligible" : "target-pending",
        executionTarget: input.target,
        cloudTask: input.target === "local" ? null : run.cloudTask,
        archivedAt: null,
        nextRetryAt: null,
        lastError: null,
        updatedAt: nowIso(),
      };

      if (input.target === "local") {
        yield* launchLocalRun({
          projectId: input.projectId,
          projectRoot: project.workspaceRoot,
          workflow,
          workflowPath,
          run: launchableRun,
        });
        return;
      }

      yield* launchCodexCloudRun({
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
      const workflowPath = resolveWorkflowPath(project.workspaceRoot, settings.workflowPath);
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
        .filter(
          (run) =>
            run.archivedAt === null &&
            run.executionTarget === "local" &&
            (run.status === "eligible" || run.status === "retry-queued"),
        )
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
          launchLocalRun({
            projectId,
            projectRoot: project.workspaceRoot,
            workflow,
            workflowPath,
            run,
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
      const workflowPath = resolveWorkflowPath(project.workspaceRoot, settings.workflowPath);
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

  const refreshCloudRunStatus = (input: {
    readonly projectId: ProjectId;
    readonly run: SymphonyRun;
  }): Effect.Effect<SymphonyRun, SymphonyError> =>
    Effect.gen(function* () {
      if (input.run.executionTarget !== "codex-cloud") {
        return input.run;
      }
      const apiKey = yield* readLinearApiKey(input.projectId);
      if (!apiKey) {
        return yield* new SymphonyError({
          message: "Linear API key is required to refresh Codex Cloud status.",
        });
      }
      const workflow = yield* loadValidatedWorkflow(input.projectId);
      const checkedAt = nowIso();
      const detected = yield* detectLinearCodexTask({
        endpoint: workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
        apiKey,
        issueId: input.run.issue.id,
        delegatedAfter: input.run.cloudTask?.delegatedAt ?? null,
      });
      const currentTask = input.run.cloudTask ?? emptyCodexCloudTask();
      const taskDetected = detected.status === "detected";
      const detectedFailureMessage = detected.status === "failed" ? detected.message : null;
      const nextLastError = taskDetected
        ? null
        : detectedFailureMessage !== null
          ? detectedFailureMessage
          : input.run.lastError;
      const nextLastMessage = taskDetected
        ? null
        : detectedFailureMessage !== null
          ? detectedFailureMessage
          : (currentTask.lastMessage ?? null);
      const shouldEmitFailed =
        detectedFailureMessage !== null &&
        (currentTask.status !== "failed" || currentTask.lastMessage !== detectedFailureMessage);
      const nextRun: SymphonyRun = {
        ...input.run,
        lastError: nextLastError,
        cloudTask: {
          ...currentTask,
          status: detected.status === "unknown" ? currentTask.status : detected.status,
          taskUrl: detected.taskUrl ?? currentTask.taskUrl,
          linearCommentId: currentTask.linearCommentId ?? detected.linearCommentId,
          lastMessage: nextLastMessage,
          lastCheckedAt: checkedAt,
        },
        updatedAt: checkedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to update Codex Cloud task status.")));
      if (detected.taskUrl && detected.taskUrl !== input.run.cloudTask?.taskUrl) {
        yield* emitProjectEvent({
          projectId: input.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "cloud.detected",
          message: `Detected Codex Cloud task for ${input.run.issue.identifier}`,
          payload: {
            taskUrl: detected.taskUrl,
            linearCommentId: detected.linearCommentId,
          },
        });
      }
      if (shouldEmitFailed) {
        yield* emitProjectEvent({
          projectId: input.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "cloud.failed",
          message: `Codex Cloud reported a failure for ${input.run.issue.identifier}`,
          payload: { error: detected.message },
        });
      }
      return nextRun;
    });

  const reconcileRunWithThread = (input: {
    readonly projectRoot: string;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
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
        const reconciled = yield* reconcileRunSignals({
          projectRoot: input.projectRoot,
          workflow: input.workflow,
          run: attemptedRun,
          linearIssue: input.linearIssue ?? null,
          thread,
          reason: input.reason,
        });
        const nextRun = reconciled.run;
        if (!attemptAlreadySucceeded) {
          yield* runAfterRunHook({ projectId: run.projectId, run: nextRun });
        }
        if (!attemptAlreadySucceeded && nextRun.status === "running") {
          yield* emitProjectEvent({
            projectId: run.projectId,
            issueId: run.issue.id,
            runId: run.runId,
            type: "run.awaiting-review-signal",
            message: `${run.issue.identifier} finished its local turn and is waiting for a PR or Linear review state`,
            payload: { threadId: run.threadId },
          });
        }
        return;
      }

      if (latestTurn.state === "interrupted") {
        const attemptedRun: SymphonyRun = {
          ...run,
          attempts: replaceLatestAttempt(run, {
            status: "canceled-by-reconciliation",
            completedAt,
            error: "Codex turn was interrupted.",
          }),
          nextRetryAt: null,
          lastError: "Codex turn was interrupted.",
          updatedAt: completedAt,
        };
        yield* repository
          .upsertRun(attemptedRun)
          .pipe(Effect.mapError(toSymphonyError("Failed to update interrupted Symphony attempt.")));
        const reconciled = yield* reconcileRunSignals({
          projectRoot: input.projectRoot,
          workflow: input.workflow,
          run: attemptedRun,
          linearIssue: input.linearIssue ?? null,
          thread,
          reason: input.reason,
        });
        yield* runAfterRunHook({ projectId: run.projectId, run: reconciled.run });
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
              emitProjectEvent({
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
            const refreshedRun =
              run.executionTarget === "codex-cloud" &&
              (run.status === "cloud-submitted" || run.status === "cloud-running")
                ? yield* refreshCloudRunStatus({ projectId, run })
                : run;
            const thread = refreshedRun.threadId
              ? (threadById.get(refreshedRun.threadId) ?? null)
              : null;
            const linearIssue = trackedLinearIssueById.get(refreshedRun.issue.id) ?? null;

            if (refreshedRun.executionTarget === "codex-cloud") {
              yield* reconcileRunSignals({
                projectRoot: project.workspaceRoot,
                workflow,
                run: refreshedRun,
                linearIssue,
                thread,
                reason: "scheduler",
              });
              return;
            }

            yield* reconcileRunWithThread({
              projectRoot: project.workspaceRoot,
              workflow,
              run: refreshedRun,
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
      if (shouldPoll(runtimeState.lastPollAt, workflow.config.polling.intervalMs)) {
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
        statuses: MONITORED_RUN_STATUSES,
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

  const updateExecutionDefault: SymphonyServiceShape["updateExecutionDefault"] = ({
    projectId,
    target,
  }) =>
    Effect.gen(function* () {
      const current = yield* loadSettings(projectId);
      const next = yield* saveSettings({
        ...current,
        executionDefaultTarget: target,
        updatedAt: nowIso(),
      });
      yield* emitProjectEvent({
        projectId,
        type: "execution-default.updated",
        message: `Symphony default target set to ${target === "local" ? "Local" : "Codex Cloud"}`,
        payload: { target },
      });
      return next;
    });

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

  const launchIssue: SymphonyServiceShape["launchIssue"] = ({ projectId, issueId, target }) =>
    launchIssueRun({ projectId, issueId, target }).pipe(
      Effect.flatMap(() => buildSnapshot(projectId)),
    );

  const refreshCloudStatus: SymphonyServiceShape["refreshCloudStatus"] = ({ projectId, issueId }) =>
    Effect.gen(function* () {
      const run = yield* repository
        .getRunByIssue({ projectId, issueId })
        .pipe(Effect.mapError(toSymphonyError("Failed to read Symphony run.")));
      if (run) {
        const refreshedRun = yield* refreshCloudRunStatus({ projectId, run });
        const project = yield* readProject(projectId);
        const workflow = yield* loadValidatedWorkflow(projectId);
        yield* reconcileRunSignals({
          projectRoot: project.workspaceRoot,
          workflow,
          run: refreshedRun,
          reason: "cloud-refresh",
        });
      }
      return yield* buildSnapshot(projectId);
    });

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
                executionTarget: null,
                cloudTask: null,
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
    updateExecutionDefault,
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
    refreshCloudStatus,
    openLinkedThread,
  } satisfies SymphonyServiceShape;
});

export const SymphonyServiceLive = Layer.effect(SymphonyService, makeSymphonyService);
