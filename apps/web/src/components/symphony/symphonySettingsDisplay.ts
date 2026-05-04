import type { SymphonySecretStatus, SymphonySettings } from "@t3tools/contracts";
import type { Project } from "../../types";

export type SymphonySettingsBusyAction =
  | "load"
  | "save-workflow"
  | "create-workflow"
  | "validate-workflow"
  | "set-key"
  | "test-key"
  | "delete-key";

export function statusBadgeClassName(status: SymphonySettings["workflowStatus"]["status"]) {
  if (status === "valid") return "border-success/50 bg-success/10 text-success";
  if (status === "invalid" || status === "missing") {
    return "border-destructive/50 bg-destructive/10 text-destructive";
  }
  return "border-warning/50 bg-warning/10 text-warning";
}

export function linearBadgeClassName(status: SymphonySecretStatus) {
  if (status.configured && !status.lastError) return "border-success/50 bg-success/10 text-success";
  if (status.lastError) return "border-destructive/50 bg-destructive/10 text-destructive";
  return "border-warning/50 bg-warning/10 text-warning";
}

export function defaultWorkflowPath(project: Project) {
  return `${project.cwd.replace(/\/+$/, "")}/WORKFLOW.md`;
}
