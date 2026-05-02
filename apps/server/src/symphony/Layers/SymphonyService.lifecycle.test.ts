import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GitHubCliError,
  ProjectId,
  SymphonyIssueId,
  type OrchestrationReadModel,
  type SymphonyIssue,
  type SymphonyRun,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { beforeEach, vi } from "vitest";

import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { SymphonyRepository } from "../Services/SymphonyRepository.ts";
import { SymphonyService } from "../Services/SymphonyService.ts";
import { makeRun } from "../runModel.ts";
import { SymphonyRepositoryLive } from "./SymphonyRepository.ts";
import { SymphonyServiceLive } from "./SymphonyService.ts";

const linearMocks = vi.hoisted(() => ({
  createLinearComment: vi.fn(),
  detectLinearCodexTask: vi.fn(),
  fetchLinearCandidates: vi.fn(),
  fetchLinearIssuesByIds: vi.fn(),
  testLinearConnection: vi.fn(),
  updateLinearIssueState: vi.fn(),
}));

vi.mock("../linear.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../linear.ts")>();
  return {
    ...actual,
    createLinearComment: linearMocks.createLinearComment,
    detectLinearCodexTask: linearMocks.detectLinearCodexTask,
    fetchLinearCandidates: linearMocks.fetchLinearCandidates,
    fetchLinearIssuesByIds: linearMocks.fetchLinearIssuesByIds,
    testLinearConnection: linearMocks.testLinearConnection,
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
  review_states:
    - In Review
  done_states:
    - Done
  canceled_states:
    - Canceled
  transition_states:
    started: In Progress
    review: In Review
    done: Done
    canceled: Canceled
polling:
  interval_ms: 30000
agent:
  max_concurrent_agents: 3
---

Run {{ issue.identifier }}.
`;

const githubMocks = {
  getPullRequest: vi.fn(),
  listOpenPullRequests: vi.fn(),
};

function makeReadModel(projectRoot: string): OrchestrationReadModel {
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

const writeWorkflow = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectRoot = yield* fs.makeTempDirectoryScoped({ prefix: "t3-symphony-service-" });
  yield* fs.writeFileString(path.join(projectRoot, "WORKFLOW.md"), WORKFLOW_MD);
  return projectRoot;
});

const makeLayer = (projectRootRef: { current: string }) => {
  const nodeLayer = NodeServices.layer;
  const sqliteLayer = NodeSqliteClient.layerMemory();
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
    }),
    Layer.mock(GitHubCli)({
      getPullRequest: (input) => githubMocks.getPullRequest(input),
      listOpenPullRequests: (input) => githubMocks.listOpenPullRequests(input),
    }),
    Layer.mock(OrchestrationEngineService)({
      getReadModel: () => Effect.succeed(makeReadModel(projectRootRef.current)),
      readEvents: () => Stream.empty,
      dispatch: () => Effect.succeed({ sequence: 1 }),
      streamDomainEvents: Stream.empty,
    }),
  );
  return SymphonyServiceLive.pipe(Layer.provideMerge(dependencies));
};

beforeEach(() => {
  vi.clearAllMocks();
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
  linearMocks.fetchLinearIssuesByIds.mockReturnValue(Effect.succeed([]));
  linearMocks.testLinearConnection.mockReturnValue(Effect.succeed({}));
  linearMocks.updateLinearIssueState.mockReturnValue(
    Effect.succeed({
      changed: false,
      stateId: "state-done",
      stateName: "Done",
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
  githubMocks.listOpenPullRequests.mockReturnValue(Effect.succeed([]));
});

const projectRootRef = { current: "" };
const layer = it.layer(makeLayer(projectRootRef));

layer("SymphonyService lifecycle reconciliation", (it) => {
  it.effect("persists the computed cloud branch name when launching a Codex Cloud run", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
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

  it.effect("refreshes a known PR URL to merged, completes the run, and archives it", () =>
    Effect.gen(function* () {
      const projectRoot = yield* writeWorkflow;
      projectRootRef.current = projectRoot;
      const repository = yield* SymphonyRepository;
      const service = yield* SymphonyService;

      yield* runMigrations();
      yield* insertProjectionProject(projectRoot);
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
});
