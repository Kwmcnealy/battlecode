import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GitHubCliError,
  ProjectId,
  SymphonyIssueId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type SymphonyIssue,
  type SymphonyRun,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { beforeEach, expect, vi } from "vitest";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
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
    testLinearConnection: linearMocks.testLinearConnection,
    updateLinearComment: linearMocks.updateLinearComment,
    updateLinearIssueState: linearMocks.updateLinearIssueState,
  };
});

const CREATED_AT = "2026-05-02T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-symphony-service");
const ISSUE_ID = SymphonyIssueId.make("issue-bc-1");
const textEncoder = new TextEncoder();

const WORKFLOW_MD = `---
tracker:
  kind: linear
  project_slug: battlecode
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

const githubMocks = {
  getPullRequest: vi.fn(),
  listPullRequestFeedbackSignals: vi.fn(),
  listOpenPullRequests: vi.fn(),
};

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
    executionDefaultTarget: "local",
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
    Layer.mock(GitHubCli)({
      getPullRequest: (input) => githubMocks.getPullRequest(input),
      listPullRequestFeedbackSignals: (input) => githubMocks.listPullRequestFeedbackSignals(input),
      listOpenPullRequests: (input) => githubMocks.listOpenPullRequests(input),
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
  githubMocks.getPullRequest.mockReturnValue(
    Effect.fail(
      new GitHubCliError({
        operation: "pr view",
        detail: "unused test mock",
      }),
    ),
  );
  githubMocks.listPullRequestFeedbackSignals.mockReturnValue(Effect.succeed([]));
  githubMocks.listOpenPullRequests.mockReturnValue(Effect.succeed([]));
});

const projectRootRef = { current: "" };
const orchestrationState: OrchestrationMockState = {
  currentReadModel: null,
  dispatchedCommands: [],
};
const layer = it.layer(makeLayer(projectRootRef, orchestrationState));

layer("SymphonyService lifecycle reconciliation", (it) => {
  it.effect("persists the computed cloud branch name when launching a Codex Cloud run", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(makeServiceRun({ status: "target-pending" }));

      yield* service.launchIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        target: "codex-cloud",
      });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.executionTarget, "codex-cloud");
      assert.strictEqual(run?.status, "cloud-submitted");
      assert.strictEqual(run?.branchName, "symphony/bc-1");
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
          status: "target-pending",
          executionTarget: "local",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          threadId: thread.id,
        }),
      );

      yield* service.launchIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        target: "local",
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
          status: "target-pending",
          executionTarget: "local",
          workspacePath: projectRoot,
          branchName: "symphony/bc-1",
          threadId: thread.id,
        }),
      );

      yield* service.launchIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        target: "local",
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

  it.effect("refreshes a known PR URL to merged, completes the run, and archives it", () =>
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
          status: "review-ready",
          executionTarget: "codex-cloud",
          branchName: "symphony/bc-1",
          prUrl: "https://github.com/t3/battlecode/pull/42",
          pullRequest: {
            number: 42,
            title: "Fix cloud lifecycle",
            url: "https://github.com/t3/battlecode/pull/42",
            baseBranch: "development",
            headBranch: "symphony/bc-1",
            state: "open",
            updatedAt: CREATED_AT,
          },
        }),
      );
      githubMocks.getPullRequest.mockReturnValueOnce(
        Effect.succeed({
          number: 42,
          title: "Fix cloud lifecycle",
          url: "https://github.com/t3/battlecode/pull/42",
          baseRefName: "development",
          headRefName: "symphony/bc-1",
          state: "merged",
          updatedAt: "2026-05-02T12:30:00.000Z",
        }),
      );

      yield* service.refreshCloudStatus({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "completed");
      assert.strictEqual(run?.pullRequest?.state, "merged");
      assert.strictEqual(run?.prUrl, "https://github.com/t3/battlecode/pull/42");
      assert.notStrictEqual(run?.archivedAt, null);
    }),
  );

  it.effect("keeps lifecycle status unchanged and surfaces PR lookup warnings", () =>
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
          status: "cloud-running",
          executionTarget: "codex-cloud",
          branchName: "symphony/bc-1",
          prUrl: "https://github.com/t3/battlecode/pull/42",
        }),
      );
      githubMocks.getPullRequest.mockReturnValueOnce(
        Effect.fail(
          new GitHubCliError({
            operation: "pr view",
            detail: "network unavailable",
          }),
        ),
      );

      yield* service.refreshCloudStatus({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "cloud-running");
      assert.strictEqual(run?.archivedAt, null);
      assert.match(
        run?.currentStep?.detail ?? "",
        /GitHub PR lookup failed: .*network unavailable/,
      );
      assert.match(run?.lastError ?? "", /GitHub PR lookup failed: .*network unavailable/);
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
          status: "running",
          executionTarget: "local",
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
      assert.strictEqual(run?.status, "running");
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
          executionTarget: "codex-cloud",
          branchName: "symphony/bc-1",
          lastError: LINEAR_INELIGIBLE_LEGACY_ERROR,
          cloudTask: {
            provider: "codex-cloud-linear",
            status: "submitted",
            taskUrl: null,
            linearCommentId: "comment-1",
            linearCommentUrl: "https://linear.app/t3/issue/BC-1#comment-comment-1",
            repository: "t3/battlecode",
            repositoryUrl: "https://github.com/t3/battlecode",
            lastMessage: null,
            delegatedAt: CREATED_AT,
            lastCheckedAt: CREATED_AT,
          },
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "cloud-submitted");
      assert.strictEqual(run?.lastError, null);
    }),
  );

  it.effect("keeps cloud runs active when missing from candidates but active by Linear id", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      linearMocks.fetchLinearCandidates.mockReturnValue(Effect.succeed([]));
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("In Progress")]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "cloud-running",
          executionTarget: "codex-cloud",
          branchName: "symphony/bc-1",
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "cloud-running");
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
      assert.strictEqual(run?.status, "running");
      assert.strictEqual(run?.lifecyclePhase, "planning");
      assert.strictEqual(run?.executionTarget, "local");
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
          status: "running",
          lifecyclePhase: "planning",
          executionTarget: "local",
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
      assert.strictEqual(run?.status, "running");
      assert.strictEqual(run?.lifecyclePhase, "implementing");
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
          status: "running",
          lifecyclePhase: "reviewing",
          executionTarget: "local",
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
      assert.strictEqual(run?.status, "review-ready");
      assert.strictEqual(run?.lifecyclePhase, "in-review");
      assert.strictEqual(run?.prUrl, "https://github.com/t3/battlecode/pull/42");
      assert.strictEqual(run?.pullRequest?.baseBranch, "development");
      assert.strictEqual(run?.qualityGate.lastReviewSummary, "tests cover the workflow");
    }),
  );

  it.effect("collects PR feedback and starts a fix turn while in review", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;
      const thread = makeThread({ worktreePath: projectRoot });
      orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
      linearMocks.fetchLinearIssuesByIds.mockReturnValue(
        Effect.succeed([makeLinearContext("Human Review")]),
      );
      githubMocks.getPullRequest.mockReturnValue(
        Effect.succeed({
          number: 42,
          title: "Fix cloud lifecycle",
          url: "https://github.com/t3/battlecode/pull/42",
          baseRefName: "development",
          headRefName: "symphony/bc-1",
          state: "open",
          updatedAt: "2026-05-02T12:30:00.000Z",
        }),
      );
      githubMocks.listPullRequestFeedbackSignals.mockReturnValue(
        Effect.succeed([
          {
            kind: "review",
            id: "review-1",
            state: "CHANGES_REQUESTED",
            body: "Please add missing validation.",
            authorLogin: "reviewer",
            createdAt: "2026-05-02T12:31:00.000Z",
            updatedAt: "2026-05-02T12:31:00.000Z",
            url: "https://github.com/t3/battlecode/pull/42#pullrequestreview-1",
          },
        ]),
      );

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
      yield* configureWorkflowSettings;
      yield* repository.upsertRun(
        makeServiceRun({
          status: "review-ready",
          lifecyclePhase: "in-review",
          executionTarget: "local",
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
            updatedAt: "2026-05-02T12:30:00.000Z",
          },
          linearProgress: {
            commentId: "comment-1",
            commentUrl: "https://linear.app/t3/issue/BC-1#comment-comment-1",
            lastRenderedHash: "hash-1",
            lastUpdatedAt: "2026-05-02T12:20:00.000Z",
            lastMilestoneAt: "2026-05-02T12:20:00.000Z",
            lastFeedbackAt: null,
          },
        }),
      );

      yield* service.refresh({ projectId: PROJECT_ID });

      const fixTurn = orchestrationState.dispatchedCommands.findLast(
        (command) => command.type === "thread.turn.start",
      );
      assert.ok(fixTurn);
      if (fixTurn.type !== "thread.turn.start") {
        throw new Error(`Expected turn start command, received ${fixTurn.type}.`);
      }
      assert.match(fixTurn.message.text, /Symphony fix phase/);
      assert.match(fixTurn.message.text, /GitHub review requested changes/);
      const run = yield* repository.getRunByIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      });
      assert.strictEqual(run?.status, "running");
      assert.strictEqual(run?.lifecyclePhase, "fixing");
      assert.strictEqual(run?.linearProgress.lastFeedbackAt, "2026-05-02T12:31:00.000Z");
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
          status: "cloud-running",
          executionTarget: "codex-cloud",
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
      assert.strictEqual(run?.status, "review-ready");

      yield* repository.upsertRun(
        makeServiceRun({
          status: "cloud-running",
          executionTarget: "codex-cloud",
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
          status: "cloud-running",
          executionTarget: "codex-cloud",
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
      assert.strictEqual(run?.archivedAt, null);
    }),
  );
});
