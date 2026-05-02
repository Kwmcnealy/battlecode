import {
  ProjectId,
  SymphonyIssueId,
  type OrchestrationThread,
  type SymphonyIssue,
  type SymphonyPullRequestSummary,
  type SymphonyRun,
  type SymphonyWorkflowConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { makeRun } from "./runModel.ts";
import { resolveRunLifecycle } from "./runLifecycle.ts";

const PROJECT_ID = ProjectId.make("project-symphony");
const CREATED_AT = "2026-05-02T12:00:00.000Z";

const CONFIG: SymphonyWorkflowConfig = {
  tracker: {
    kind: "linear",
    endpoint: "https://linear.example/graphql",
    projectSlug: "battlecode",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done", "Closed", "Canceled"],
    reviewStates: ["In Review"],
    doneStates: ["Done"],
    canceledStates: ["Canceled"],
    transitionStates: {
      started: "In Progress",
      review: "In Review",
      done: "Done",
      canceled: "Canceled",
    },
  },
  polling: { intervalMs: 30_000 },
  workspace: { root: "" },
  hooks: { timeoutMs: 60_000 },
  agent: {
    maxConcurrentAgents: 3,
    maxTurns: 20,
    maxRetryBackoffMs: 300_000,
  },
  codex: { runtimeMode: "full-access" },
};

function makeIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
  return {
    id: SymphonyIssueId.make("issue-1"),
    identifier: "APP-1",
    title: "Fix dashboard",
    description: null,
    priority: null,
    state: "In Progress",
    branchName: null,
    url: "https://linear.app/t3/issue/APP-1",
    labels: [],
    blockedBy: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeLifecycleRun(overrides: Partial<SymphonyRun> = {}): SymphonyRun {
  return {
    ...makeRun(PROJECT_ID, makeIssue(), CREATED_AT),
    status: "running",
    executionTarget: "local",
    ...overrides,
  };
}

function makeThread(
  latestTurn: NonNullable<OrchestrationThread["latestTurn"]>,
): Pick<OrchestrationThread, "latestTurn" | "activities" | "session"> {
  return {
    latestTurn,
    activities: [],
    session: null,
  };
}

function makeCompletedThread(): Pick<OrchestrationThread, "latestTurn" | "activities" | "session"> {
  return makeThread({
    turnId: "turn-1" as never,
    state: "completed",
    requestedAt: CREATED_AT,
    startedAt: CREATED_AT,
    completedAt: "2026-05-02T12:10:00.000Z",
    assistantMessageId: null,
  });
}

function makePullRequest(state: SymphonyPullRequestSummary["state"]): SymphonyPullRequestSummary {
  return {
    number: 42,
    title: "Fix dashboard",
    url: "https://github.com/t3/battlecode/pull/42",
    baseBranch: "development",
    headBranch: "symphony/app-1",
    state,
    updatedAt: "2026-05-02T12:15:00.000Z",
  };
}

describe("Symphony run lifecycle", () => {
  it("keeps a local completed turn without PR non-terminal and actionable", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun(),
      config: CONFIG,
      thread: makeCompletedThread(),
    });

    expect(result.status).toBe("running");
    expect(result.currentStep.label).toBe("Turn completed; waiting for PR or Linear review");
  });

  it("marks a local run review-ready when its PR is open", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun(),
      config: CONFIG,
      thread: makeCompletedThread(),
      pullRequest: makePullRequest("open"),
    });

    expect(result.status).toBe("review-ready");
    expect(result.currentStep.source).toBe("github");
  });

  it("marks a run completed when its PR is merged", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun(),
      config: CONFIG,
      thread: makeCompletedThread(),
      pullRequest: makePullRequest("merged"),
    });

    expect(result.status).toBe("completed");
    expect(result.currentStep.label).toBe("Pull request merged");
  });

  it("keeps submitted cloud runs in cloud-submitted", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun({
        status: "cloud-submitted",
        executionTarget: "codex-cloud",
        cloudTask: {
          provider: "codex-cloud-linear",
          status: "submitted",
          taskUrl: null,
          linearCommentId: "comment-1",
          linearCommentUrl: "https://linear.app/t3/issue/APP-1#comment-comment-1",
          repository: "t3/battlecode",
          repositoryUrl: "https://github.com/t3/battlecode",
          lastMessage: null,
          delegatedAt: CREATED_AT,
          lastCheckedAt: CREATED_AT,
        },
      }),
      config: CONFIG,
    });

    expect(result.status).toBe("cloud-submitted");
    expect(result.currentStep.label).toBe("Waiting for Codex Cloud task");
  });

  it("moves cloud runs to cloud-running when a Codex task is detected", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun({
        status: "cloud-submitted",
        executionTarget: "codex-cloud",
        cloudTask: {
          provider: "codex-cloud-linear",
          status: "detected",
          taskUrl: "https://codex.openai.com/tasks/task-1",
          linearCommentId: "comment-1",
          linearCommentUrl: "https://linear.app/t3/issue/APP-1#comment-comment-1",
          repository: "t3/battlecode",
          repositoryUrl: "https://github.com/t3/battlecode",
          lastMessage: null,
          delegatedAt: CREATED_AT,
          lastCheckedAt: "2026-05-02T12:05:00.000Z",
        },
      }),
      config: CONFIG,
    });

    expect(result.status).toBe("cloud-running");
  });

  it("marks cloud runs review-ready when their PR opens", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun({
        status: "cloud-running",
        executionTarget: "codex-cloud",
      }),
      config: CONFIG,
      pullRequest: makePullRequest("open"),
    });

    expect(result.status).toBe("review-ready");
  });

  it("marks runs canceled from configured Linear canceled states", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun(),
      config: CONFIG,
      linear: { stateName: "Canceled", updatedAt: CREATED_AT },
    });

    expect(result.status).toBe("canceled");
    expect(result.currentStep.source).toBe("linear");
  });

  it("treats interrupted local turns as retryable failures, not canceled", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun(),
      config: CONFIG,
      thread: makeThread({
        turnId: "turn-interrupted" as never,
        state: "interrupted",
        requestedAt: CREATED_AT,
        startedAt: CREATED_AT,
        completedAt: "2026-05-02T12:10:00.000Z",
        assistantMessageId: null,
      }),
    });

    expect(result.status).toBe("failed");
    expect(result.currentStep.label).toBe("Codex turn failed");
  });

  it("marks configured Linear review states as review-ready", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun(),
      config: {
        ...CONFIG,
        tracker: {
          ...CONFIG.tracker,
          reviewStates: ["Human Review"],
        },
      },
      linear: { stateName: "Human Review", updatedAt: CREATED_AT },
    });

    expect(result.status).toBe("review-ready");
    expect(result.currentStep.label).toBe("Linear review state");
  });

  it("marks runs completed from configured Linear done states", () => {
    const result = resolveRunLifecycle({
      run: makeLifecycleRun(),
      config: CONFIG,
      linear: { stateName: "Done", updatedAt: CREATED_AT },
    });

    expect(result.status).toBe("completed");
    expect(result.currentStep.source).toBe("linear");
  });
});
