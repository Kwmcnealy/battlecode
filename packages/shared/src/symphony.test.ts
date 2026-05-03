import { describe, expect, it } from "vitest";
import type { SymphonyLifecyclePhase, SymphonyRunStatus } from "@t3tools/contracts";

import {
  SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
  canArchiveSymphonyRun,
  getSymphonyArchiveEligibility,
} from "./symphony.ts";

function runState(input: {
  readonly status: SymphonyRunStatus;
  readonly lifecyclePhase: SymphonyLifecyclePhase;
  readonly archivedAt?: string | null;
}) {
  return {
    status: input.status,
    lifecyclePhase: input.lifecyclePhase,
    archivedAt: input.archivedAt ?? null,
  };
}

describe("Symphony archive eligibility", () => {
  it("allows inactive runs to be manually archived", () => {
    for (const state of [
      runState({ status: "target-pending", lifecyclePhase: "intake" }),
      runState({ status: "eligible", lifecyclePhase: "intake" }),
      runState({ status: "failed", lifecyclePhase: "failed" }),
      runState({ status: "canceled", lifecyclePhase: "canceled" }),
      runState({ status: "completed", lifecyclePhase: "done" }),
      runState({ status: "released", lifecyclePhase: "done" }),
      runState({ status: "review-ready", lifecyclePhase: "in-review" }),
      runState({
        status: "completed",
        lifecyclePhase: "done",
        archivedAt: "2026-05-03T10:00:00.000Z",
      }),
    ]) {
      expect(canArchiveSymphonyRun(state)).toBe(true);
      expect(getSymphonyArchiveEligibility(state)).toEqual({
        canArchive: true,
        reason: null,
      });
    }
  });

  it("blocks active execution statuses", () => {
    for (const status of ["running", "retry-queued"] as const) {
      expect(
        getSymphonyArchiveEligibility(
          runState({
            status,
            lifecyclePhase: "done",
          }),
        ),
      ).toEqual({
        canArchive: false,
        reason: SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
      });
    }
  });

  it("blocks active execution phases even when the status is stale", () => {
    for (const lifecyclePhase of [
      "planning",
      "implementing",
      "simplifying",
      "reviewing",
      "fixing",
    ] as const) {
      expect(
        getSymphonyArchiveEligibility(
          runState({
            status: "eligible",
            lifecyclePhase,
          }),
        ),
      ).toEqual({
        canArchive: false,
        reason: SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
      });
    }
  });
});
