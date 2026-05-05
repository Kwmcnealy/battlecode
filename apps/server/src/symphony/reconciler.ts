/**
 * Pure reconciler logic for Symphony.
 *
 * Given a run and a state-string value, decide whether to archive the run.
 * The function does generic list-membership against `doneStates` and
 * `canceledStates`. `doneStates` is checked first; if `linearState` matches
 * both lists, the result is `completed`.
 *
 * Today's caller in `Layers/SymphonyService.ts` feeds the post-classified
 * `SymphonyRunStatus` (e.g., `"completed"`/`"canceled"`) and matching
 * literals as the state lists — this is mechanically equivalent to the
 * pre-extraction inline ternary. The Phase 5 reconciler tick will introduce
 * a Linear-state-driven caller that feeds `linearIssue.state.name` and
 * the user's configured `workflow.config.tracker.doneStates`/`canceledStates`.
 *
 * Side-effect free.
 */

import type { SymphonyRunStatus } from "@t3tools/contracts";

export interface ReconcilerInput {
  readonly run: {
    readonly runId: string;
    readonly issueId: string;
    readonly status: SymphonyRunStatus;
    readonly archivedAt: string | null;
    readonly lastSeenLinearState: string | null;
  };
  readonly linearState: string;
  readonly doneStates: readonly string[];
  readonly canceledStates: readonly string[];
}

export type ReconcilerDecision =
  | {
      readonly archive: true;
      readonly newStatus: "completed" | "canceled";
      readonly reason: string;
    }
  | { readonly archive: false; readonly reason: string };

export function decideArchive(input: ReconcilerInput): ReconcilerDecision {
  if (input.run.archivedAt !== null) {
    return { archive: false, reason: "already_archived" };
  }

  if (input.doneStates.includes(input.linearState)) {
    return { archive: true, newStatus: "completed", reason: "linear_done" };
  }

  if (input.canceledStates.includes(input.linearState)) {
    return { archive: true, newStatus: "canceled", reason: "linear_canceled" };
  }

  return { archive: false, reason: "not_terminal" };
}
