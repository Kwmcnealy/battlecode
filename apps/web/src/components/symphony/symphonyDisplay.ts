import type {
  SymphonyEvent,
  SymphonyLifecyclePhase,
  SymphonyQueueSnapshot,
  SymphonyRun,
  SymphonyRunStatus,
  SymphonySnapshot,
} from "@t3tools/contracts";

export type SymphonyAction =
  | "start"
  | "pause"
  | "resume"
  | "refresh"
  | "stop"
  | "retry"
  | "archive"
  | "launch";

export const STATUS_BADGE_CLASSNAME: Record<SymphonyRunStatus, string> = {
  "target-pending": "border-primary/50 bg-primary/10 text-primary",
  eligible: "border-info/50 bg-info/10 text-info",
  running: "border-success/50 bg-success/10 text-success",
  "retry-queued": "border-warning/50 bg-warning/10 text-warning",
  "review-ready": "border-warning/50 bg-warning/10 text-warning",
  completed: "border-success/50 bg-success/10 text-success",
  failed: "border-destructive/50 bg-destructive/10 text-destructive",
  canceled: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  released: "border-success/50 bg-success/10 text-success",
};

export const PHASE_BADGE_CLASSNAME: Record<SymphonyLifecyclePhase, string> = {
  intake: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  planning: "border-primary/50 bg-primary/10 text-primary",
  implementing: "border-success/50 bg-success/10 text-success",
  simplifying: "border-warning/50 bg-warning/10 text-warning",
  reviewing: "border-warning/50 bg-warning/10 text-warning",
  fixing: "border-warning/50 bg-warning/10 text-warning",
  "pr-ready": "border-primary/50 bg-primary/10 text-primary",
  "in-review": "border-info/50 bg-info/10 text-info",
  done: "border-success/50 bg-success/10 text-success",
  canceled: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  failed: "border-destructive/50 bg-destructive/10 text-destructive",
};

const QUEUE_KEYS = [
  "pendingTarget",
  "running",
  "retrying",
  "eligible",
  "failed",
  "canceled",
  "completed",
  "archived",
] as const satisfies readonly (keyof SymphonyQueueSnapshot)[];

export interface SymphonyDiagnosticsDisplay {
  readonly lastPollLabel: string;
  readonly lastPollTitle: string;
  readonly workflowLabel: string;
  readonly workflowTitle: string;
  readonly queriedStatesLabel: string | null;
  readonly candidateCountLabel: string | null;
  readonly warningLabel: string | null;
  readonly warningTitle: string | null;
  readonly errorLabel: string | null;
  readonly errorTitle: string | null;
}

export function formatLifecyclePhase(value: SymphonyLifecyclePhase): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatStatus(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}

function buildRunDigest(run: SymphonyRun): string {
  return JSON.stringify(run);
}

function buildQueueDigest(queues: SymphonyQueueSnapshot): string {
  return JSON.stringify(QUEUE_KEYS.map((key) => queues[key].map(buildRunDigest)));
}

function buildSettingsDigest(snapshot: SymphonySnapshot): string {
  return JSON.stringify({
    status: snapshot.status,
    settings: snapshot.settings,
    totals: snapshot.totals,
  });
}

function reconcileQueueRuns(
  currentRuns: readonly SymphonyRun[],
  nextRuns: readonly SymphonyRun[],
): SymphonyRun[] {
  const currentByRunId = new Map(currentRuns.map((run) => [run.runId, run]));
  return nextRuns.map((nextRun) => {
    const currentRun = currentByRunId.get(nextRun.runId);
    return currentRun && buildRunDigest(currentRun) === buildRunDigest(nextRun)
      ? currentRun
      : nextRun;
  });
}

function reconcileQueues(
  currentQueues: SymphonyQueueSnapshot,
  nextQueues: SymphonyQueueSnapshot,
): SymphonyQueueSnapshot {
  return {
    pendingTarget: reconcileQueueRuns(currentQueues.pendingTarget, nextQueues.pendingTarget),
    running: reconcileQueueRuns(currentQueues.running, nextQueues.running),
    retrying: reconcileQueueRuns(currentQueues.retrying, nextQueues.retrying),
    eligible: reconcileQueueRuns(currentQueues.eligible, nextQueues.eligible),
    failed: reconcileQueueRuns(currentQueues.failed, nextQueues.failed),
    canceled: reconcileQueueRuns(currentQueues.canceled, nextQueues.canceled),
    completed: reconcileQueueRuns(currentQueues.completed, nextQueues.completed),
    archived: reconcileQueueRuns(currentQueues.archived, nextQueues.archived),
  };
}

function isDiagnosticEvent(event: SymphonyEvent): boolean {
  const type = event.type.toLowerCase();
  return type.includes("warning") || type.includes("error") || type.includes("failed");
}

