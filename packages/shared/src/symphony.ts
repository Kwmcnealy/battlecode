import type { SymphonyLifecyclePhase, SymphonyRun, SymphonyRunStatus } from "@t3tools/contracts";

export const SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE =
  "Cannot archive a run while Symphony is actively working on it. Stop it first.";

const ARCHIVE_BLOCKED_STATUSES = new Set<SymphonyRunStatus>(["running", "retry-queued"]);

const ARCHIVE_BLOCKED_PHASES = new Set<SymphonyLifecyclePhase>([
  "planning",
  "implementing",
  "simplifying",
  "reviewing",
  "fixing",
]);

export interface SymphonyArchiveEligibility {
  readonly canArchive: boolean;
  readonly reason: string | null;
}

export function getSymphonyArchiveEligibility(
  run: Pick<SymphonyRun, "archivedAt" | "lifecyclePhase" | "status">,
): SymphonyArchiveEligibility {
  if (run.archivedAt !== null) {
    return { canArchive: true, reason: null };
  }
  if (ARCHIVE_BLOCKED_STATUSES.has(run.status) || ARCHIVE_BLOCKED_PHASES.has(run.lifecyclePhase)) {
    return {
      canArchive: false,
      reason: SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
    };
  }
  return { canArchive: true, reason: null };
}

export function canArchiveSymphonyRun(
  run: Pick<SymphonyRun, "archivedAt" | "lifecyclePhase" | "status">,
): boolean {
  return getSymphonyArchiveEligibility(run).canArchive;
}
