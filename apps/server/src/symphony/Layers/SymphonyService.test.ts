import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  SymphonyError,
  SymphonyIssueId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type SymphonyApplyConfigurationInput,
  type SymphonyEvent,
  type SymphonyIssue,
  type SymphonyLinearProject,
  type SymphonyLinearWorkflowState,
  type SymphonyRun,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { beforeEach, expect, vi } from "vitest";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { runProcess } from "../../processRunner.ts";
import { SymphonyRepository } from "../Services/SymphonyRepository.ts";
import { SymphonyService } from "../Services/SymphonyService.ts";
import { LINEAR_INELIGIBLE_LEGACY_ERROR } from "../lifecyclePolicy.ts";
import { makeRun } from "../runModel.ts";
import { SymphonyRepositoryLive } from "./SymphonyRepository.ts";
import { SymphonyServiceLive } from "./SymphonyService.ts";

const linearMocks = vi.hoisted(() => ({
  createLinearComment: vi.fn(),
  detectLinearCodexTask: vi.fn(),
  fetchLinearCandidates: vi.fn(),
  fetchLinearIssueComments: vi.fn(),
  fetchLinearIssuesByIds: vi.fn(),
  fetchLinearTeamsAndProjects: vi.fn(),
  fetchLinearWorkflowStates: vi.fn(),
  testLinearConnection: vi.fn(),
  updateLinearComment: vi.fn(),
  updateLinearIssueState: vi.fn(),
}));

vi.mock("../linear.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../linear.ts")>();
  return {
    ...actual,
    createLinearComment: linearMocks.createLinearComment,
    detectLinearCodexTask: linearMocks.detectLinearCodexTask,
    fetchLinearCandidates: linearMocks.fetchLinearCandidates,
    fetchLinearIssueComments: linearMocks.fetchLinearIssueComments,
    fetchLinearIssuesByIds: linearMocks.fetchLinearIssuesByIds,
    fetchLinearTeamsAndProjects: linearMocks.fetchLinearTeamsAndProjects,
    fetchLinearWorkflowStates: linearMocks.fetchLinearWorkflowStates,
    testLinearConnection: linearMocks.testLinearConnection,
    updateLinearComment: linearMocks.updateLinearComment,
    updateLinearIssueState: linearMocks.updateLinearIssueState,
  };
});

const CREATED_AT = "2026-05-02T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-symphony-service");
const ISSUE_ID = SymphonyIssueId.make("issue-bc-1");
const textEncoder = new TextEncoder();

function countLinearLookupWarnings(events: readonly SymphonyEvent[]): number {
  return events.filter(
    (event) =>
      event.type === "run.signal-warning" &&
      event.message.startsWith("Linear issue lookup failed:"),
  ).length;
}

const WORKFLOW_MD = `---
tracker:
  kind: linear
  project_slug_id: battlecode
  intake_states:
    - To Do
    - Todo
  active_states:
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Canceled
  review_states:
    - Human Review
  done_states:
    - Done
  canceled_states:
    - Canceled
  transition_states:
    started: In Progress
    review: Human Review
    done: Done
    canceled: Canceled
pull_request:
  base_branch: development
quality:
  max_review_fix_loops: 1
  simplification_prompt: Run the code simplifier.
  review_prompt: Run the code review pass.
polling:
  interval_ms: 30000
agent:
  max_concurrent_agents: 3
---

Run {{ issue.identifier }}.
`;

const gitManagerMocks = {
  runStackedAction: vi.fn(),
};

function makeReadModel(
  projectRoot: string,
  overrides: Partial<OrchestrationReadModel> = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: CREATED_AT,
    projects: [
      {
        id: PROJECT_ID,
        title: "Symphony Project",
        workspaceRoot: projectRoot,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        deletedAt: null,
      },
    ],
    threads: [],
    providerSessions: [],
    providerStatuses: [],
    pendingApprovals: [],
    latestTurnByThreadId: {},
    ...overrides,
  } as unknown as OrchestrationReadModel;
}

function makeIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
  return {
    id: ISSUE_ID,
    identifier: "BC-1",
    title: "Fix cloud lifecycle",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: null,
    url: "https://linear.app/t3/issue/BC-1",
    labels: [],
    blockedBy: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("symphony-thread-project-symphony-service-issue-bc-1"),
    projectId: PROJECT_ID,
    title: "Symphony BC-1",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.5",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "symphony/bc-1",
    worktreePath: "/tmp/symphony/bc-1",
    latestTurn: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeServiceRun(overrides: Partial<SymphonyRun> = {}): SymphonyRun {
  return {
    ...makeRun(PROJECT_ID, makeIssue(), CREATED_AT),
    ...overrides,
    issue: {
      ...makeIssue(),
      ...overrides.issue,
    },
    updatedAt: overrides.updatedAt ?? CREATED_AT,
  };
}

function makeLinearContext(stateName: string, issueOverrides: Partial<SymphonyIssue> = {}) {
  const issue = makeIssue({ state: stateName, ...issueOverrides });
  return {
    issue,
    team: {
      id: "team-1",
      name: "Battlecode",
      key: "BC",
    },
    state: {
      id: `state-${stateName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: stateName,
    },
  };
}

const insertProjectionProject = (projectRoot: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT OR REPLACE INTO projection_projects (
        project_id,
        title,
        workspace_root,
        default_model_selection_json,
        scripts_json,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${PROJECT_ID},
        'Symphony Project',
        ${projectRoot},
        '{"provider":"codex","model":"gpt-5-codex"}',
        '[]',
        ${CREATED_AT},
        ${CREATED_AT},
        NULL
      )
    `;
  });

const configureWorkflowSettings = Effect.gen(function* () {
  const repository = yield* SymphonyRepository;
  yield* repository.upsertSettings({
    projectId: PROJECT_ID,
    workflowPath: "WORKFLOW.md",
    workflowStatus: {
      status: "valid",
      message: "Workflow validated for tests.",
      validatedAt: CREATED_AT,
      configHash: "test-workflow-hash",
    },
    linearSecret: {
      source: "stored",
      configured: true,
      lastTestedAt: null,
      lastError: null,
    },
    updatedAt: CREATED_AT,
  });
});

const writeWorkflow = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-symphony-service-" });
  yield* fs.writeFileString(path.join(projectRoot, "WORKFLOW.md"), WORKFLOW_MD);
  return projectRoot;
});

const runGit = (cwd: string, args: readonly string[]) =>
  Effect.tryPromise({
    try: () => runProcess("git", [...args], { cwd, timeoutMs: 10_000 }),
    catch: (cause) => new SymphonyError({ message: `git ${args.join(" ")} failed`, cause }),
  }).pipe(Effect.asVoid);

const initializeGitRepository = (projectRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* runGit(projectRoot, ["init"]);
    yield* runGit(projectRoot, ["config", "user.email", "symphony@example.com"]);
    yield* runGit(projectRoot, ["config", "user.name", "Symphony Test"]);
    yield* fs.writeFileString(path.join(projectRoot, "README.md"), "initial\n");
    yield* runGit(projectRoot, ["add", "README.md"]);
    yield* runGit(projectRoot, ["commit", "-m", "Initial commit"]);
    return yield* Effect.tryPromise({
      try: async () => {
        const result = await runProcess("git", ["rev-parse", "HEAD"], {
          cwd: projectRoot,
          timeoutMs: 10_000,
        });
        return result.stdout.trim();
      },
      catch: (cause) => new SymphonyError({ message: "git rev-parse HEAD failed", cause }),
    });
  });

interface OrchestrationMockState {
  currentReadModel: OrchestrationReadModel | null;
  dispatchedCommands: OrchestrationCommand[];
}

