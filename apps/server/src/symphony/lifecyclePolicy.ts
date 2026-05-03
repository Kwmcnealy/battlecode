import type { SymphonyRun, SymphonyRunStatus } from "@t3tools/contracts";

export const LINEAR_INELIGIBLE_LEGACY_ERROR = "Linear issue is no longer eligible for Symphony.";

export const ACTIVE_MONITORED_RUN_STATUSES: readonly SymphonyRunStatus[] = [
  "planning",
  "implementing",
  "in-review",
  "completed",
];

export const MONITORED_RUN_STATUSES: readonly SymphonyRunStatus[] = [
  ...ACTIVE_MONITORED_RUN_STATUSES,
];

export const RECOVERABLE_MONITORED_RUN_STATUSES: readonly SymphonyRunStatus[] = [
  ...ACTIVE_MONITORED_RUN_STATUSES,
  "canceled",
];

export function isRecoverableLegacyCanceledRun(
  run: Pick<SymphonyRun, "archivedAt" | "lastError" | "status">,
): boolean {
  return (
    run.archivedAt === null &&
    run.status === "canceled" &&
    run.lastError === LINEAR_INELIGIBLE_LEGACY_ERROR
  );
}
