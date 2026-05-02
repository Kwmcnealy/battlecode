import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  SymphonyCloudTask,
  SymphonyRun,
  SymphonySnapshot,
  SymphonySettings,
  SymphonyUpdateExecutionDefaultInput,
  SymphonyWorkflowConfig,
  SYMPHONY_WS_METHODS,
} from "./symphony.ts";
import { ProjectId } from "./baseSchemas.ts";

describe("Symphony contracts", () => {
  it("decodes workflow config with spec defaults", () => {
    const config = Schema.decodeUnknownSync(SymphonyWorkflowConfig)({
      tracker: {
        kind: "linear",
        projectSlug: "battlecode",
      },
    });

    expect(config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(config.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(config.tracker.terminalStates).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
    expect(config.polling.intervalMs).toBe(30_000);
    expect(config.agent.maxConcurrentAgents).toBe(10);
    expect("codex" in config).toBe(false);
    expect("apiKeyRef" in config.tracker).toBe(false);
    expect("assignee" in config.tracker).toBe(false);
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
        pendingTarget: [],
        eligible: [],
        running: [],
        retrying: [],
        completed: [],
        failed: [],
        canceled: [],
      },
      totals: {
        pendingTarget: 0,
        eligible: 0,
        running: 0,
        retrying: 0,
        completed: 0,
        failed: 0,
        canceled: 0,
      },
      events: [],
      updatedAt: "2026-04-30T12:00:00.000Z",
    });

    expect(snapshot.status).toBe("setup-blocked");
  });

  it("accepts Symphony execution target and Codex Cloud task metadata", () => {
    const cloudTask = Schema.decodeUnknownSync(SymphonyCloudTask)({
      provider: "codex-cloud-linear",
      status: "submitted",
      taskUrl: null,
      linearCommentId: "comment-1",
      linearCommentUrl: "https://linear.app/t3/issue/APP-1#comment-comment-1",
      repository: "openai/codex",
      repositoryUrl: "https://github.com/openai/codex",
      lastMessage: "No suitable environment or repository is available.",
      delegatedAt: "2026-04-30T12:00:00.000Z",
      lastCheckedAt: "2026-04-30T12:00:00.000Z",
    });
    expect(
      Schema.decodeUnknownSync(SymphonyCloudTask)({
        provider: "codex-cloud-linear",
        status: "submitted",
        taskUrl: null,
        linearCommentId: "comment-1",
        delegatedAt: "2026-04-30T12:00:00.000Z",
        lastCheckedAt: "2026-04-30T12:00:00.000Z",
      }).linearCommentUrl,
    ).toBeNull();
    const run = Schema.decodeUnknownSync(SymphonyRun)({
      runId: "run-1",
      projectId: ProjectId.make("project-symphony"),
      issue: {
        id: "issue-1",
        identifier: "BC-123",
        title: "Implement local and cloud routing",
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
      status: "cloud-submitted",
      workspacePath: null,
      branchName: null,
      threadId: null,
      prUrl: null,
      executionTarget: "codex-cloud",
      cloudTask,
      attempts: [],
      nextRetryAt: null,
      lastError: null,
      createdAt: "2026-04-30T12:00:00.000Z",
      updatedAt: "2026-04-30T12:00:00.000Z",
    });

    expect(run.executionTarget).toBe("codex-cloud");
    expect(run.cloudTask?.provider).toBe("codex-cloud-linear");
    expect(run.status).toBe("cloud-submitted");
  });

  it("accepts execution default updates", () => {
    const input = Schema.decodeUnknownSync(SymphonyUpdateExecutionDefaultInput)({
      projectId: ProjectId.make("project-symphony"),
      target: "codex-cloud",
    });

    expect(input.target).toBe("codex-cloud");
  });

  it("declares websocket method names under the symphony namespace", () => {
    expect(SYMPHONY_WS_METHODS.getSettings).toBe("symphony.getSettings");
    expect(SYMPHONY_WS_METHODS.setLinearApiKey).toBe("symphony.setLinearApiKey");
    expect(SYMPHONY_WS_METHODS.subscribe).toBe("symphony.subscribe");
    expect(SYMPHONY_WS_METHODS.launchIssue).toBe("symphony.launchIssue");
    expect(SYMPHONY_WS_METHODS.updateExecutionDefault).toBe("symphony.updateExecutionDefault");
    expect(SYMPHONY_WS_METHODS.refreshCloudStatus).toBe("symphony.refreshCloudStatus");
    expect("applyLinearMutation" in SYMPHONY_WS_METHODS).toBe(false);
  });
});
