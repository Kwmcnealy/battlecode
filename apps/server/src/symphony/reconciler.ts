/**
 * Pure reconciler logic for Symphony.
 *
 * Given a run and the latest Linear state for its issue, decide whether
 * to archive the run and what its new status should be. Side-effect free.
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
