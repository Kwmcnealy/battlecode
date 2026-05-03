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
import { DEFAULT_RUNTIME_MODE, RuntimeMode } from "./orchestration.ts";

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
  archiveIssue: "symphony.archiveIssue",
  openLinkedThread: "symphony.openLinkedThread",
  launchIssue: "symphony.launchIssue",
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
  "target-pending",
  "eligible",
  "running",
  "retry-queued",
  "review-ready",
  "completed",
  "failed",
  "canceled",
  "released",
]);
export type SymphonyRunStatus = typeof SymphonyRunStatus.Type;

export const SymphonyLifecyclePhase = Schema.Literals([
  "intake",
  "planning",
  "implementing",
  "simplifying",
  "reviewing",
  "fixing",
  "pr-ready",
  "in-review",
  "done",
  "canceled",
  "failed",
]);
export type SymphonyLifecyclePhase = typeof SymphonyLifecyclePhase.Type;

export const SymphonyAttemptStatus = Schema.Literals([
  "launching-agent-process",
  "streaming-turn",
  "succeeded",
  "failed",
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

export const SymphonyTrackerConfig = Schema.Struct({
  kind: SymphonyTrackerKind.pipe(Schema.withDecodingDefault(Effect.succeed("linear" as const))),
  endpoint: TrimmedString.pipe(
    Schema.withDecodingDefault(Effect.succeed("https://api.linear.app/graphql")),
  ),
  projectSlug: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  intakeStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.optionalKey,
    Schema.withDecodingDefault(Effect.succeed(["To Do", "Todo"])),
  ),
  activeStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(["In Progress"])),
  ),
  terminalStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(
      Effect.succeed(["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]),
    ),
  ),
  reviewStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(["In Review", "Review"])),
  ),
  doneStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(["Done", "Closed"])),
  ),
  canceledStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(["Canceled", "Cancelled"])),
  ),
  transitionStates: Schema.Struct({
    started: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed("In Progress")),
    ),
    review: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed("In Review")),
    ),
    done: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed("Done")),
    ),
    canceled: Schema.NullOr(TrimmedNonEmptyString).pipe(
      Schema.withDecodingDefault(Effect.succeed("Canceled")),
    ),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
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
  timeoutMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(60_000))),
});
export type SymphonyHooksConfig = typeof SymphonyHooksConfig.Type;

export const SymphonyAgentConfig = Schema.Struct({
  maxConcurrentAgents: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(10))),
  maxTurns: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  maxRetryBackoffMs: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(300_000))),
});
export type SymphonyAgentConfig = typeof SymphonyAgentConfig.Type;

export const SymphonyCodexConfig = Schema.Struct({
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
});
export type SymphonyCodexConfig = typeof SymphonyCodexConfig.Type;

export const SymphonyPullRequestConfig = Schema.Struct({
  baseBranch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SymphonyPullRequestConfig = typeof SymphonyPullRequestConfig.Type;

export const DEFAULT_SYMPHONY_SIMPLIFICATION_PROMPT =
  "Simplify only the code changed for this issue. Preserve behavior and UI unless a fix is required.";
export const DEFAULT_SYMPHONY_REVIEW_PROMPT =
  "Review the current branch for correctness, regressions, and missing validation. Return REVIEW_PASS or REVIEW_FAIL with concrete findings.";

export const SymphonyQualityConfig = Schema.Struct({
  maxReviewFixLoops: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  simplificationPrompt: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SYMPHONY_SIMPLIFICATION_PROMPT)),
  ),
  reviewPrompt: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SYMPHONY_REVIEW_PROMPT)),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SymphonyQualityConfig = typeof SymphonyQualityConfig.Type;

