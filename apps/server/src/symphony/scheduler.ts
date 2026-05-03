/**
 * Pure scheduler logic for Symphony.
 *
 * Given current state (Linear poll result + existing local runs + capacity),
 * decides what runs to create, what runs to archive (because their issue
 * transitioned back into intake after a non-intake state), and what
 * last-seen-state values to update.
 *
 * Side-effect-free. The Effect Layer wrapping this performs the actual writes.
 *
 * ## lastSeenLinearState policy
 *
 * A run's `lastSeenLinearState` tracks the most recent Linear workflow state
 * that Symphony has observed for that issue. The scheduler uses this to
 * distinguish two scenarios when a failed/completed run's issue re-appears in
 * intake:
 *
 * 1. The issue **transitioned INTO** intake from a non-intake state (e.g.,
 *    Done → To Do): `lastSeenLinearState` was a non-intake state. Symphony
 *    should re-engage — the user explicitly moved the issue back.
 *
 * 2. The issue **stayed** in intake continuously (e.g., a failed run where the
 *    issue never left To Do): `lastSeenLinearState` was already an intake
 *    state. Symphony should NOT re-engage — the issue has been sitting there
 *    since the run failed with no user action.
 *
 * When `lastSeenLinearState` is `null` (no history), we treat the issue as
 * newly transitioned and allow creation.
 *
 * TODO(phase-4): Persist `lastSeenLinearState` on `SymphonyRun` rows via
 * Migration 032 (Task 4.1). For now, callers pass `null` for all existing
 * runs and the scheduler handles nullable values gracefully (treats `null` as
 * "allow creation").
 */

import type { SymphonyRunStatus } from "@t3tools/contracts";

export interface SchedulerInput {
  readonly candidates: readonly {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly state: string;
  }[];
  readonly existingRuns: readonly {
    readonly runId: string;
    readonly issueId: string;
    readonly status: SymphonyRunStatus;
    readonly archivedAt: string | null;
    /**
     * The last Linear state that Symphony observed for this issue's run.
     * `null` means no history: treat as "newly seen" (allow creation).
     * TODO(phase-4): populated from the `last_seen_linear_state` DB column
     * added by Migration 032.
     */
    readonly lastSeenLinearState: string | null;
  }[];
  readonly intakeStates: readonly string[];
  readonly capacity: number;
  readonly runningCount: number;
}

export interface SchedulerDecisions {
  readonly create: readonly { readonly issueId: string; readonly linearState: string }[];
  readonly archive: readonly { readonly runId: string }[];
  readonly updateLastSeen: readonly { readonly runId: string; readonly linearState: string }[];
}

/**
 * Run statuses that indicate an actively managed run that should not be
 * preempted by the scheduler.
 *
 * NOTE: This uses the current 11-value SymphonyRunStatus enum. Phase 4.6 will
 * collapse it to 7 values; at that point ACTIVE_STATUSES should be updated.
 */
const ACTIVE_STATUSES: ReadonlySet<SymphonyRunStatus> = new Set<SymphonyRunStatus>([
  "running",
  "retry-queued",
  "cloud-submitted",
  "cloud-running",
  "review-ready",
]);

/**
 * Decide what scheduler actions to take for the current Linear poll result.
 *
 * For each candidate issue:
 * - If there is no existing run and the issue is in intake: create one.
 * - If there is an existing active run: update last-seen only.
 * - If there is a failed/completed/canceled/released run in a non-active
 *   status and the issue is now in intake:
 *   - If last-seen was already an intake state (continuous stay): skip.
 *   - Otherwise (transition into intake, or no history): archive and create.
 * - If the issue is archived and moves back to intake: create a new run.
 */
export function decideSchedulerActions(input: SchedulerInput): SchedulerDecisions {
  const create: SchedulerDecisions["create"][number][] = [];
  const archive: SchedulerDecisions["archive"][number][] = [];
  const updateLastSeen: SchedulerDecisions["updateLastSeen"][number][] = [];

  let availableCapacity = Math.max(0, input.capacity - input.runningCount);

  const intakeSet = new Set(input.intakeStates);

  for (const issue of input.candidates) {
    const existing = input.existingRuns.find((run) => run.issueId === issue.id);

    if (existing) {
      // Always update the last-seen state for any tracked run.
      updateLastSeen.push({ runId: existing.runId, linearState: issue.state });

      if (ACTIVE_STATUSES.has(existing.status)) {
        // Active run — nothing to do beyond updating last-seen.
        continue;
      }

      if (!intakeSet.has(issue.state)) {
        // Issue is not in intake — nothing to create.
        continue;
      }

      if (existing.archivedAt !== null) {
        // Run was archived (e.g., completed) and issue moved back to intake.
        // Create a new run. The archived run stays archived — no need to
        // further archive it.
        if (availableCapacity > 0) {
          create.push({ issueId: issue.id, linearState: issue.state });
          availableCapacity -= 1;
        }
        continue;
      }

      // Non-active, non-archived run (e.g., failed, canceled, released) with
      // issue in intake. Apply the lastSeenLinearState policy.
      const lastSeenInIntake =
        existing.lastSeenLinearState !== null && intakeSet.has(existing.lastSeenLinearState);

      if (lastSeenInIntake) {
        // Issue has been continuously in intake since the run ended.
        // Do NOT auto-recreate — the user has not taken any action.
        continue;
      }

      // Issue transitioned INTO intake (from a non-intake state) or has no
      // history (null). Archive the existing run and create a new one.
      archive.push({ runId: existing.runId });

      if (availableCapacity > 0) {
        create.push({ issueId: issue.id, linearState: issue.state });
        availableCapacity -= 1;
      }
      continue;
    }

    // No existing run. Create one if the issue is in intake and there is
    // available capacity.
    if (!intakeSet.has(issue.state)) continue;

    if (availableCapacity > 0) {
      create.push({ issueId: issue.id, linearState: issue.state });
      availableCapacity -= 1;
    }
  }

  return { create, archive, updateLastSeen };
}
