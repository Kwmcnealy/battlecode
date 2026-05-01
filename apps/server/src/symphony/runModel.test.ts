import {
  ProjectId,
  SymphonyIssueId,
  type SymphonyIssue,
  type SymphonyRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  blockerIsTerminal,
  buildIssuePrompt,
  makeRun,
  queueRuns,
  replaceLatestAttempt,
  retryIsReady,
  shouldPoll,
} from "./runModel.ts";

const PROJECT_ID = ProjectId.make("project-symphony");
const CREATED_AT = "2026-01-01T00:00:00.000Z";

function makeIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
  return {
    id: SymphonyIssueId.make("issue-1"),
    identifier: "APP-1",
    title: "Fix the dashboard",
    description: "Dashboard fails under load",
    priority: 1,
    state: "Todo",
    branchName: null,
    url: "https://linear.app/t3/issue/APP-1",
    labels: [],
    blockedBy: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function makeRunWithStatus(status: SymphonyRun["status"]): SymphonyRun {
  return {
    ...makeRun(PROJECT_ID, makeIssue({ id: SymphonyIssueId.make(`issue-${status}`) }), CREATED_AT),
    status,
  };
}

describe("Symphony run model", () => {
  it("groups runs into the dashboard queues", () => {
    const queues = queueRuns([
      makeRunWithStatus("eligible"),
      makeRunWithStatus("running"),
      makeRunWithStatus("retry-queued"),
      makeRunWithStatus("completed"),
      makeRunWithStatus("released"),
      makeRunWithStatus("failed"),
      makeRunWithStatus("canceled"),
    ]);

    expect(queues.eligible).toHaveLength(1);
    expect(queues.running).toHaveLength(1);
    expect(queues.retrying).toHaveLength(1);
    expect(queues.completed.map((run) => run.status)).toEqual(["completed", "released"]);
    expect(queues.failed).toHaveLength(1);
    expect(queues.canceled).toHaveLength(1);
  });

  it("evaluates polling and retry timers deterministically", () => {
    const now = new Date("2026-01-01T00:01:00.000Z").getTime();

    expect(shouldPoll(null, 30_000, now)).toBe(true);
    expect(shouldPoll("2026-01-01T00:00:20.000Z", 30_000, now)).toBe(true);
    expect(shouldPoll("2026-01-01T00:00:45.000Z", 30_000, now)).toBe(false);
    expect(retryIsReady("2026-01-01T00:00:59.000Z", now)).toBe(true);
    expect(retryIsReady("2026-01-01T00:01:01.000Z", now)).toBe(false);
  });

  it("renders issue prompts from workflow tokens", () => {
    const prompt = buildIssuePrompt({
      issue: makeIssue(),
      workflowPrompt: "Work on {{issue.identifier}} from {{workflow.path}} in {{workspace.path}}.",
      workflowPath: "/repo/WORKFLOW.md",
      workspacePath: "/tmp/symphony/APP-1",
      branchName: "symphony/app-1",
    });

    expect(prompt).toContain("Work on APP-1 from /repo/WORKFLOW.md in /tmp/symphony/APP-1.");
    expect(prompt).toContain("- Linear issue: APP-1 - Fix the dashboard");
    expect(prompt).toContain("- Branch: symphony/app-1");
  });

  it("updates only the latest attempt", () => {
    const run: SymphonyRun = {
      ...makeRun(PROJECT_ID, makeIssue(), CREATED_AT),
      attempts: [
        {
          attempt: 1,
          status: "streaming-turn",
          startedAt: CREATED_AT,
          completedAt: null,
          error: null,
        },
        {
          attempt: 2,
          status: "streaming-turn",
          startedAt: CREATED_AT,
          completedAt: null,
          error: null,
        },
      ],
    };

    const attempts = replaceLatestAttempt(run, {
      status: "failed",
      error: "Codex turn failed.",
    });

    expect(attempts[0]?.status).toBe("streaming-turn");
    expect(attempts[1]?.status).toBe("failed");
    expect(attempts[1]?.error).toBe("Codex turn failed.");
  });

  it("matches terminal blocker states case-insensitively", () => {
    expect(blockerIsTerminal("done", ["Done", "Closed"])).toBe(true);
    expect(blockerIsTerminal("In Progress", ["Done", "Closed"])).toBe(false);
    expect(blockerIsTerminal(null, ["Done", "Closed"])).toBe(false);
  });
});
