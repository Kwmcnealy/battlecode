import { describe, expect, it } from "vitest";

import {
  lifecyclePhaseIsActive,
  lifecyclePhaseLabel,
  nextPhaseAfterReview,
} from "./lifecyclePhase.ts";

describe("Symphony lifecycle phases", () => {
  it("labels workflow phases for operator-facing comments", () => {
    expect(lifecyclePhaseLabel("waiting-cloud")).toBe("Waiting for cloud signal");
    expect(lifecyclePhaseLabel("in-review")).toBe("In Review");
    expect(lifecyclePhaseLabel("pr-ready")).toBe("PR Ready");
  });

  it("identifies active workflow phases", () => {
    expect(lifecyclePhaseIsActive("intake")).toBe(true);
    expect(lifecyclePhaseIsActive("planning")).toBe(true);
    expect(lifecyclePhaseIsActive("implementing")).toBe(true);
    expect(lifecyclePhaseIsActive("waiting-cloud")).toBe(true);
    expect(lifecyclePhaseIsActive("simplifying")).toBe(true);
    expect(lifecyclePhaseIsActive("reviewing")).toBe(true);
    expect(lifecyclePhaseIsActive("fixing")).toBe(true);
    expect(lifecyclePhaseIsActive("pr-ready")).toBe(true);
    expect(lifecyclePhaseIsActive("failed")).toBe(false);
  });

  it("selects the next phase after review outcomes", () => {
    expect(nextPhaseAfterReview({ passed: true, remainingReviewLoops: 0 })).toBe("pr-ready");
    expect(nextPhaseAfterReview({ passed: false, remainingReviewLoops: 1 })).toBe("fixing");
    expect(nextPhaseAfterReview({ passed: false, remainingReviewLoops: 0 })).toBe("failed");
    expect(nextPhaseAfterReview({ passed: false, reviewAttempt: 2, maxReviewAttempts: 3 })).toBe(
      "fixing",
    );
    expect(nextPhaseAfterReview({ passed: false, reviewAttempt: 3, maxReviewAttempts: 3 })).toBe(
      "failed",
    );
  });
});
