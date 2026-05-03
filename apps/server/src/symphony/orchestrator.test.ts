import { describe, expect, it } from "vitest";

import { decideNextAction, type OrchestratorInput } from "./orchestrator.ts";

function makeRun(overrides: Partial<OrchestratorInput["run"]>): OrchestratorInput["run"] {
  return {
    runId: "run_1",
    issueId: "iss_1",
    status: "running",
    lifecyclePhase: "planning",
    archivedAt: null,
    lastSeenLinearState: "In Progress",
    ...overrides,
  };
}

describe("orchestrator.decideNextAction", () => {
  it("transitions planning -> implementing when plan markers found", () => {
    const result = decideNextAction({
      run: makeRun({ lifecyclePhase: "planning" }),
      threadOutput: "SYMPHONY_PLAN_BEGIN\n- [ ] Step 1\nSYMPHONY_PLAN_END",
      threadComplete: true,
    });
    expect(result).toEqual({
      action: "advance-to-implementing",
      plan: ["Step 1"],
    });
  });

  it("fails the run when planning ends with no plan markers", () => {
    const result = decideNextAction({
      run: makeRun({ lifecyclePhase: "planning" }),
      threadOutput: "I implemented something but forgot the plan.",
      threadComplete: true,
    });
    expect(result).toEqual({
      action: "fail",
      reason: "no_parseable_plan",
    });
  });

  it("transitions implementing -> in-review when PR URL marker found", () => {
    const result = decideNextAction({
      run: makeRun({ lifecyclePhase: "implementing" }),
      threadOutput: "Done!\nSYMPHONY_PR_URL: https://github.com/owner/repo/pull/42",
      threadComplete: true,
    });
    expect(result).toEqual({
      action: "advance-to-in-review",
      prUrl: "https://github.com/owner/repo/pull/42",
    });
  });

  it("fails the run when implementing ends with no PR URL", () => {
    const result = decideNextAction({
      run: makeRun({ lifecyclePhase: "implementing" }),
      threadOutput: "I tried but couldn't.",
      threadComplete: true,
    });
    expect(result).toEqual({
      action: "fail",
      reason: "no_pr_url",
    });
  });

  it("returns no-op while turn is still streaming", () => {
    const result = decideNextAction({
      run: makeRun({ lifecyclePhase: "planning" }),
      threadOutput: "SYMPHONY_PLAN_BEGIN\n- [ ] partial...",
      threadComplete: false,
    });
    expect(result).toEqual({ action: "wait", reason: "turn_streaming" });
  });

  it("returns wait for unrecognized phase", () => {
    const result = decideNextAction({
      run: makeRun({ lifecyclePhase: "reviewing" }),
      threadOutput: "some output",
      threadComplete: true,
    });
    expect(result).toEqual({ action: "wait", reason: "unrecognized_status" });
  });
});
