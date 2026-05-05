import { describe, expect, it } from "vitest";

import { decideSchedulerActions, type SchedulerInput } from "./scheduler.ts";

function makeIssue(id: string, state: string): SchedulerInput["candidates"][number] {
  return {
    id,
    identifier: `ISS-${id}`,
    title: `Issue ${id}`,
    state,
  };
}

function makeRun(
  issueId: string,
  status: SchedulerInput["existingRuns"][number]["status"],
  archivedAt: string | null = null,
  lastSeenLinearState: string | null = null,
): SchedulerInput["existingRuns"][number] {
  return {
    runId: `run_${issueId}`,
    issueId,
    status,
    archivedAt,
    lastSeenLinearState,
  };
}

describe("scheduler.decideSchedulerActions", () => {
  it("creates fresh runs for issues with no existing run", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [],
      intakeStates: ["Todo", "To Do"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([{ issueId: "1", linearState: "Todo" }]);
    expect(result.archive).toEqual([]);
    expect(result.updateLastSeen).toEqual([]);
  });

  it("does not create when capacity is full", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 3,
    });
    expect(result.create).toEqual([]);
  });

  it("does not re-engage a failed run that has been continuously in intake", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [makeRun("1", "failed", null, "Todo")],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([]);
    expect(result.archive).toEqual([]);
    expect(result.updateLastSeen).toEqual([{ runId: "run_1", linearState: "Todo" }]);
  });

  it("re-engages a failed run when issue transitions back into intake", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [makeRun("1", "failed", null, "Done")],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([{ issueId: "1", linearState: "Todo" }]);
    expect(result.archive).toEqual([{ runId: "run_1" }]);
  });

  it("creates a fresh run for an archived completed issue moved back to intake", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [makeRun("1", "completed", "2026-05-03T10:00:00.000Z", "Done")],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([{ issueId: "1", linearState: "Todo" }]);
    expect(result.archive).toEqual([]);
  });

  it("is no-op when there is already an active run for the issue", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "In Progress")],
      existingRuns: [makeRun("1", "implementing", null, "Todo")],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 1,
    });
    expect(result.create).toEqual([]);
    expect(result.archive).toEqual([]);
    expect(result.updateLastSeen).toEqual([{ runId: "run_1", linearState: "In Progress" }]);
  });

  it("creates a run when lastSeenLinearState is null (no history)", () => {
    // null means no history — treated as "newly seen", allow creation
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [makeRun("1", "failed", null, null)],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([{ issueId: "1", linearState: "Todo" }]);
    expect(result.archive).toEqual([{ runId: "run_1" }]);
  });

  it("does not create when capacity is consumed by running count", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo"), makeIssue("2", "Todo")],
      existingRuns: [],
      intakeStates: ["Todo"],
      capacity: 1,
      runningCount: 0,
    });
    // Only one can fit
    expect(result.create).toHaveLength(1);
    expect(result.create[0]?.issueId).toBe("1");
  });

  it("in-review runs are treated as active (no re-create)", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [makeRun("1", "in-review", null, null)],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 1,
    });
    expect(result.create).toEqual([]);
    expect(result.archive).toEqual([]);
    expect(result.updateLastSeen).toEqual([{ runId: "run_1", linearState: "Todo" }]);
  });
});
