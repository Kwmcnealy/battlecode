import { Effect, Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const SYMPHONY_WS_METHODS = {
  getSettings: "symphony.getSettings",
  updateWorkflowPath: "symphony.updateWorkflowPath",
  createStarterWorkflow: "symphony.createStarterWorkflow",
  validateWorkflow: "symphony.validateWorkflow",
  setLinearApiKey: "symphony.setLinearApiKey",
  testLinearConnection: "symphony.testLinearConnection",
  deleteLinearApiKey: "symphony.deleteLinearApiKey",
  getSnapshot: "symphony.getSnapshot",
  subscribe: "symphony.subscribe",
  start: "symphony.start",
  pause: "symphony.pause",
  resume: "symphony.resume",
  refresh: "symphony.refresh",
  stopIssue: "symphony.stopIssue",
  retryIssue: "symphony.retryIssue",
  applyLinearMutation: "symphony.applyLinearMutation",
  openLinkedThread: "symphony.openLinkedThread",
} as const;

export const SymphonyIssueId = TrimmedNonEmptyString.pipe(Schema.brand("SymphonyIssueId"));
export type SymphonyIssueId = typeof SymphonyIssueId.Type;

export const SymphonyRunId = TrimmedNonEmptyString.pipe(Schema.brand("SymphonyRunId"));
export type SymphonyRunId = typeof SymphonyRunId.Type;

export const SymphonyTrackerKind = Schema.Literal("linear");
export type SymphonyTrackerKind = typeof SymphonyTrackerKind.Type;

export const SymphonyWorkflowStatusKind = Schema.Literals([
  "missing",
  "invalid",
  "valid",
  "unvalidated",
]);
export type SymphonyWorkflowStatusKind = typeof SymphonyWorkflowStatusKind.Type;

export const SymphonySecretSource = Schema.Literals(["missing", "stored", "env"]);
export type SymphonySecretSource = typeof SymphonySecretSource.Type;

export const SymphonyRunStatus = Schema.Literals([
  "eligible",
  "claimed",
  "running",
  "retry-queued",
  "completed",
  "failed",
  "canceled",
  "released",
]);
export type SymphonyRunStatus = typeof SymphonyRunStatus.Type;

export const SymphonyAttemptStatus = Schema.Literals([
  "preparing-workspace",
  "building-prompt",
  "launching-agent-process",
  "initializing-session",
  "streaming-turn",
  "finishing",
  "succeeded",
  "failed",
  "timed-out",
  "stalled",
  "canceled-by-reconciliation",
]);
export type SymphonyAttemptStatus = typeof SymphonyAttemptStatus.Type;

export const SymphonyRuntimeStatus = Schema.Literals([
  "idle",
  "setup-blocked",
  "running",
  "paused",
  "error",
]);
export type SymphonyRuntimeStatus = typeof SymphonyRuntimeStatus.Type;

export const SymphonyLinearMutationType = Schema.Literals([
  "comment",
  "pr-link-comment",
  "state-transition",
  "add-labels",
  "remove-labels",
  "blocked-status",
]);
export type SymphonyLinearMutationType = typeof SymphonyLinearMutationType.Type;

export const SymphonyTrackerConfig = Schema.Struct({
  kind: SymphonyTrackerKind.pipe(Schema.withDecodingDefault(Effect.succeed("linear" as const))),
  endpoint: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("https://api.linear.app/graphql")),
  ),
  apiKeyRef: Schema.optional(Schema.NullOr(TrimmedString)),
  projectSlug: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  assignee: Schema.optional(Schema.NullOr(TrimmedString)),
  activeStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(["Todo", "In Progress"])),
  ),
  terminalStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(
      Effect.succeed(["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]),
    ),
  ),
});
export type SymphonyTrackerConfig = typeof SymphonyTrackerConfig.Type;

export const SymphonyPollingConfig = Schema.Struct({
  intervalMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(30_000))),
});
export type SymphonyPollingConfig = typeof SymphonyPollingConfig.Type;

export const SymphonyWorkspaceConfig = Schema.Struct({
  root: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type SymphonyWorkspaceConfig = typeof SymphonyWorkspaceConfig.Type;

export const SymphonyHooksConfig = Schema.Struct({
  afterCreate: Schema.optional(Schema.NullOr(Schema.String)),
  beforeRun: Schema.optional(Schema.NullOr(Schema.String)),
  afterRun: Schema.optional(Schema.NullOr(Schema.String)),
  beforeRemove: Schema.optional(Schema.NullOr(Schema.String)),
  timeoutMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(60_000))),
});
export type SymphonyHooksConfig = typeof SymphonyHooksConfig.Type;

export const SymphonyAgentConfig = Schema.Struct({
  maxConcurrentAgents: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(10))),
  maxTurns: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  maxRetryBackoffMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(300_000))),
  maxConcurrentAgentsByState: Schema.Record(TrimmedNonEmptyString, PositiveInt).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type SymphonyAgentConfig = typeof SymphonyAgentConfig.Type;

export const SymphonyCodexConfig = Schema.Struct({
  command: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("codex app-server"))),
  approvalPolicy: Schema.Unknown.pipe(Schema.withDecodingDefault(Effect.succeed("on-request"))),
  threadSandbox: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed("workspace-write"))),
  turnSandboxPolicy: Schema.optional(Schema.NullOr(Schema.Unknown)),
  turnTimeoutMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(3_600_000))),
  readTimeoutMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(5_000))),
  stallTimeoutMs: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(300_000))),
});
export type SymphonyCodexConfig = typeof SymphonyCodexConfig.Type;