const makeLayer = (
  projectRootRef: { current: string },
  orchestrationState: OrchestrationMockState,
) => {
  const nodeLayer = NodeServices.layer;
  const sqliteLayer = Layer.fresh(NodeSqliteClient.layerMemory());
  const configLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-symphony-service-config-",
  }).pipe(Layer.provideMerge(nodeLayer));
  const repositoryLayer = SymphonyRepositoryLive.pipe(Layer.provideMerge(sqliteLayer));
  const dependencies = Layer.mergeAll(
    NodeServices.layer,
    sqliteLayer,
    configLayer,
    repositoryLayer,
    Layer.mock(ServerSecretStore)({
      get: () => Effect.succeed(textEncoder.encode("linear-test-key")),
      set: () => Effect.void,
      getOrCreateRandom: () => Effect.succeed(textEncoder.encode("secret")),
      remove: () => Effect.void,
    }),
    Layer.mock(GitCore)({
      readConfigValue: () => Effect.succeed("https://github.com/t3/battlecode.git"),
      statusDetails: () =>
        Effect.succeed({
          isRepo: true,
          hasOriginRemote: true,
          isDefaultBranch: false,
          branch: "development",
          hasWorkingTreeChanges: false,
          workingTree: {
            files: [],
            insertions: 0,
            deletions: 0,
          },
          hasUpstream: true,
          aheadCount: 0,
          behindCount: 0,
          upstreamRef: "origin/development",
        }),
      createWorktree: (input) =>
        Effect.succeed({
          worktree: {
            path: input.path ?? projectRootRef.current,
            branch: input.newBranch ?? input.branch,
          },
        }),
    }),
    Layer.mock(GitManager)({
      status: () =>
        Effect.succeed({
          isRepo: true,
          hasOriginRemote: true,
          isDefaultBranch: false,
          branch: "symphony/bc-1",
          hasWorkingTreeChanges: false,
          workingTree: {
            files: [],
            insertions: 0,
            deletions: 0,
          },
          hasUpstream: true,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        }),
      localStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasOriginRemote: true,
          isDefaultBranch: false,
          branch: "symphony/bc-1",
          hasWorkingTreeChanges: false,
          workingTree: {
            files: [],
            insertions: 0,
            deletions: 0,
          },
        }),
      remoteStatus: () =>
        Effect.succeed({
          hasUpstream: true,
          aheadCount: 0,
          behindCount: 0,
          pr: null,
        }),
      invalidateLocalStatus: () => Effect.void,
      invalidateRemoteStatus: () => Effect.void,
      invalidateStatus: () => Effect.void,
      resolvePullRequest: () =>
        Effect.succeed({
          pullRequest: {
            number: 42,
            title: "Fix cloud lifecycle",
            url: "https://github.com/t3/battlecode/pull/42",
            baseBranch: "development",
            headBranch: "symphony/bc-1",
            state: "open",
          },
        }),
      preparePullRequestThread: () =>
        Effect.succeed({
          pullRequest: {
            number: 42,
            title: "Fix cloud lifecycle",
            url: "https://github.com/t3/battlecode/pull/42",
            baseBranch: "development",
            headBranch: "symphony/bc-1",
            state: "open",
          },
          branch: "symphony/bc-1",
          worktreePath: projectRootRef.current,
        }),
      runStackedAction: (input, options) => gitManagerMocks.runStackedAction(input, options),
    }),
    Layer.mock(OrchestrationEngineService)({
      getReadModel: () =>
        Effect.succeed(
          orchestrationState.currentReadModel ?? makeReadModel(projectRootRef.current),
        ),
      readEvents: () => Stream.empty,
      dispatch: (command) =>
        Effect.sync(() => {
          orchestrationState.dispatchedCommands.push(command);
          return { sequence: orchestrationState.dispatchedCommands.length };
        }),
      streamDomainEvents: Stream.empty,
    }),
  );
  return SymphonyServiceLive.pipe(Layer.provideMerge(dependencies));
};

beforeEach(() => {
  vi.clearAllMocks();
  orchestrationState.currentReadModel = null;
  orchestrationState.dispatchedCommands = [];
  linearMocks.createLinearComment.mockReturnValue(
    Effect.succeed({
      id: "comment-1",
      url: "https://linear.app/t3/issue/BC-1#comment-comment-1",
    }),
  );
  linearMocks.detectLinearCodexTask.mockReturnValue(
    Effect.succeed({
      status: "unknown",
      taskUrl: null,
      linearCommentId: null,
      message: null,
    }),
  );
  linearMocks.fetchLinearCandidates.mockReturnValue(Effect.succeed([]));
  linearMocks.fetchLinearIssueComments.mockReturnValue(Effect.succeed([]));
  linearMocks.fetchLinearIssuesByIds.mockReturnValue(Effect.succeed([]));
  linearMocks.fetchLinearTeamsAndProjects.mockReturnValue(Effect.succeed([]));
  linearMocks.fetchLinearWorkflowStates.mockReturnValue(Effect.succeed([]));
  linearMocks.testLinearConnection.mockReturnValue(Effect.succeed({}));
  linearMocks.updateLinearComment.mockReturnValue(
    Effect.succeed({
      id: "comment-1",
      url: "https://linear.app/t3/issue/BC-1#comment-comment-1",
    }),
  );
  linearMocks.updateLinearIssueState.mockReturnValue(
    Effect.succeed({
      changed: false,
      stateId: "state-done",
      stateName: "Done",
    }),
  );
  gitManagerMocks.runStackedAction.mockReturnValue(
    Effect.succeed({
      action: "commit_push_pr",
      branch: { status: "skipped_not_requested" },
      commit: { status: "skipped_no_changes" },
      push: { status: "skipped_up_to_date" },
      pr: {
        status: "created",
        url: "https://github.com/t3/battlecode/pull/42",
        number: 42,
        baseBranch: "development",
        headBranch: "symphony/bc-1",
        title: "Fix cloud lifecycle",
      },
      toast: {
        title: "Pull request created",
        cta: {
          kind: "open_pr",
          label: "Open PR",
          url: "https://github.com/t3/battlecode/pull/42",
        },
      },
    }),
  );
});

