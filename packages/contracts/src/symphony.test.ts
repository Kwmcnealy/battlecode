import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  SymphonySnapshot,
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
    expect(config.codex.threadSandbox).toBe("workspace-write");
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
        eligible: [],
        running: [],
        retrying: [],
        completed: [],
        failed: [],
        canceled: [],
      },
      totals: {
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

  it("declares websocket method names under the symphony namespace", () => {
    expect(SYMPHONY_WS_METHODS.getSettings).toBe("symphony.getSettings");
    expect(SYMPHONY_WS_METHODS.setLinearApiKey).toBe("symphony.setLinearApiKey");
    expect(SYMPHONY_WS_METHODS.subscribe).toBe("symphony.subscribe");
  });
});