function hasOnlyNewDiagnosticEvents(
  currentEvents: readonly SymphonyEvent[],
  nextEvents: readonly SymphonyEvent[],
): boolean {
  const currentEventIds = new Set(currentEvents.map((event) => event.eventId));
  const addedEvents = nextEvents.filter((event) => !currentEventIds.has(event.eventId));
  return addedEvents.length > 0 && addedEvents.every(isDiagnosticEvent);
}

export function mergeSymphonySnapshotForDisplay(
  current: SymphonySnapshot | null,
  next: SymphonySnapshot,
): SymphonySnapshot {
  if (!current || current.projectId !== next.projectId) {
    return next;
  }

  const settingsChanged = buildSettingsDigest(current) !== buildSettingsDigest(next);
  const queuesChanged = buildQueueDigest(current.queues) !== buildQueueDigest(next.queues);
  const warningOnlySnapshot =
    !settingsChanged && !queuesChanged && hasOnlyNewDiagnosticEvents(current.events, next.events);

  if (warningOnlySnapshot) {
    return {
      ...current,
      ...(next.diagnostics ? { diagnostics: next.diagnostics } : {}),
      events: next.events,
      updatedAt: next.updatedAt,
    };
  }

  return {
    ...next,
    queues: reconcileQueues(current.queues, next.queues),
  };
}

function latestMatchingEventMessage(
  events: readonly SymphonyEvent[],
  predicate: (event: SymphonyEvent) => boolean,
): string | null {
  return events.toReversed().find(predicate)?.message ?? null;
}

function countMatchingEvents(
  events: readonly SymphonyEvent[],
  predicate: (event: SymphonyEvent) => boolean,
): number {
  return events.reduce((count, event) => count + (predicate(event) ? 1 : 0), 0);
}

function isWarningEvent(event: SymphonyEvent): boolean {
  return event.type.toLowerCase().includes("warning");
}

function isErrorEvent(event: SymphonyEvent): boolean {
  const type = event.type.toLowerCase();
  return type.includes("error") || type.includes("failed") || type.includes("invalid");
}

function compactPath(value: string): string {
  if (value.length <= 42) {
    return value;
  }
  const parts = value.split("/");
  const fileName = parts.at(-1) ?? value;
  const parentName = parts.at(-2);
  return parentName ? `.../${parentName}/${fileName}` : `.../${fileName}`;
}

export function getSymphonyDiagnosticsDisplay(
  snapshot: SymphonySnapshot,
): SymphonyDiagnosticsDisplay {
  const diagnostics = snapshot.diagnostics;
  const warningCount =
    diagnostics?.warningSummary.count ?? countMatchingEvents(snapshot.events, isWarningEvent);
  const warningMessage =
    diagnostics?.warningSummary.latestMessage ??
    latestMatchingEventMessage(snapshot.events, isWarningEvent);
  const eventErrorCount = countMatchingEvents(snapshot.events, isErrorEvent);
  const workflowError = snapshot.settings.workflowStatus.status === "invalid" ? 1 : 0;
  const secretError = snapshot.settings.linearSecret.lastError ? 1 : 0;
  const runtimeError = snapshot.status === "error" ? 1 : 0;
  const errorCount =
    diagnostics?.errorSummary.count ?? eventErrorCount + workflowError + secretError + runtimeError;
  const errorMessage =
    diagnostics?.errorSummary.latestMessage ??
    snapshot.settings.linearSecret.lastError ??
    (snapshot.settings.workflowStatus.status === "invalid"
      ? snapshot.settings.workflowStatus.message
      : null) ??
    latestMatchingEventMessage(snapshot.events, isErrorEvent);
  const workflowStatus = formatStatus(snapshot.settings.workflowStatus.status);
  const workflowPath = snapshot.settings.workflowPath || "-";
  const queriedStates = diagnostics?.queriedStates ?? [];
  const candidateCount = diagnostics?.candidateCount ?? null;
  const lastPollAt = diagnostics?.lastPollAt ?? null;

  return {
    lastPollLabel: lastPollAt ? formatDateTime(lastPollAt) : "Not polled",
    lastPollTitle: lastPollAt
      ? `Last poll: ${formatDateTime(lastPollAt)}`
      : "Last poll unavailable",
    workflowLabel: `${workflowStatus} · ${compactPath(workflowPath)}`,
    workflowTitle: `Workflow ${workflowStatus}: ${workflowPath}`,
    queriedStatesLabel:
      queriedStates.length > 0 ? `States ${queriedStates.slice(0, 4).join(", ")}` : null,
    candidateCountLabel: candidateCount === null ? null : `${candidateCount} candidates`,
    warningLabel: warningCount > 0 ? `${warningCount} warnings` : null,
    warningTitle: warningMessage,
    errorLabel: errorCount > 0 ? `${errorCount} errors` : null,
    errorTitle: errorMessage,
  };
}
