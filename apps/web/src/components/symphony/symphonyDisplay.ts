import type { SymphonyExecutionTarget, SymphonyRunStatus } from "@t3tools/contracts";

export type SymphonyAction =
  | "start"
  | "pause"
  | "resume"
  | "refresh"
  | "stop"
  | "retry"
  | "launch-local"
  | "launch-cloud"
  | "refresh-cloud"
  | "update-target";

export const STATUS_BADGE_CLASSNAME: Record<SymphonyRunStatus, string> = {
  "target-pending": "border-primary/50 bg-primary/10 text-primary",
  eligible: "border-info/50 bg-info/10 text-info",
  running: "border-success/50 bg-success/10 text-success",
  "retry-queued": "border-warning/50 bg-warning/10 text-warning",
  "cloud-submitted": "border-primary/50 bg-primary/10 text-primary",
  completed: "border-success/50 bg-success/10 text-success",
  failed: "border-destructive/50 bg-destructive/10 text-destructive",
  canceled: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  released: "border-success/50 bg-success/10 text-success",
};

export const TARGET_LABEL: Record<SymphonyExecutionTarget, string> = {
  local: "Local",
  "codex-cloud": "Codex Cloud",
};

export function formatStatus(value: string): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "-";
}
