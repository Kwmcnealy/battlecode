import type { SymphonyLifecyclePhase } from "@t3tools/contracts";

export const SYMPHONY_LIFECYCLE_PHASES = [
  "intake",
  "planning",
  "implementing",
  "simplifying",
  "reviewing",
  "in-review",
  "fixing",
  "pr-ready",
  "done",
  "failed",
  "canceled",
] as const satisfies readonly SymphonyLifecyclePhase[];

const LIFECYCLE_PHASE_LABELS: Record<SymphonyLifecyclePhase, string> = {
  intake: "Intake",
  planning: "Planning",
  implementing: "Implementing",
  simplifying: "Simplifying",
  reviewing: "Reviewing",
  "in-review": "In Review",
  fixing: "Fixing",
  "pr-ready": "PR Ready",
  done: "Done",
  failed: "Failed",
  canceled: "Canceled",
};

const ACTIVE_LIFECYCLE_PHASES = new Set<SymphonyLifecyclePhase>([
  "intake",
  "planning",
  "implementing",
  "simplifying",
  "reviewing",
  "fixing",
  "pr-ready",
]);

export function lifecyclePhaseLabel(phase: SymphonyLifecyclePhase): string {
  return LIFECYCLE_PHASE_LABELS[phase];
}

export function lifecyclePhaseIsActive(phase: SymphonyLifecyclePhase): boolean {
  return ACTIVE_LIFECYCLE_PHASES.has(phase);
}

export type NextPhaseAfterReviewInput =
  | {
      readonly passed: boolean;
      readonly remainingReviewLoops: number;
    }
  | {
      readonly passed: boolean;
      readonly reviewAttempt: number;
      readonly maxReviewAttempts: number;
    };

export function nextPhaseAfterReview(
  input: NextPhaseAfterReviewInput,
): Extract<SymphonyLifecyclePhase, "pr-ready" | "fixing" | "failed"> {
  if (input.passed) {
    return "pr-ready";
  }

  const hasRemainingLoop =
    "remainingReviewLoops" in input
      ? input.remainingReviewLoops > 0
      : input.reviewAttempt < input.maxReviewAttempts;

  return hasRemainingLoop ? "fixing" : "failed";
}
