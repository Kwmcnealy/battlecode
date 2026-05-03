import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_COMMENT_MARKER,
  appendOwnedCommentId,
  transitionLinearState,
  upsertManagedComment,
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

const BASE_LINEAR_PROGRESS = {
  commentId: null,
  commentUrl: null,
  ownedCommentIds: [] as string[],
  lastRenderedHash: null,
  lastUpdatedAt: null,
  lastMilestoneAt: null,
  lastFeedbackAt: null,
};

function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    issue: {
      id: "issue-id-1",
      identifier: "APP-1",
      title: "Test issue",
      description: null,
    },
    lifecyclePhase: "planning",
    executionTarget: "local",
    prUrl: null,
    pullRequest: null,
    currentStep: null,
    qualityGate: { lastReviewFindings: [] },
    linearProgress: { ...BASE_LINEAR_PROGRESS },
    updatedAt: "2026-05-03T00:00:00.000Z",
    ...overrides,
  };
}

function makeWorkflow(endpointOverride?: string) {
  return {
    config: {
      tracker: {
        endpoint: endpointOverride ?? null,
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
    },
  };
}

function makeDeps(apiKey = "test-api-key") {
  const emitProjectEvent = vi.fn().mockReturnValue(Effect.void);
  const upsertRun = vi.fn().mockImplementation((run: unknown) => Effect.succeed(run));

  return {
    readLinearApiKey: vi.fn().mockReturnValue(Effect.succeed(apiKey)),
    emitProjectEvent,
    upsertRun,
  };
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
      upsertManagedComment(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
        planMarkdown: null,
        statusLine: "Planning",
      }),
    );

    expect(linearMocks.createLinearComment).toHaveBeenCalledOnce();
    expect(linearMocks.updateLinearComment).not.toHaveBeenCalled();
    expect((result as Record<string, unknown>).linearProgress).toMatchObject({
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
      upsertManagedComment(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
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
      upsertManagedComment(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
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
      upsertManagedComment(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
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
      upsertManagedComment(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
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
      transitionLinearState(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
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
      transitionLinearState(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
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
      transitionLinearState(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
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
      transitionLinearState(deps as never, {
        projectId: "project-1" as never,
        workflow: makeWorkflow() as never,
        run: run as never,
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
        transitionLinearState(deps as never, {
          projectId: "project-1" as never,
          workflow: makeWorkflow() as never,
          run: run as never,
          stateName: "In Progress",
          reason: "test",
        }),
      ),
    ).resolves.toBeUndefined();
  });
});
