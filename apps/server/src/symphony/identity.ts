import * as Crypto from "node:crypto";

import {
  CommandId,
  MessageId,
  SymphonyRunId,
  ThreadId,
  type ProjectId,
  type SymphonyIssueId,
} from "@t3tools/contracts";

export const SYMPHONY_THREAD_ID_PREFIX = "symphony-thread-";

export function isSymphonyThreadId(threadId: ThreadId | string): boolean {
  return String(threadId).startsWith(SYMPHONY_THREAD_ID_PREFIX);
}

export function projectSecretName(projectId: ProjectId): string {
  const digest = Crypto.createHash("sha256").update(projectId).digest("hex");
  return `symphony-linear-${digest}`;
}

export function eventId(): string {
  return `symphony-event-${Crypto.randomUUID()}`;
}

export function commandId(tag: string): CommandId {
  return CommandId.make(`symphony:${tag}:${Crypto.randomUUID()}`);
}

export function messageId(): MessageId {
  return MessageId.make(`symphony-message-${Crypto.randomUUID()}`);
}

export function runId(projectId: ProjectId, issueId: SymphonyIssueId): SymphonyRunId {
  const digest = Crypto.createHash("sha256").update(`${projectId}:${issueId}`).digest("hex");
  return SymphonyRunId.make(`symphony-run-${digest}`);
}

export function threadId(projectId: ProjectId, issueId: SymphonyIssueId): ThreadId {
  const digest = Crypto.createHash("sha256").update(`${projectId}:${issueId}`).digest("hex");
  return ThreadId.make(`${SYMPHONY_THREAD_ID_PREFIX}${digest}`);
}

export function sanitizeIssueIdentifier(identifier: string): string {
  return identifier.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function branchNameForIssue(identifier: string): string {
  return `symphony/${sanitizeIssueIdentifier(identifier).toLowerCase()}`;
}