export const SymphonyWorkflowConfig = Schema.Struct({
  tracker: SymphonyTrackerConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  polling: SymphonyPollingConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  workspace: SymphonyWorkspaceConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  hooks: SymphonyHooksConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  agent: SymphonyAgentConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  codex: SymphonyCodexConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  pullRequest: SymphonyPullRequestConfig.pipe(
    Schema.optionalKey,
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  quality: SymphonyQualityConfig.pipe(
    Schema.optionalKey,
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
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

export const SymphonyPullRequestSummary = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
  updatedAt: IsoDateTime,
});
export type SymphonyPullRequestSummary = typeof SymphonyPullRequestSummary.Type;

export const SymphonyRunProgress = Schema.Struct({
  source: Schema.Literals(["symphony", "linear", "local-thread", "github"]),
  label: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type SymphonyRunProgress = typeof SymphonyRunProgress.Type;

export const SymphonyLinearProgressComment = Schema.Struct({
  commentId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  commentUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  ownedCommentIds: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  lastRenderedHash: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastUpdatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  lastMilestoneAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastFeedbackAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SymphonyLinearProgressComment = typeof SymphonyLinearProgressComment.Type;

export const SymphonyQualityGateState = Schema.Struct({
  reviewFixLoops: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  lastReviewPassedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastReviewSummary: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastReviewFindings: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  lastReviewedCommit: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastFixCommit: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastPublishedCommit: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastFeedbackFingerprint: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SymphonyQualityGateState = typeof SymphonyQualityGateState.Type;

export const SymphonyRun = Schema.Struct({
  runId: SymphonyRunId,
  projectId: ProjectId,
  issue: SymphonyIssue,
  status: SymphonyRunStatus,
  lifecyclePhase: SymphonyLifecyclePhase.pipe(
    Schema.withDecodingDefault(Effect.succeed("intake" as const)),
  ),
  workspacePath: Schema.NullOr(Schema.String),
  branchName: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  prUrl: Schema.NullOr(Schema.String),
  pullRequest: Schema.NullOr(SymphonyPullRequestSummary).pipe(
    Schema.optionalKey,
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  currentStep: Schema.NullOr(SymphonyRunProgress).pipe(
    Schema.optionalKey,
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  linearProgress: SymphonyLinearProgressComment.pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  qualityGate: SymphonyQualityGateState.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  archivedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  attempts: Schema.Array(SymphonyRunAttempt),
  nextRetryAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SymphonyRun = typeof SymphonyRun.Type;

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
  pendingTarget: Schema.Array(SymphonyRun),
  eligible: Schema.Array(SymphonyRun),
  running: Schema.Array(SymphonyRun),
  retrying: Schema.Array(SymphonyRun),
  completed: Schema.Array(SymphonyRun),
  failed: Schema.Array(SymphonyRun),
  canceled: Schema.Array(SymphonyRun),
  archived: Schema.Array(SymphonyRun).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SymphonyQueueSnapshot = typeof SymphonyQueueSnapshot.Type;

export const SymphonyTotals = Schema.Struct({
  pendingTarget: NonNegativeInt,
  eligible: NonNegativeInt,
  running: NonNegativeInt,
  retrying: NonNegativeInt,
  completed: NonNegativeInt,
  failed: NonNegativeInt,
  canceled: NonNegativeInt,
  archived: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
});
export type SymphonyTotals = typeof SymphonyTotals.Type;

export const SymphonySnapshotDiagnosticSummary = Schema.Struct({
  count: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  latestMessage: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SymphonySnapshotDiagnosticSummary = typeof SymphonySnapshotDiagnosticSummary.Type;

export const SymphonySnapshotDiagnostics = Schema.Struct({
  lastPollAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  queriedStates: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  candidateCount: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  warningSummary: SymphonySnapshotDiagnosticSummary,
  errorSummary: SymphonySnapshotDiagnosticSummary,
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SymphonySnapshotDiagnostics = typeof SymphonySnapshotDiagnostics.Type;

export const SymphonySnapshot = Schema.Struct({
  projectId: ProjectId,
  status: SymphonyRuntimeStatus,
  settings: SymphonySettings,
  queues: SymphonyQueueSnapshot,
  totals: SymphonyTotals,
  events: Schema.Array(SymphonyEvent),
  diagnostics: Schema.optionalKey(SymphonySnapshotDiagnostics),
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

export const SymphonyLaunchIssueInput = Schema.Struct({
  projectId: ProjectId,
  issueId: SymphonyIssueId,
});
export type SymphonyLaunchIssueInput = typeof SymphonyLaunchIssueInput.Type;
