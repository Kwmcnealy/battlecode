import {
  ProjectId,
  SymphonyIssueId,
  SymphonyRunId,
  type SymphonyRun,
  type SymphonyWorkflowConfig,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_COMMENT_MARKER,
  appendOwnedCommentId,
  transitionLinearState,
  upsertManagedComment,
  type LinearWriterRunDeps,
} from "./linearWriter.ts";

// Mock the Linear API calls so tests are pure (no network, no DB).
const linearMocks = vi.hoisted(() => ({
  createLinearComment: vi.fn(),
  updateLinearComment: vi.fn(),
  fetchLinearIssuesByIds: vi.fn(),
  updateLinearIssueState: vi.fn(),
}));

vi.mock("./linear.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./linear.ts")>();
  return {
    ...actual,
    createLinearComment: linearMocks.createLinearComment,
    updateLinearComment: linearMocks.updateLinearComment,
    fetchLinearIssuesByIds: linearMocks.fetchLinearIssuesByIds,
    updateLinearIssueState: linearMocks.updateLinearIssueState,
  };
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const BASE_LINEAR_PROGRESS: SymphonyRun["linearProgress"] = {
  commentId: null,
  commentUrl: null,
  ownedCommentIds: [],
  lastRenderedHash: null,
  lastUpdatedAt: null,
  lastMilestoneAt: null,
  lastFeedbackAt: null,
};

const BASE_QUALITY_GATE: SymphonyRun["qualityGate"] = {
  reviewFixLoops: 0,
  lastReviewPassedAt: null,
  lastReviewSummary: null,
  lastReviewFindings: [],
  lastReviewedCommit: null,
  lastFixCommit: null,
  lastPublishedCommit: null,
  lastFeedbackFingerprint: null,
};

function makeRun(overrides: Partial<SymphonyRun> = {}): SymphonyRun {
  return {
    runId: SymphonyRunId.make("run-1"),
    projectId: ProjectId.make("project-1"),
    issue: {
      id: SymphonyIssueId.make("issue-id-1"),
      identifier: "APP-1",
      title: "Test issue",
      description: null,
      priority: null,
      state: "To Do",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: "2026-05-03T00:00:00.000Z",
      updatedAt: "2026-05-03T00:00:00.000Z",
    },
    status: "eligible",
    lifecyclePhase: "planning",
    workspacePath: null,
    branchName: null,
    threadId: null,
    prUrl: null,
    pullRequest: null,
    currentStep: null,
    qualityGate: { ...BASE_QUALITY_GATE },
    linearProgress: { ...BASE_LINEAR_PROGRESS },
    archivedAt: null,
    attempts: [],
    nextRetryAt: null,
    lastError: null,
    createdAt: "2026-05-03T00:00:00.000Z",
    updatedAt: "2026-05-03T00:00:00.000Z",
    ...overrides,
  };
}

function makeWorkflow(endpointOverride?: string): { config: SymphonyWorkflowConfig } {
  return {
    config: {
      tracker: {
        kind: "linear",
        endpoint: endpointOverride ?? "https://api.linear.app/graphql",
        projectSlugId: "",
        activeStates: ["In Progress"],
        reviewStates: ["Human Review"],
        terminalStates: ["Done", "Canceled"],
        doneStates: ["Done"],
        canceledStates: ["Canceled"],
        transitionStates: {
          started: "In Progress",
          review: "Human Review",
          done: "Done",
          canceled: "Canceled",
        },
        intakeStates: ["To Do"],
      },
      polling: { schedulerIntervalMs: 30_000, reconcilerIntervalMs: 10_000, jitter: 0.1 },
      concurrency: { max: 10 },
      stall: { timeoutMs: 300_000 },
      workspace: { root: "" },
      hooks: { timeoutMs: 60_000 },
      agent: { maxConcurrentAgents: 10, maxTurns: 20, maxRetryBackoffMs: 300_000 },
      codex: { runtimeMode: "full-access" },
      pullRequest: { baseBranch: null },
      quality: {
        maxReviewFixLoops: 1,
        simplificationPrompt:
          "Simplify only the code changed for this issue. Preserve behavior and UI unless a fix is required.",
        reviewPrompt:
          "Review the current branch for correctness, regressions, and missing validation. Return REVIEW_PASS or REVIEW_FAIL with concrete findings.",
      },
    },
  };
}