const projectRootRef = { current: "" };
const orchestrationState: OrchestrationMockState = {
  currentReadModel: null,
  dispatchedCommands: [],
};
const layer = it.layer(makeLayer(projectRootRef, orchestrationState));

layer("SymphonyService lifecycle reconciliation", (it) => {
  it.effect("launches a pending issue as a local running run", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(makeServiceRun({ status: "intake" }));

      yield* service.launchIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "implementing");
    }),
  );

  it.effect("archives an inactive run locally without changing Linear", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "failed",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          currentStep: {
            source: "local-thread",
            label: "Codex turn failed",
            detail: "lint failed",
            updatedAt: CREATED_AT,
          },
          attempts: [
            {
              attempt: 1,
              status: "failed",
              startedAt: CREATED_AT,
              completedAt: "2026-05-02T12:05:00.000Z",
              error: "lint failed",
            },
          ],
          lastError: "lint failed",
        }),
      );

      const snapshot = yield* service.archiveIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "failed");
      assert.strictEqual(run?.currentStep?.label, "Codex turn failed");
      assert.strictEqual(run?.attempts.length, 1);
      assert.strictEqual(run?.lastError, "lint failed");
      assert.notStrictEqual(run?.archivedAt, null);
      assert.strictEqual(snapshot.totals.archived, 1);
      assert.strictEqual(snapshot.queues.failed.length, 0);
      expect(linearMocks.updateLinearIssueState).not.toHaveBeenCalled();
    }),
  );

  it.effect("rejects archiving an actively running implementation", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "implementing",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
        }),
      );

      const error = yield* service
        .archiveIssue({
          projectId: PROJECT_ID,
          issueId: ISSUE_ID,
        })
        .pipe(Effect.flip);

      assert.match(
        error.message,
        /Cannot archive a run while Symphony is actively working on it\. Stop it first\./,
      );
      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.archivedAt, null);
      expect(linearMocks.updateLinearIssueState).not.toHaveBeenCalled();
    }),
  );

  it.effect("returns the snapshot for an already archived run without changing Linear", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const archivedAt = "2026-05-02T12:10:00.000Z";

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "failed",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          archivedAt,
        }),
      );

      const snapshot = yield* service.archiveIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.archivedAt, archivedAt);
      assert.strictEqual(snapshot.totals.archived, 1);
      expect(linearMocks.updateLinearIssueState).not.toHaveBeenCalled();
    }),
  );

  it.effect("reactivates archived runs when Linear returns them to intake", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const archivedAt = "2026-05-02T12:10:00.000Z";

      linearMocks.fetchLinearCandidates.mockReturnValue(
        Effect.succeed([
          makeIssue({
            state: "Todo",
            updatedAt: "2026-05-02T12:12:00.000Z",
          }),
        ]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "canceled",
          pullRequest: {
            number: 7,
            title: "Old PR",
            url: "https://github.com/t3/battlecode/pull/7",
            baseBranch: "development",
            headBranch: "symphony/bc-1",
            state: "closed",
            updatedAt: CREATED_AT,
          },
          prUrl: "https://github.com/t3/battlecode/pull/7",
          archivedAt,
          lastError: "previous failure",
        }),
      );

      const snapshot = yield* service.refresh({ projectId: PROJECT_ID });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.archivedAt, null);
      assert.strictEqual(run?.status, "intake");
      assert.strictEqual(run?.pullRequest, null);
      assert.strictEqual(run?.prUrl, null);
      assert.strictEqual(run?.lastError, null);
      assert.strictEqual(snapshot.queues.intake.length, 1);
      assert.strictEqual(snapshot.totals.archived, 0);
      assert.ok(snapshot.events.some((event) => event.type === "run.reactivated"));
    }),
  );

  it.effect("sets existing local Symphony threads to full-access before starting a turn", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const thread = makeThread({
        runtimeMode: "auto-accept-edits",
        worktreePath: projectRoot,
      });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "intake",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          threadId: thread.id,
        }),
      );

      yield* service.launchIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });

      const runtimeCommandIndex = orchestrationState.dispatchedCommands.findIndex(
        (command) => command.type === "thread.runtime-mode.set",
      );
      const turnStartCommandIndex = orchestrationState.dispatchedCommands.findIndex(
        (command) => command.type === "thread.turn.start",
      );
      assert.notStrictEqual(runtimeCommandIndex, -1);
      assert.notStrictEqual(turnStartCommandIndex, -1);
      assert.ok(runtimeCommandIndex < turnStartCommandIndex);
      const runtimeCommand = orchestrationState.dispatchedCommands[runtimeCommandIndex];
      assert.ok(runtimeCommand);
      if (runtimeCommand.type !== "thread.runtime-mode.set") {
        throw new Error(`Expected runtime-mode command, received ${runtimeCommand.type}.`);
      }
      assert.strictEqual(runtimeCommand.runtimeMode, "full-access");
    }),
  );

  it.effect("auto-accepts pending local Symphony approval requests", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const thread = makeThread({
        worktreePath: projectRoot,
        activities: [
          {
            id: "event-approval" as never,
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: {
              requestId: "approval-1",
              requestKind: "command",
              detail: "bun lint",
            },
            turnId: null,
            sequence: 1,
            createdAt: CREATED_AT,
          },
        ],
      });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "intake",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          threadId: thread.id,
        }),
      );

      yield* service.launchIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });

      const approvalCommand = orchestrationState.dispatchedCommands.find(
        (command) => command.type === "thread.approval.respond",
      );
      assert.ok(approvalCommand);
      if (approvalCommand.type !== "thread.approval.respond") {
        throw new Error(`Expected approval response command, received ${approvalCommand.type}.`);
      }
      assert.strictEqual(approvalCommand.decision, "acceptForSession");
      assert.strictEqual(approvalCommand.requestId, "approval-1");
    }),
  );

  it.effect("starts a continuation turn when a completed local turn leaves Linear active", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const thread = makeThread({
        worktreePath: projectRoot,
        latestTurn: {
          turnId: "turn-1" as never,
          state: "completed",
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: "2026-05-02T12:10:00.000Z",
          assistantMessageId: null,
        },
      });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("In Progress")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "implementing",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          threadId: thread.id,
          attempts: [
            {
              attempt: 1,
              status: "streaming-turn",
              startedAt: CREATED_AT,
              completedAt: null,
              error: null,
            },
          ],
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      const continuationTurn = orchestrationState.dispatchedCommands.findLast(
        (command) => command.type === "thread.turn.start",
      );
      assert.ok(continuationTurn);
      if (continuationTurn.type !== "thread.turn.start") {
        throw new Error(`Expected turn start command, received ${continuationTurn.type}.`);
      }
      assert.match(continuationTurn.message.text, /Continuation guidance:/);
      assert.match(continuationTurn.message.text, /continuation turn #2 of 20/);
      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "implementing");
      assert.strictEqual(run?.attempts.length, 2);
      assert.strictEqual(run?.lastError, null);
    }),
  );

  it.effect("recovers legacy no-longer-eligible canceled runs from active Linear state", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("In Progress")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "canceled",
          branchName: "symphony/bc-1",
          lastError: LINEAR_INELIGIBLE_LEGACY_ERROR,
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "intake");
      assert.strictEqual(run?.lastError, null);
    }),
  );

  it.effect("keeps running runs active when missing from candidates but active by Linear id", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const thread = makeThread({ worktreePath: projectRoot });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
      linearMocks.fetchLinearCandidates.mockReturnValue(Effect.succeed([]));
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("In Progress")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "implementing",
          branchName: "symphony/bc-1",
          threadId: thread.id,
          workspacePath: projectRoot,
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "implementing");
      assert.strictEqual(run?.archivedAt, null);
    }),
  );

  it.effect("starts a planning turn for Linear intake issues", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const intakeIssueId = SymphonyIssueId.make("issue-bc-intake");
      linearMocks.fetchLinearCandidates.mockReturnValue(
        Effect.succeed([
          makeIssue({
            id: intakeIssueId,
            identifier: "BC-INTAKE",
            title: "Plan intake workflow",
            state: "To Do",
          }),
        ]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;

      yield* service.start({ projectId: PROJECT_ID });

      const turnStart = orchestrationState.dispatchedCommands.findLast(
        (command) => command.type === "thread.turn.start",
      );
      assert.ok(turnStart);
      if (turnStart.type !== "thread.turn.start") {
        throw new Error(`Expected turn start command, received ${turnStart.type}.`);
      }
      assert.match(turnStart.message.text, /Symphony planning phase/);
      assert.match(turnStart.message.text, /Do not write code in this phase/);
      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: intakeIssueId,
      });
      assert.strictEqual(run?.status, "planning");
    }),
  );

  it.effect("posts the plan, moves Linear to In Progress, and starts implementation", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const planMarkdown = "- [ ] Update contracts\n- [ ] Implement workflow phases";
      const thread = makeThread({
        worktreePath: projectRoot,
        latestTurn: {
          turnId: "turn-plan" as never,
          state: "completed",
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: "2026-05-02T12:10:00.000Z",
          assistantMessageId: null,
        },
        proposedPlans: [
          {
            id: "plan-1",
            turnId: "turn-plan" as never,
            planMarkdown,
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-05-02T12:09:00.000Z",
            updatedAt: "2026-05-02T12:09:00.000Z",
          },
        ],
      });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("Human Review")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "planning",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          threadId: thread.id,
          attempts: [
            {
              attempt: 1,
              status: "streaming-turn",
              startedAt: CREATED_AT,
              completedAt: null,
              error: null,
            },
          ],
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      expect(linearMocks.updateLinearIssueState).toHaveBeenCalledWith(
        expect.objectContaining({ stateName: "In Progress" }),
      );
      expect(linearMocks.createLinearComment).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.stringContaining("## Plan\n\n- [ ] Update contracts"),
        }),
      );
      const implementationTurn = orchestrationState.dispatchedCommands.findLast(
        (command) => command.type === "thread.turn.start",
      );
      assert.ok(implementationTurn);
      if (implementationTurn.type !== "thread.turn.start") {
        throw new Error(`Expected turn start command, received ${implementationTurn.type}.`);
      }
      assert.match(implementationTurn.message.text, /Symphony implementation phase/);
      assert.match(implementationTurn.message.text, /Approved plan/);
      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "implementing");
      assert.strictEqual(run?.linearProgress.commentId, "comment-1");
    }),
  );

  it.effect("creates a development PR after a clean review pass", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const planMarkdown = "- [x] Update contracts\n- [x] Implement workflow phases";
      const thread = makeThread({
        worktreePath: projectRoot,
        latestTurn: {
          turnId: "turn-review" as never,
          state: "completed",
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: "2026-05-02T12:20:00.000Z",
          assistantMessageId: "message-review" as never,
        },
        messages: [
          {
            id: "message-review" as never,
            role: "assistant",
            text: "REVIEW_PASS: tests cover the workflow",
            turnId: "turn-review" as never,
            streaming: false,
            createdAt: "2026-05-02T12:19:00.000Z",
            updatedAt: "2026-05-02T12:19:00.000Z",
          },
        ],
      });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("Human Review")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "implementing",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          threadId: thread.id,
          currentStep: {
            source: "symphony",
            label: "Reviewing implementation",
            detail: planMarkdown,
            updatedAt: CREATED_AT,
          },
          attempts: [
            {
              attempt: 1,
              status: "streaming-turn",
              startedAt: CREATED_AT,
              completedAt: null,
              error: null,
            },
          ],
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      expect(gitManagerMocks.runStackedAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "commit_push_pr",
          baseBranch: "development",
        }),
        undefined,
      );
      expect(linearMocks.updateLinearIssueState).toHaveBeenCalledWith(
        expect.objectContaining({ stateName: "Human Review" }),
      );
      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "in-review");
      assert.strictEqual(run?.prUrl, "https://github.com/t3/battlecode/pull/42");
      assert.strictEqual(run?.pullRequest?.baseBranch, "development");
      assert.strictEqual(run?.qualityGate.lastReviewSummary, "tests cover the workflow");
    }),
  );

  it.effect("updates an existing PR after a clean review pass", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const planMarkdown = "- [x] Update existing PR";
      const thread = makeThread({
        worktreePath: projectRoot,
        latestTurn: {
          turnId: "turn-review-existing-pr" as never,
          state: "completed",
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: "2026-05-02T12:20:00.000Z",
          assistantMessageId: "message-review-existing-pr" as never,
        },
        messages: [
          {
            id: "message-review-existing-pr" as never,
            role: "assistant",
            text: "REVIEW_PASS: existing PR is ready",
            turnId: "turn-review-existing-pr" as never,
            streaming: false,
            createdAt: "2026-05-02T12:19:00.000Z",
            updatedAt: "2026-05-02T12:19:00.000Z",
          },
        ],
      });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("Human Review")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "implementing",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          threadId: thread.id,
          prUrl: "https://github.com/t3/battlecode/pull/42",
          pullRequest: {
            number: 42,
            title: "Fix cloud lifecycle",
            url: "https://github.com/t3/battlecode/pull/42",
            baseBranch: "development",
            headBranch: "symphony/bc-1",
            state: "open",
            updatedAt: "2026-05-02T12:10:00.000Z",
          },
          currentStep: {
            source: "symphony",
            label: "Reviewing implementation",
            detail: planMarkdown,
            updatedAt: CREATED_AT,
          },
          attempts: [
            {
              attempt: 1,
              status: "streaming-turn",
              startedAt: CREATED_AT,
              completedAt: null,
              error: null,
            },
          ],
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      expect(gitManagerMocks.runStackedAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "commit_push_pr",
          baseBranch: "development",
        }),
        undefined,
      );
      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "in-review");
      assert.strictEqual(run?.prUrl, "https://github.com/t3/battlecode/pull/42");
    }),
  );

  it.effect("fails a no-op fix turn instead of looping", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const reviewedCommit = yield* initializeGitRepository(projectRoot);
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const thread = makeThread({
        worktreePath: projectRoot,
        latestTurn: {
          turnId: "turn-fix" as never,
          state: "completed",
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: "2026-05-02T12:40:00.000Z",
          assistantMessageId: "message-fix" as never,
        },
      });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("In Progress")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      const baseRun = makeServiceRun();
      yield* repository.upsertRun({
        ...baseRun,
        status: "implementing",
        workspacePath: projectRoot,
        branchName: "symphony/bc-1",
        threadId: thread.id,
        currentStep: {
          source: "symphony",
          label: "Fixing review findings",
          detail: "- [x] Existing plan",
          updatedAt: CREATED_AT,
        },
        qualityGate: {
          ...baseRun.qualityGate,
          lastReviewedCommit: reviewedCommit,
          lastFeedbackFingerprint: "feedback-hash",
        },
        attempts: [
          {
            attempt: 1,
            status: "streaming-turn",
            startedAt: CREATED_AT,
            completedAt: null,
            error: null,
          },
        ],
      });

      yield* service.refresh({ projectId: PROJECT_ID });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "failed");
      assert.match(run?.lastError ?? "", /without code, test, or documentation changes/);
      expect(orchestrationState.dispatchedCommands).toHaveLength(0);
    }),
  );

  it.effect("fails instead of starting a new phase after max turns", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const thread = makeThread({
        worktreePath: projectRoot,
        latestTurn: {
          turnId: "turn-review-fail" as never,
          state: "completed",
          requestedAt: CREATED_AT,
          startedAt: CREATED_AT,
          completedAt: "2026-05-02T12:45:00.000Z",
          assistantMessageId: "message-review-fail" as never,
        },
        messages: [
          {
            id: "message-review-fail" as never,
            role: "assistant",
            text: "REVIEW_FAIL: missing validation\n- Add validation.",
            turnId: "turn-review-fail" as never,
            streaming: false,
            createdAt: "2026-05-02T12:44:00.000Z",
            updatedAt: "2026-05-02T12:44:00.000Z",
          },
        ],
      });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("In Progress")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      const baseRun = makeServiceRun();
      yield* repository.upsertRun({
        ...baseRun,
        status: "implementing",
        workspacePath: projectRoot,
        branchName: "symphony/bc-1",
        threadId: thread.id,
        currentStep: {
          source: "symphony",
          label: "Reviewing implementation",
          detail: "- [x] Existing plan",
          updatedAt: CREATED_AT,
        },
        attempts: Array.from({ length: 20 }, (_, index) => ({
          attempt: index + 1,
          status: index === 19 ? ("streaming-turn" as const) : ("succeeded" as const),
          startedAt: CREATED_AT,
          completedAt: index === 19 ? null : "2026-05-02T12:30:00.000Z",
          error: null,
        })),
      });

      yield* service.refresh({ projectId: PROJECT_ID });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "failed");
      assert.match(run?.lastError ?? "", /configured max_turns/);
      expect(orchestrationState.dispatchedCommands).toHaveLength(0);
    }),
  );

  it.effect("maps Human Review, Done, and Canceled Linear states to lifecycle statuses", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;

      yield* repository.upsertRun(
        makeServiceRun({
          status: "in-review",
          branchName: "symphony/bc-1",
        }),
      );
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("Human Review")]),
      );
      yield* service.refresh({ projectId: PROJECT_ID });
      let run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "in-review");

      yield* repository.upsertRun(
        makeServiceRun({
          status: "in-review",
          branchName: "symphony/bc-1",
        }),
      );
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("Done")]),
      );
      yield* service.refresh({ projectId: PROJECT_ID });
      run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "completed");
      assert.notStrictEqual(run?.archivedAt, null);

      yield* repository.upsertRun(
        makeServiceRun({
          status: "in-review",
          branchName: "symphony/bc-1",
          archivedAt: null,
        }),
      );
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("Canceled")]),
      );
      yield* service.refresh({ projectId: PROJECT_ID });
      run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "canceled");
      assert.notStrictEqual(run?.archivedAt, null);
    }),
  );

  it.effect("coalesces repeated Linear lookup warnings during rapid refreshes", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.fail(new SymphonyError({ message: "Linear request failed with HTTP 400." })),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "implementing",
          branchName: "symphony/bc-1",
        }),
      );

      const firstSnapshot = yield* service.refresh({ projectId: PROJECT_ID });
      const secondSnapshot = yield* service.refresh({ projectId: PROJECT_ID });

      const firstCount = countLinearLookupWarnings(firstSnapshot.events);
      assert.ok(firstCount > 0);
      assert.strictEqual(countLinearLookupWarnings(secondSnapshot.events), firstCount);
    }),
  );
});