export const SymphonyWorkflowConfig = Schema.Struct({
  tracker: SymphonyTrackerConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  polling: SymphonyPollingConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  workspace: SymphonyWorkspaceConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  hooks: SymphonyHooksConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  agent: SymphonyAgentConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  codex: SymphonyCodexConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type SymphonyWorkflowConfig = typeof SymphonyWorkflowConfig.Type;

export const SymphonyWorkflowValidation = Schema.Struct({
  status: SymphonyWorkflowStatusKind,
  message: Schema.NullOr(Schema.String),
  validatedAt: Schema.NullOr(IsoDateTime),
  configHash: Schema.NullOr(TrimmedNonEmptyString),
});
export type SymphonyWorkflowValidation = typeof SymphonyWorkflowValidation.Type;

export const SymphonySecretStatus = Schema.Struct({
  source: SymphonySecretSource,
  configured: Schema.Boolean,
  lastTestedAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
});
export type SymphonySecretStatus = typeof SymphonySecretStatus.Type;

export const SymphonySettings = Schema.Struct({
  projectId: ProjectId,
  workflowPath: TrimmedString,
  workflowStatus: SymphonyWorkflowValidation,
  linearSecret: SymphonySecretStatus,
  updatedAt: IsoDateTime,
});
export type SymphonySettings = typeof SymphonySettings.Type;

export const SymphonyBlockerRef = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  identifier: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
});
export type SymphonyBlockerRef = typeof SymphonyBlockerRef.Type;

export const SymphonyIssue = Schema.Struct({
  id: SymphonyIssueId,
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  priority: Schema.NullOr(Schema.Number),
  state: TrimmedNonEmptyString,
  branchName: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  labels: Schema.Array(Schema.String),
  blockedBy: Schema.Array(SymphonyBlockerRef),
  createdAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type SymphonyIssue = typeof SymphonyIssue.Type;

export const SymphonyRunAttempt = Schema.Struct({
  attempt: NonNegativeInt,
  status: SymphonyAttemptStatus,
  startedAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(Schema.String),
});
export type SymphonyRunAttempt = typeof SymphonyRunAttempt.Type;

export const SymphonyRun = Schema.Struct({
  runId: SymphonyRunId,
  projectId: ProjectId,
  issue: SymphonyIssue,
  status: SymphonyRunStatus,
  workspacePath: Schema.NullOr(Schema.String),
  branchName: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  prUrl: Schema.NullOr(Schema.String),
  attempts: Schema.Array(SymphonyRunAttempt),
  nextRetryAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SymphonyRun = typeof SymphonyRun.Type;

export const SymphonyLinearMutation = Schema.Struct({
  type: SymphonyLinearMutationType,
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
export type SymphonyLinearMutation = typeof SymphonyLinearMutation.Type;

export const SymphonyEvent = Schema.Struct({
  eventId: TrimmedNonEmptyString,
  projectId: ProjectId,
  runId: Schema.NullOr(SymphonyRunId),
  issueId: Schema.NullOr(SymphonyIssueId),
  type: TrimmedNonEmptyString,
  message: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  createdAt: IsoDateTime,
});
export type SymphonyEvent = typeof SymphonyEvent.Type;

export const SymphonyQueueSnapshot = Schema.Struct({
  eligible: Schema.Array(SymphonyRun),
  running: Schema.Array(SymphonyRun),
  retrying: Schema.Array(SymphonyRun),
  completed: Schema.Array(SymphonyRun),
  failed: Schema.Array(SymphonyRun),
  canceled: Schema.Array(SymphonyRun),
});
export type SymphonyQueueSnapshot = typeof SymphonyQueueSnapshot.Type;

export const SymphonyTotals = Schema.Struct({
  eligible: NonNegativeInt,
  running: NonNegativeInt,
  retrying: NonNegativeInt,
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  canceled: NonNegativeInt,
});
export type SymphonyTotals = typeof SymphonyTotals.Type;

export const SymphonySnapshot = Schema.Struct({
  projectId: ProjectId,
  status: SymphonyRuntimeStatus,
  settings: SymphonySettings,
  queues: SymphonyQueueSnapshot,
  totals: SymphonyTotals,
  events: Schema.Array(SymphonyEvent),
  updatedAt: IsoDateTime,
});
export type SymphonySnapshot = typeof SymphonySnapshot.Type;

export const SymphonySubscribeEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: SymphonySnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: SymphonyEvent,
    snapshot: SymphonySnapshot,
  }),
]);
export type SymphonySubscribeEvent = typeof SymphonySubscribeEvent.Type;

export class SymphonyError extends Schema.TaggedErrorClass<SymphonyError>()("SymphonyError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export const SymphonyProjectInput = Schema.Struct({
  projectId: ProjectId,
});
export type SymphonyProjectInput = typeof SymphonyProjectInput.Type;

export const SymphonyUpdateWorkflowPathInput = Schema.Struct({
  projectId: ProjectId,
  path: TrimmedString,
});
export type SymphonyUpdateWorkflowPathInput = typeof SymphonyUpdateWorkflowPathInput.Type;

export const SymphonySetLinearApiKeyInput = Schema.Struct({
  projectId: ProjectId,
  key: TrimmedNonEmptyString,
});
export type SymphonySetLinearApiKeyInput = typeof SymphonySetLinearApiKeyInput.Type;

export const SymphonyIssueActionInput = Schema.Struct({
  projectId: ProjectId,
  issueId: SymphonyIssueId,
});
export type SymphonyIssueActionInput = typeof SymphonyIssueActionInput.Type;

export const SymphonyApplyLinearMutationInput = Schema.Struct({
  projectId: ProjectId,
  issueId: SymphonyIssueId,
  mutation: SymphonyLinearMutation,
});
export type SymphonyApplyLinearMutationInput = typeof SymphonyApplyLinearMutationInput.Type;