function makeDeps(apiKey = "test-api-key") {
  const emitProjectEvent = vi.fn().mockReturnValue(Effect.void);
  const upsertRun = vi.fn().mockImplementation((run: SymphonyRun) => Effect.succeed(run));

  return {
    readLinearApiKey: vi.fn().mockReturnValue(Effect.succeed(apiKey)),
    emitProjectEvent,
    upsertRun,
  } satisfies LinearWriterRunDeps;
}

async function runEffect<A>(effect: Effect.Effect<A, never>): Promise<A> {
  return Effect.runPromise(effect);
}

// ---------------------------------------------------------------------------
// MANAGED_COMMENT_MARKER
// ---------------------------------------------------------------------------

describe("MANAGED_COMMENT_MARKER", () => {
  it("is the expected marker string", () => {
    expect(MANAGED_COMMENT_MARKER).toBe("<!-- symphony-managed-progress v1 -->");
  });
});

// ---------------------------------------------------------------------------
// appendOwnedCommentId
// ---------------------------------------------------------------------------

describe("appendOwnedCommentId", () => {
  const baseProgress = {
    commentId: null,
    commentUrl: null,
    ownedCommentIds: [] as string[],
    lastRenderedHash: null,
    lastUpdatedAt: null,
    lastMilestoneAt: null,
    lastFeedbackAt: null,
  };

  it("appends a new comment id to the owned list", () => {
    const result = appendOwnedCommentId(baseProgress, "comment-1");
    expect(result.ownedCommentIds).toContain("comment-1");
  });

  it("deduplicates comment ids (case-insensitive)", () => {
    const progress = { ...baseProgress, ownedCommentIds: ["comment-1"] };
    const result = appendOwnedCommentId(progress, "comment-1");
    expect(result.ownedCommentIds).toHaveLength(1);
  });

  it("returns the same progress when commentId is null", () => {
    const result = appendOwnedCommentId(baseProgress, null);
    expect(result).toBe(baseProgress);
  });
});

// ---------------------------------------------------------------------------
// upsertManagedComment
// ---------------------------------------------------------------------------

