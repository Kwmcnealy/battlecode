import {
  OrchestrationEvent,
  ProjectId,
  SymphonyError,
  SymphonyEvent,
  SymphonyIssueId,
  SymphonyRun,
  ThreadId,
  type SymphonyExecutionTarget,
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
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
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
  createLinearComment,
  detectLinearCodexTask,
  fetchLinearCandidates,
  testLinearConnection as testLinearApiKey,
} from "../linear.ts";
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

function nowIso(): string {
  return new Date().toISOString();
}

function toSymphonyError(message: string) {
  return (cause: unknown): SymphonyError =>
    Schema.is(SymphonyError)(cause) ? cause : new SymphonyError({ message, cause });
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

  const resolvePullRequestUrl = (run: SymphonyRun): Effect.Effect<string | null, never> => {
    if (!run.workspacePath || !run.branchName) {
      return Effect.succeed(null);
    }
    return github
      .listOpenPullRequests({
        cwd: run.workspacePath,
        headSelector: run.branchName,
        limit: 1,
      })
      .pipe(
        Effect.map((pullRequests) => pullRequests[0]?.url ?? null),
        Effect.catch(() => Effect.succeed(null)),
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
      const queues = queueRuns(runs);
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
      const existingRuns = yield* repository
        .listRuns(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load existing Symphony runs.")));
      yield* Effect.forEach(
        existingRuns.filter(
          (run) =>
            !fetchedIssueIds.has(run.issue.id) &&
            (run.status === "eligible" ||
              run.status === "target-pending" ||
              run.status === "retry-queued" ||
              run.status === "running" ||
              run.status === "cloud-submitted"),
        ),
        (run) => {
          const releasedAt = nowIso();
          const activeRun = run.status === "running" || run.status === "cloud-submitted";
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

  const buildCloudDelegationComment = (input: {
    readonly projectRoot: string;
    readonly workflowPath: string;
    readonly run: SymphonyRun;
  }): string =>
    [
      "@Codex please implement this Linear issue using the repository workflow.",
      "",
      `Issue: ${input.run.issue.identifier} - ${input.run.issue.title}`,
      input.run.issue.description ? `Description:\n${input.run.issue.description}` : null,
      "",
      "Requested runtime:",
      "- Model: GPT-5.5",
      "- Reasoning: high",
      "- Execution target: Codex Cloud",
      "",
      "Repository context:",
      `- Project root: ${input.projectRoot}`,
      `- Workflow file: ${input.workflowPath}`,
      `- Suggested branch: ${input.run.branchName ?? branchNameForIssue(input.run.issue.identifier)}`,
      "",
      "Follow WORKFLOW.md, validate the change, push the branch, and open or update a pull request when ready.",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

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
  }): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const apiKey = yield* readLinearApiKey(input.projectId);
      if (!apiKey) {
        return yield* new SymphonyError({
          message: "Linear API key is required to send a run to Codex Cloud.",
        });
      }

      const delegatedAt = nowIso();
      const comment = yield* createLinearComment({
        endpoint: input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
        apiKey,
        issueId: input.run.issue.id,
        body: buildCloudDelegationComment({
          projectRoot: input.projectRoot,
          workflowPath: input.workflowPath,
          run: input.run,
        }),
      });

      const nextRun: SymphonyRun = {
        ...input.run,
        status: "cloud-submitted",
        workspacePath: null,
        threadId: null,
        executionTarget: "codex-cloud",
        cloudTask: {
          provider: "codex-cloud-linear",
          status: "submitted",
          taskUrl: null,
          linearCommentId: comment.id,
          delegatedAt,
          lastCheckedAt: delegatedAt,
        },
        nextRetryAt: null,
        lastError: null,
        updatedAt: delegatedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to mark Symphony run as cloud-submitted.")));
      yield* emitProjectEvent({
        projectId: input.projectId,
        issueId: input.run.issue.id,
        runId: input.run.runId,
        type: "cloud.submitted",
        message: `Submitted ${input.run.issue.identifier} to Codex Cloud`,
        payload: {
          linearCommentId: comment.id,
          commentUrl: comment.url,
        },
      });
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
            cloudTask: {
              provider: "codex-cloud-linear",
              status: "failed",
              taskUrl: input.run.cloudTask?.taskUrl ?? null,
              linearCommentId: input.run.cloudTask?.linearCommentId ?? null,
              delegatedAt: input.run.cloudTask?.delegatedAt ?? null,
              lastCheckedAt: failedAt,
            },
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
      if (run.status === "running" || run.status === "cloud-submitted") {
        return yield* new SymphonyError({ message: `${run.issue.identifier} is already running.` });
      }

      const { project, workflow, workflowPath } = yield* readLaunchContext(input.projectId);
      const launchableRun: SymphonyRun = {
        ...run,
        status: input.target === "local" ? "eligible" : "target-pending",
        executionTarget: input.target,
        cloudTask: input.target === "local" ? null : run.cloudTask,
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
      const runningCount = runs.filter((run) => run.status === "running").length;
      const capacity = Math.max(0, workflow.config.agent.maxConcurrentAgents - runningCount);
      if (capacity === 0) return;

      const candidates = runs
        .filter(
          (run) =>
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
      });
      const currentTask = input.run.cloudTask ?? {
        provider: "codex-cloud-linear" as const,
        status: "unknown" as const,
        taskUrl: null,
        linearCommentId: null,
        delegatedAt: null,
        lastCheckedAt: null,
      };
      const nextRun: SymphonyRun = {
        ...input.run,
        cloudTask: {
          ...currentTask,
          status: detected.taskUrl ? "detected" : currentTask.status,
          taskUrl: detected.taskUrl ?? currentTask.taskUrl,
          linearCommentId: currentTask.linearCommentId ?? detected.linearCommentId,
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
      return nextRun;
    });

  const reconcileRunWithThread = (run: SymphonyRun): Effect.Effect<void, SymphonyError> => {
    if (run.status !== "running" || !run.threadId) return Effect.void;

    return Effect.gen(function* () {
      const thread = yield* readThread(run.threadId!);
      const latestTurn = thread?.latestTurn ?? null;
      if (!latestTurn) return;

      if (latestTurn.state === "running") {
        const attempts = replaceLatestAttempt(run, { status: "streaming-turn" });
        if (attempts === run.attempts) return;
        yield* repository
          .upsertRun({
            ...run,
            attempts,
            updatedAt: nowIso(),
          })
          .pipe(Effect.mapError(toSymphonyError("Failed to update Symphony run attempt.")));
        return;
      }

      const completedAt = latestTurn.completedAt ?? nowIso();
      if (latestTurn.state === "completed") {
        const prUrl = run.prUrl ?? (yield* resolvePullRequestUrl(run));
        const nextRun: SymphonyRun = {
          ...run,
          status: "completed",
          prUrl,
          attempts: replaceLatestAttempt(run, {
            status: "succeeded",
            completedAt,
            error: null,
          }),
          nextRetryAt: null,
          lastError: null,
          updatedAt: completedAt,
        };
        yield* repository
          .upsertRun(nextRun)
          .pipe(Effect.mapError(toSymphonyError("Failed to complete Symphony run.")));
        yield* runAfterRunHook({ projectId: run.projectId, run: nextRun });
        if (prUrl && prUrl !== run.prUrl) {
          yield* emitProjectEvent({
            projectId: run.projectId,
            issueId: run.issue.id,
            runId: run.runId,
            type: "run.pr-detected",
            message: `Detected pull request for ${run.issue.identifier}`,
            payload: { prUrl },
          });
        }
        yield* emitProjectEvent({
          projectId: run.projectId,
          issueId: run.issue.id,
          runId: run.runId,
          type: "run.completed",
          message: `${run.issue.identifier} completed`,
          payload: { threadId: run.threadId, prUrl },
        });
        return;
      }

      if (latestTurn.state === "interrupted") {
        const nextRun: SymphonyRun = {
          ...run,
          status: "canceled",
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
          .upsertRun(nextRun)
          .pipe(Effect.mapError(toSymphonyError("Failed to cancel Symphony run.")));
        yield* runAfterRunHook({ projectId: run.projectId, run: nextRun });
        yield* emitProjectEvent({
          projectId: run.projectId,
          issueId: run.issue.id,
          runId: run.runId,
          type: "run.canceled",
          message: `${run.issue.identifier} canceled`,
          payload: { threadId: run.threadId },
        });
        return;
      }

      const workflow = yield* loadValidatedWorkflow(run.projectId).pipe(
        Effect.catchTag("SymphonyError", () =>
          Effect.succeed({
            config: {
              agent: {
                maxTurns: 1,
                maxRetryBackoffMs: 300_000,
              },
            },
          } as {
            readonly config: Pick<SymphonyWorkflowConfig, "agent">;
          }),
        ),
      );
      const attemptNumber = Math.max(1, run.attempts.at(-1)?.attempt ?? run.attempts.length);
      const canRetry = attemptNumber < workflow.config.agent.maxTurns;
      const errorMessage = thread?.session?.lastError ?? "Codex turn failed.";
      const nextRun: SymphonyRun = {
        ...run,
        status: canRetry ? "retry-queued" : "failed",
        attempts: replaceLatestAttempt(run, {
          status: "failed",
          completedAt,
          error: errorMessage,
        }),
        nextRetryAt: canRetry
          ? retryAfterIso(attemptNumber, workflow.config.agent.maxRetryBackoffMs)
          : null,
        lastError: errorMessage,
        updatedAt: completedAt,
      };
      yield* repository
        .upsertRun(nextRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to reconcile failed Symphony run.")));
      yield* runAfterRunHook({ projectId: run.projectId, run: nextRun });
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
  };

  const reconcileProjectRuns = (projectId: ProjectId): Effect.Effect<void, SymphonyError> =>
    repository.listRuns(projectId).pipe(
      Effect.mapError(toSymphonyError("Failed to load Symphony runs for reconciliation.")),
      Effect.flatMap((runs) =>
        Effect.forEach(
          runs.filter((run) => run.status === "running" && run.threadId !== null),
          reconcileRunWithThread,
          { concurrency: 4 },
        ),
      ),
      Effect.asVoid,
    );

  const handleOrchestrationEvent = (event: OrchestrationEvent): Effect.Effect<void, never> => {
    if (event.aggregateKind !== "thread" || !isSymphonyThreadId(event.aggregateId)) {
      return Effect.void;
    }
    const threadId = ThreadId.make(event.aggregateId);
    return repository.getRunByThreadId(threadId).pipe(
      Effect.mapError(toSymphonyError("Failed to find Symphony run for thread event.")),
      Effect.flatMap((run) => (run ? reconcileRunWithThread(run) : Effect.void)),
      Effect.ignoreCause({ log: true }),
    );
  };

  const runSchedulerTick = (projectId: ProjectId): Effect.Effect<void, SymphonyError> =>
    Effect.gen(function* () {
      const runtimeState = yield* repository
        .getRuntimeState(projectId)
        .pipe(Effect.mapError(toSymphonyError("Failed to load Symphony runtime state.")));
      if (runtimeState?.status !== "running") return;

      yield* reconcileProjectRuns(projectId);

      const settings = yield* loadSettings(projectId);
      if (settings.workflowStatus.status !== "valid" || !settings.linearSecret.configured) {
        return;
      }
      const workflow = yield* loadValidatedWorkflow(projectId);
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

  const tickRunningProjects = repository.listRuntimeStates().pipe(
    Effect.mapError(toSymphonyError("Failed to list Symphony runtime states.")),
    Effect.flatMap((states) =>
      Effect.forEach(
        states.filter((state) => state.status === "running"),
        (state) => runExclusiveSchedulerTick(state.projectId),
        { concurrency: 2 },
      ),
    ),
    Effect.ignoreCause({ log: true }),
  );

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

  const refresh: SymphonyServiceShape["refresh"] = ({ projectId }) => refreshCandidates(projectId);

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
        yield* refreshCloudRunStatus({ projectId, run });
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
        yield* repository
          .upsertRun({
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
          })
          .pipe(Effect.mapError(toSymphonyError("Failed to stop Symphony issue.")));
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
