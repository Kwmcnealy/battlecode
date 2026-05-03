import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  DEFAULT_SYMPHONY_REVIEW_PROMPT,
  DEFAULT_SYMPHONY_SIMPLIFICATION_PROMPT,
  SymphonyLinearProgressComment,
  SymphonyPullRequestSummary,
  SymphonyQualityGateState,
  SymphonyIssueActionInput,
  SymphonyRun,
  SymphonyRunProgress,
  SymphonySnapshot,
  SymphonySnapshotDiagnostics,
  SymphonySettings,
  SymphonyWorkflowConfig,
  SYMPHONY_WS_METHODS,
} from "./symphony.ts";
import { ProjectId } from "./baseSchemas.ts";

describe("Symphony contracts", () => {
  it("decodes workflow config with spec defaults", () => {
    const config = Schema.decodeUnknownSync(SymphonyWorkflowConfig)({
      tracker: {
        kind: "linear",
        projectSlugId: "battlecode",
      },
    });

    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.tracker.intakeStates).toEqual(["To Do", "Todo"]);
    expect(config.tracker.activeStates).toEqual(["In Progress"]);
    expect(config.tracker.terminalStates).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
    expect(config.tracker.reviewStates).toEqual(["In Review", "Review"]);
    expect(config.tracker.doneStates).toEqual(["Done", "Closed"]);
    expect(config.tracker.canceledStates).toEqual(["Canceled", "Cancelled"]);
    expect(config.tracker.transitionStates).toEqual({
      started: "In Progress",
      review: "In Review",
      done: "Done",
      canceled: "Canceled",
    });
    expect(config.pullRequest).toEqual({ baseBranch: null });
    expect(config.quality).toEqual({
      maxReviewFixLoops: 1,
      simplificationPrompt: DEFAULT_SYMPHONY_SIMPLIFICATION_PROMPT,
      reviewPrompt: DEFAULT_SYMPHONY_REVIEW_PROMPT,
    });
    expect(config.polling.schedulerIntervalMs).toBe(30_000);
    expect(config.polling.reconcilerIntervalMs).toBe(60_000);
    expect(config.polling.jitter).toBe(0.1);
    expect(config.concurrency.max).toBe(3);
    expect(config.stall.timeoutMs).toBe(300_000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect(config.codex.runtimeMode).toBe("full-access");
    expect("apiKeyRef" in config.tracker).toBe(false);
    expect("assignee" in config.tracker).toBe(false);
  });

  it("decodes workflow config with explicit lifecycle states and codex runtime", () => {
    const config = Schema.decodeUnknownSync(SymphonyWorkflowConfig)({
      tracker: {
        kind: "linear",
        projectSlugId: "battlecode",
        intakeStates: ["Queued", "Ready"],
        activeStates: ["Todo", "In Progress", "Rework", "Merging"],
        reviewStates: ["Human Review"],
        doneStates: ["Done", "Closed"],
        canceledStates: ["Canceled", "Cancelled"],
        transitionStates: {
          started: "In Progress",
          review: "Human Review",
          done: "Done",
          canceled: "Canceled",
        },
      },
      codex: {
        runtimeMode: "full-access",
      },
      pullRequest: {
        baseBranch: "development",
      },
      quality: {
        maxReviewFixLoops: 2,
        simplificationPrompt: "Simplify only this branch.",
        reviewPrompt: "Return REVIEW_PASS or REVIEW_FAIL.",
      },
    });

    expect(config.tracker.intakeStates).toEqual(["Queued", "Ready"]);
    expect(config.tracker.reviewStates).toEqual(["Human Review"]);
    expect(config.tracker.doneStates).toEqual(["Done", "Closed"]);
    expect(config.tracker.canceledStates).toEqual(["Canceled", "Cancelled"]);
    expect(config.tracker.transitionStates).toEqual({
      started: "In Progress",
      review: "Human Review",
      done: "Done",
      canceled: "Canceled",
    });
    expect(config.codex.runtimeMode).toBe("full-access");
    expect(config.pullRequest).toEqual({ baseBranch: "development" });
    expect(config.quality).toEqual({
      maxReviewFixLoops: 2,
      simplificationPrompt: "Simplify only this branch.",
      reviewPrompt: "Return REVIEW_PASS or REVIEW_FAIL.",
    });
  });

  it("decodes lifecycle metadata with empty-object defaults", () => {
    expect(Schema.decodeUnknownSync(SymphonyLinearProgressComment)({})).toEqual({
      commentId: null,
      commentUrl: null,
      ownedCommentIds: [],
      lastRenderedHash: null,
      lastUpdatedAt: null,
      lastMilestoneAt: null,
      lastFeedbackAt: null,
    });
    expect(Schema.decodeUnknownSync(SymphonyQualityGateState)({})).toEqual({
      reviewFixLoops: 0,
      lastReviewPassedAt: null,
      lastReviewSummary: null,
      lastReviewFindings: [],
      lastReviewedCommit: null,
      lastFixCommit: null,
      lastPublishedCommit: null,
      lastFeedbackFingerprint: null,
    });
  });

  it("creates project-scoped settings without exposing secret material", () => {
    const projectId = ProjectId.make("project-symphony");
    const settings = Schema.decodeUnknownSync(SymphonySettings)({
      projectId,
      workflowPath: "/repo/battlecode/WORKFLOW.md",
      workflowStatus: {
        status: "missing",
        message: "No workflow found",
        validatedAt: null,
        configHash: null,
      },
      linearSecret: {
        source: "missing",
        configured: false,
        lastTestedAt: null,
        lastError: null,
      },
      updatedAt: "2026-04-30T12:00:00.000Z",
    });

    expect(Schema.is(SymphonySettings)(settings)).toBe(true);
    expect(settings.workflowPath).toBe("/repo/battlecode/WORKFLOW.md");
    expect(settings.linearSecret.source).toBe("missing");
    expect(JSON.stringify(settings)).not.toContain("lin_api_");
  });

  it("accepts a setup-blocked dashboard snapshot", () => {
    const snapshot = Schema.decodeUnknownSync(SymphonySnapshot)({
      projectId: ProjectId.make("project-symphony"),
      status: "setup-blocked",
      settings: {
        projectId: ProjectId.make("project-symphony"),
        workflowPath: "/repo/battlecode/WORKFLOW.md",
        workflowStatus: {
          status: "missing",
          message: "No workflow found",
          validatedAt: null,
          configHash: null,
        },
        linearSecret: {
          source: "missing",
          configured: false,
          lastTestedAt: null,
          lastError: null,
        },
        updatedAt: "2026-04-30T12:00:00.000Z",
      },
      queues: {
        intake: [],
        planning: [],
        implementing: [],
        "in-review": [],
        completed: [],
        failed: [],
        canceled: [],
        archived: [],
      },
      totals: {
        intake: 0,
        planning: 0,
        implementing: 0,
        "in-review": 0,
        completed: 0,
        failed: 0,
        canceled: 0,
        archived: 0,
      },
      events: [],
      updatedAt: "2026-04-30T12:00:00.000Z",
    });

    expect(snapshot.status).toBe("setup-blocked");
    expect(snapshot.diagnostics).toEqual({
      lastPollAt: null,
      queriedStates: [],
      candidateCount: null,
      warningSummary: {
        count: 0,
        latestMessage: null,
      },
      errorSummary: {
        count: 0,
        latestMessage: null,
      },
    });
  });

  it("decodes optional dashboard diagnostics", () => {
    expect(Schema.decodeUnknownSync(SymphonySnapshotDiagnostics)({})).toEqual({
      lastPollAt: null,
      queriedStates: [],
      candidateCount: null,
      warningSummary: {
        count: 0,
        latestMessage: null,
      },
      errorSummary: {
        count: 0,
        latestMessage: null,
      },
    });

    const diagnostics = Schema.decodeUnknownSync(SymphonySnapshotDiagnostics)({
      lastPollAt: "2026-05-02T12:01:00.000Z",
      queriedStates: ["Todo", "In Progress"],
      candidateCount: 12,
      warningSummary: {
        count: 2,
        latestMessage: "Linear lookup warning",
      },
      errorSummary: {
        count: 1,
        latestMessage: "Workflow invalid",
      },
    });

    expect(diagnostics.lastPollAt).toBe("2026-05-02T12:01:00.000Z");
    expect(diagnostics.queriedStates).toEqual(["Todo", "In Progress"]);
    expect(diagnostics.candidateCount).toBe(12);
    expect(diagnostics.warningSummary.latestMessage).toBe("Linear lookup warning");
    expect(diagnostics.errorSummary.count).toBe(1);
  });

  it("accepts a local run with defaults", () => {
    const run = Schema.decodeUnknownSync(SymphonyRun)({
      runId: "run-1",
      projectId: ProjectId.make("project-symphony"),
      issue: {
        id: "issue-1",
        identifier: "BC-123",
        title: "Implement local routing",
        description: null,
        priority: null,
        state: "Todo",
        branchName: null,
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
      status: "intake",
      workspacePath: null,
      branchName: null,
      threadId: null,
      prUrl: null,
      attempts: [],
      nextRetryAt: null,
      lastError: null,
      createdAt: "2026-04-30T12:00:00.000Z",
      updatedAt: "2026-04-30T12:00:00.000Z",
    });

    expect(run.status).toBe("intake");
    expect(run.linearProgress).toEqual({
      commentId: null,
      commentUrl: null,
      ownedCommentIds: [],
      lastRenderedHash: null,
      lastUpdatedAt: null,
      lastMilestoneAt: null,
      lastFeedbackAt: null,
    });
    expect(run.qualityGate).toEqual({
      reviewFixLoops: 0,
      lastReviewPassedAt: null,
      lastReviewSummary: null,
      lastReviewFindings: [],
      lastReviewedCommit: null,
      lastFixCommit: null,
      lastPublishedCommit: null,
      lastFeedbackFingerprint: null,
    });
    expect(run.pullRequest).toBeNull();
    expect(run.currentStep).toBeNull();
    expect(run.archivedAt).toBeNull();
  });

  it("accepts review-ready runs with PR summaries and progress details", () => {
    const pullRequest = Schema.decodeUnknownSync(SymphonyPullRequestSummary)({
      number: 42,
      title: "Implement Symphony lifecycle",
      url: "https://github.com/t3/battlecode/pull/42",
      baseBranch: "development",
      headBranch: "symphony/app-42",
      state: "open",
      updatedAt: "2026-05-02T12:00:00.000Z",
    });
    const currentStep = Schema.decodeUnknownSync(SymphonyRunProgress)({
      source: "github",
      label: "Pull request open",
      detail: "Waiting for review or merge.",
      updatedAt: "2026-05-02T12:00:00.000Z",
    });

    const run = Schema.decodeUnknownSync(SymphonyRun)({
      runId: "run-2",
      projectId: ProjectId.make("project-symphony"),
      issue: {
        id: "issue-2",
        identifier: "BC-456",
        title: "Track PR lifecycle",
        description: null,
        priority: null,
        state: "In Review",
        branchName: null,
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
      status: "in-review",
      workspacePath: "/repo/.worktrees/symphony/app-456",
      branchName: "symphony/app-456",
      threadId: null,
      prUrl: pullRequest.url,
      pullRequest,
      currentStep,
      attempts: [],
      nextRetryAt: null,
      lastError: null,
      createdAt: "2026-05-02T12:00:00.000Z",
      updatedAt: "2026-05-02T12:00:00.000Z",
    });

    expect(run.status).toBe("in-review");
    expect(run.pullRequest?.state).toBe("open");
    expect(run.currentStep?.source).toBe("github");
  });

  it("decodes archived completed runs as completed with archive metadata", () => {
    const snapshot = Schema.decodeUnknownSync(SymphonySnapshot)({
      projectId: ProjectId.make("project-symphony"),
      status: "idle",
      settings: {
        projectId: ProjectId.make("project-symphony"),
        workflowPath: "/repo/battlecode/WORKFLOW.md",
        workflowStatus: {
          status: "valid",
          message: null,
          validatedAt: "2026-05-02T12:00:00.000Z",
          configHash: "hash-1",
        },
        linearSecret: {
          source: "stored",
          configured: true,
          lastTestedAt: null,
          lastError: null,
        },
        updatedAt: "2026-05-02T12:00:00.000Z",
      },
      queues: {
        intake: [],
        planning: [],
        implementing: [],
        "in-review": [],
        completed: [],
        failed: [],
        canceled: [],
        archived: [
          {
            runId: "run-archived",
            projectId: ProjectId.make("project-symphony"),
            issue: {
              id: "issue-archived",
              identifier: "BC-789",
              title: "Archive completed run",
              description: null,
              priority: null,
              state: "Done",
              branchName: null,
              url: null,
              labels: [],
              blockedBy: [],
              createdAt: null,
              updatedAt: null,
            },
            status: "completed",
            workspacePath: null,
            branchName: "symphony/bc-789",
            threadId: null,
            prUrl: "https://github.com/t3/battlecode/pull/789",
            pullRequest: {
              number: 789,
              title: "Archive completed run",
              url: "https://github.com/t3/battlecode/pull/789",
              baseBranch: "development",
              headBranch: "symphony/bc-789",
              state: "merged",
              updatedAt: "2026-05-02T12:20:00.000Z",
            },
            currentStep: {
              source: "github",
              label: "Pull request merged",
              detail: "#789 Archive completed run",
              updatedAt: "2026-05-02T12:20:00.000Z",
            },
            archivedAt: "2026-05-02T12:21:00.000Z",
            attempts: [],
            nextRetryAt: null,
            lastError: null,
            createdAt: "2026-05-02T12:00:00.000Z",
            updatedAt: "2026-05-02T12:21:00.000Z",
          },
        ],
      },
      totals: {
        intake: 0,
        planning: 0,
        implementing: 0,
        "in-review": 0,
        completed: 0,
        failed: 0,
        canceled: 0,
        archived: 1,
      },
      events: [],
      updatedAt: "2026-05-02T12:22:00.000Z",
    });

    expect(snapshot.queues.archived).toHaveLength(1);
    expect(snapshot.queues.archived[0]?.status).toBe("completed");
    expect(snapshot.queues.archived[0]?.archivedAt).toBe("2026-05-02T12:21:00.000Z");
    expect(snapshot.totals.archived).toBe(1);
  });

  it("accepts archive issue action input", () => {
    const input = Schema.decodeUnknownSync(SymphonyIssueActionInput)({
      projectId: ProjectId.make("project-symphony"),
      issueId: "issue-archive",
    });

    expect(input.issueId).toBe("issue-archive");
  });

  it("declares websocket method names under the symphony namespace", () => {
    expect(SYMPHONY_WS_METHODS.getSettings).toBe("symphony.getSettings");
    expect(SYMPHONY_WS_METHODS.setLinearApiKey).toBe("symphony.setLinearApiKey");
    expect(SYMPHONY_WS_METHODS.subscribe).toBe("symphony.subscribe");
    expect(SYMPHONY_WS_METHODS.launchIssue).toBe("symphony.launchIssue");
    expect(SYMPHONY_WS_METHODS.archiveIssue).toBe("symphony.archiveIssue");
    expect("refreshCloudStatus" in SYMPHONY_WS_METHODS).toBe(false);
    expect("updateExecutionDefault" in SYMPHONY_WS_METHODS).toBe(false);
    expect("applyLinearMutation" in SYMPHONY_WS_METHODS).toBe(false);
  });
});