describe("upsertManagedComment", () => {
  it("creates a new comment when no existing commentId", async () => {
    const run = makeRun();
    const deps = makeDeps();
    linearMocks.createLinearComment.mockReturnValue(
      Effect.succeed({ id: "new-comment-id", url: "https://linear.app/comment/1" }),
    );

    const result = await runEffect(
      upsertManagedComment(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        planMarkdown: null,
        statusLine: "Planning",
      }),
    );

    expect(linearMocks.createLinearComment).toHaveBeenCalledOnce();
    expect(linearMocks.updateLinearComment).not.toHaveBeenCalled();
    expect(result.linearProgress).toMatchObject({
      commentId: "new-comment-id",
    });
  });

  it("updates an existing comment when commentId is already set", async () => {
    const run = makeRun({
      linearProgress: {
        commentId: "existing-comment-id",
        commentUrl: null,
        ownedCommentIds: ["existing-comment-id"],
        lastRenderedHash: null,
        lastUpdatedAt: null,
        lastMilestoneAt: null,
        lastFeedbackAt: null,
      },
    });
    const deps = makeDeps();
    linearMocks.updateLinearComment.mockReturnValue(
      Effect.succeed({ id: "existing-comment-id", url: "https://linear.app/comment/1" }),
    );

    await runEffect(
      upsertManagedComment(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        planMarkdown: "- [ ] step 1",
        statusLine: "Implementing",
      }),
    );

    expect(linearMocks.updateLinearComment).toHaveBeenCalledOnce();
    expect(linearMocks.createLinearComment).not.toHaveBeenCalled();
  });

  it("includes the managed-comment marker in the comment body", async () => {
    const run = makeRun();
    const deps = makeDeps();
    linearMocks.createLinearComment.mockReturnValue(Effect.succeed({ id: "c1", url: null }));

    await runEffect(
      upsertManagedComment(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        planMarkdown: null,
        statusLine: "Planning",
      }),
    );

    const call = linearMocks.createLinearComment.mock.calls[0]?.[0] as Record<string, string>;
    expect(call.body).toContain(MANAGED_COMMENT_MARKER);
  });

  it("returns the original run and emits a warning event when API call fails", async () => {
    const run = makeRun();
    const deps = makeDeps();
    linearMocks.createLinearComment.mockReturnValue(Effect.fail(new Error("Linear API error")));

    const result = await runEffect(
      upsertManagedComment(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        planMarkdown: null,
        statusLine: "Planning",
      }),
    );

    expect(result).toBe(run);
    expect(deps.emitProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "linear.progress-warning" }),
    );
  });

  it("returns the original run when no API key is configured", async () => {
    const run = makeRun();
    const deps = makeDeps("");
    deps.readLinearApiKey.mockReturnValue(Effect.succeed(null));

    const result = await runEffect(
      upsertManagedComment(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        planMarkdown: null,
        statusLine: "Planning",
      }),
    );

    expect(result).toBe(run);
    expect(linearMocks.createLinearComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// transitionLinearState
// ---------------------------------------------------------------------------

describe("transitionLinearState", () => {
  const baseIssue = {
    issue: { id: "issue-id-1", identifier: "APP-1", title: "Test" },
    team: { id: "team-1" },
    state: { id: "state-todo", name: "To Do" },
  };

  it("calls updateLinearIssueState with the target state name", async () => {
    const run = makeRun();
    const deps = makeDeps();
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(Effect.succeed([baseIssue]));
    linearMocks.updateLinearIssueState.mockReturnValue(
      Effect.succeed({ changed: true, stateId: "state-in-progress", stateName: "In Progress" }),
    );

    await runEffect(
      transitionLinearState(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        stateName: "In Progress",
        reason: "test",
      }),
    );

    expect(linearMocks.updateLinearIssueState).toHaveBeenCalledOnce();
    expect(linearMocks.updateLinearIssueState).toHaveBeenCalledWith(
      expect.objectContaining({ stateName: "In Progress" }),
    );
  });

  it("emits a state-updated event when the state changes", async () => {
    const run = makeRun();
    const deps = makeDeps();
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(Effect.succeed([baseIssue]));
    linearMocks.updateLinearIssueState.mockReturnValue(
      Effect.succeed({ changed: true, stateId: "state-in-progress", stateName: "In Progress" }),
    );

    await runEffect(
      transitionLinearState(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        stateName: "In Progress",
        reason: "planning-started",
      }),
    );

    expect(deps.emitProjectEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: "linear.state-updated" }),
    );
  });

  it("does not emit an event when the state did not change", async () => {
    const run = makeRun();
    const deps = makeDeps();
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(Effect.succeed([baseIssue]));
    linearMocks.updateLinearIssueState.mockReturnValue(
      Effect.succeed({ changed: false, stateId: "state-todo", stateName: "To Do" }),
    );

    await runEffect(
      transitionLinearState(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        stateName: "To Do",
        reason: "no-change",
      }),
    );

    expect(deps.emitProjectEvent).not.toHaveBeenCalled();
  });

  it("is a no-op when stateName is null", async () => {
    const run = makeRun();
    const deps = makeDeps();

    await runEffect(
      transitionLinearState(deps, {
        projectId: ProjectId.make("project-1"),
        workflow: makeWorkflow(),
        run,
        stateName: null,
        reason: "noop",
      }),
    );

    expect(deps.readLinearApiKey).not.toHaveBeenCalled();
    expect(linearMocks.fetchLinearIssuesByIds).not.toHaveBeenCalled();
  });

  it("returns void and does not throw when API call fails", async () => {
    const run = makeRun();
    const deps = makeDeps();
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(Effect.fail(new Error("Linear API error")));

    await expect(
      runEffect(
        transitionLinearState(deps, {
          projectId: ProjectId.make("project-1"),
          workflow: makeWorkflow(),
          run,
          stateName: "In Progress",
          reason: "test",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
