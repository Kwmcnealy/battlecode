import { describe, expect, it } from "vitest";
import type { SymphonyRunStatus } from "@t3tools/contracts";

import {
  SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
  canArchiveSymphonyRun,
  getSymphonyArchiveEligibility,
} from "./symphony.ts";

function runState(input: {
  readonly status: SymphonyRunStatus;
  readonly archivedAt?: string | null;
}) {
  return {
    status: input.status,
    archivedAt: input.archivedAt ?? null,
  };
}

describe("Symphony archive eligibility", () => {
  it("allows inactive runs to be manually archived", () => {
    for (const state of [
      runState({ status: "intake" }),
      runState({ status: "failed" }),
      runState({ status: "canceled" }),
      runState({ status: "completed" }),
      runState({ status: "completed", archivedAt: "2026-05-03T10:00:00.000Z" }),
    ]) {
      expect(canArchiveSymphonyRun(state)).toBe(true);
      expect(getSymphonyArchiveEligibility(state)).toEqual({
        canArchive: true,
        reason: null,
      });
    }
  });

  it("blocks active execution statuses", () => {
    for (const status of ["planning", "implementing", "in-review"] as const) {
      expect(getSymphonyArchiveEligibility(runState({ status }))).toEqual({
        canArchive: false,
        reason: SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
      });
    }
  });
});
