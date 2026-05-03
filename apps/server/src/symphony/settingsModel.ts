import * as Crypto from "node:crypto";

import type {
  ProjectId,
  SymphonySecretStatus,
  SymphonySettings,
  SymphonySnapshot,
} from "@t3tools/contracts";

import { defaultWorkflowPath } from "./workflow.ts";

export function defaultSecretStatus(): SymphonySecretStatus {
  const envToken = process.env.LINEAR_API_KEY?.trim();
  return envToken
    ? {
        source: "env",
        configured: true,
        lastTestedAt: null,
        lastError: null,
      }
    : {
        source: "missing",
        configured: false,
        lastTestedAt: null,
        lastError: null,
      };
}

function workflowMissingStatus(
  message = "No workflow has been validated yet.",
): SymphonySettings["workflowStatus"] {
  return {
    status: "missing",
    message,
    validatedAt: null,
    configHash: null,
  };
}

export function hashWorkflow(markdown: string): string {
  return Crypto.createHash("sha256").update(markdown).digest("hex");
}

export function makeDefaultSettings(input: {
  readonly projectId: ProjectId;
  readonly projectRoot: string;
  readonly linearSecret: SymphonySecretStatus;
  readonly now: string;
}): SymphonySettings {
  return {
    projectId: input.projectId,
    workflowPath: defaultWorkflowPath(input.projectRoot),
    workflowStatus: workflowMissingStatus(),
    linearSecret: input.linearSecret,
    updatedAt: input.now,
  };
}

export function mapRuntimeStatus(input: {
  readonly runtimeStatus: "idle" | "running" | "paused" | "error";
  readonly settings: SymphonySettings;
}): SymphonySnapshot["status"] {
  if (input.settings.workflowStatus.status !== "valid" || !input.settings.linearSecret.configured) {
    return "setup-blocked";
  }
  return input.runtimeStatus;
}