layer("SymphonyService wizard RPCs", (it) => {
  it.effect("fetchLinearProjects flattens teams.projects with team names", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;

      const projects: SymphonyLinearProject[] = [
        { id: "proj-1", name: "Battlecode Alpha", slugId: "battlecode-alpha", teamId: "team-1", teamName: "Team Alpha" },
        { id: "proj-2", name: "Battlecode Beta", slugId: "battlecode-beta", teamId: "team-2", teamName: "Team Beta" },
      ];
      linearMocks.fetchLinearTeamsAndProjects.mockReturnValue(Effect.succeed(projects));

      const result = yield* service.fetchLinearProjects({
        projectId: PROJECT_ID,
        apiKey: "lin_api_test",
      });

      assert.strictEqual(result.length, 2);
      assert.strictEqual(result[0]?.name, "Battlecode Alpha");
      assert.strictEqual(result[0]?.teamName, "Team Alpha");
      assert.strictEqual(result[1]?.name, "Battlecode Beta");
      assert.strictEqual(result[1]?.teamName, "Team Beta");
    }),
  );

  it.effect("fetchLinearWorkflowStates returns workflow states from Linear", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;

      // The mock returns pre-sorted states (sorting happens inside fetchLinearWorkflowStates in linear.ts).
      const states: SymphonyLinearWorkflowState[] = [
        { id: "s-1", name: "To Do", type: "unstarted", position: 1 },
        { id: "s-2", name: "In Progress", type: "started", position: 2 },
        { id: "s-3", name: "Done", type: "completed", position: 3 },
      ];
      linearMocks.fetchLinearWorkflowStates.mockReturnValue(Effect.succeed(states));

      const result = yield* service.fetchLinearWorkflowStates({
        projectId: PROJECT_ID,
        apiKey: "lin_api_test",
        teamId: "team-1",
      });

      assert.strictEqual(result.length, 3);
      assert.strictEqual(result[0]?.name, "To Do");
      assert.strictEqual(result[1]?.name, "In Progress");
      assert.strictEqual(result[2]?.name, "Done");
    }),
  );

  it.effect("applyConfiguration writes WORKFLOW.md and triggers reload", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const service = yield* SymphonyService;
      const fs = yield* FileSystem.FileSystem;
      const pathLib = yield* Path.Path;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;

      const applyInput: SymphonyApplyConfigurationInput = {
        projectId: PROJECT_ID,
        trackerProjectSlugId: "my-project",
        trackerProjectName: "My Project",
        trackerTeamId: "team-1",
        states: {
          intake: ["To Do"],
          active: ["In Progress"],
          review: ["In Review"],
          done: ["Done"],
          canceled: ["Canceled"],
        },
        validation: [],
        prBaseBranch: "main",
      };

      const result = yield* service.applyConfiguration(applyInput);

      assert.strictEqual(result.ok, true);

      const workflowPath = pathLib.join(projectRoot, "WORKFLOW.md");
      const written = yield* fs.readFileString(workflowPath);
      assert.ok(written.includes("project_slug_id: my-project"));
      assert.ok(written.includes("base_branch: main"));
      assert.ok(written.includes("- To Do"));
      assert.ok(written.includes("- In Progress"));
    }),
  );
});
