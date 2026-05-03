import { describe, expect, it } from "vitest";

import { decideArchive, type ReconcilerInput } from "./reconciler.ts";

function makeRun(overrides: Partial<ReconcilerInput["run"]>): ReconcilerInput["run"] {
  return {
    runId: "run_1",
    issueId: "iss_1",
    status: "in-review",
    archivedAt: null,
    lastSeenLinearState: "In Review",
    ...overrides,
  };
}

describe("reconciler.decideArchive", () => {
  it("archives when Linear state matches done", () => {
    const result = decideArchive({
      run: makeRun({}),
      linearState: "Done",
      doneStates: ["Done"],
      canceledStates: ["Canceled"],
    });
    expect(result).toEqual({
      archive: true,
      newStatus: "completed",
      reason: "linear_done",
    });
  });

  it("archives when Linear state matches canceled", () => {
    const result = decideArchive({
      run: makeRun({}),
      linearState: "Canceled",
      doneStates: ["Done"],
      canceledStates: ["Canceled", "Cancelled"],
    });
    expect(result).toEqual({
      archive: true,
      newStatus: "canceled",
      reason: "linear_canceled",
    });
  });

  it("returns no-op when run is already archived", () => {
    const result = decideArchive({
      run: makeRun({ archivedAt: "2026-05-03T10:00:00.000Z" }),
      linearState: "Done",
      doneStates: ["Done"],
      canceledStates: ["Canceled"],
    });
    expect(result).toEqual({ archive: false, reason: "already_archived" });
  });

  it("returns no-op when Linear state is not terminal", () => {
    const result = decideArchive({
      run: makeRun({ status: "in-review" }),
      linearState: "In Review",
      doneStates: ["Done"],
      canceledStates: ["Canceled"],
    });
    expect(result).toEqual({ archive: false, reason: "not_terminal" });
  });

  it("classifies as completed when state appears in both done and canceled lists (done wins)", () => {
    const result = decideArchive({
      run: makeRun({}),
      linearState: "Both",
      doneStates: ["Both"],
      canceledStates: ["Both"],
    });
    expect(result).toEqual({
      archive: true,
      newStatus: "completed",
      reason: "linear_done",
    });
  });

  it("returns not_terminal when linearState is empty string", () => {
    const result = decideArchive({
      run: makeRun({}),
      linearState: "",
      doneStates: ["Done"],
      canceledStates: ["Canceled"],
    });
    expect(result).toEqual({ archive: false, reason: "not_terminal" });
  });

  it("returns not_terminal when state lists are empty", () => {
    const result = decideArchive({
      run: makeRun({}),
      linearState: "Done",
      doneStates: [],
      canceledStates: [],
    });
    expect(result).toEqual({ archive: false, reason: "not_terminal" });
  });
});
