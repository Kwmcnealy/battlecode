/**
 * Linear-write helpers for Symphony.
 *
 * The single place that owns the Effect-based write boundary for Linear API
 * calls: managed-progress comment upsert and issue-state transitions.
 *
 * Rendering of the comment body is owned by `progressComment.ts`.
 * The marker constant is re-exported here as `MANAGED_COMMENT_MARKER` for
 * convenience so callers only need to import from one place.
 */

import type {
  ProjectId,
  SymphonyError,
  SymphonyEvent,
  SymphonyIssueId,
  SymphonyRun,
  SymphonyWorkflowConfig,
} from "@t3tools/contracts";
import { Effect } from "effect";

import {
  DEFAULT_LINEAR_ENDPOINT,
  createLinearComment,
  fetchLinearIssuesByIds,
  updateLinearComment,
  updateLinearIssueState,
  type LinearIssueWorkflowContext,
} from "./linear.ts";
import {
  SYMPHONY_MANAGED_PROGRESS_MARKER,
  renderManagedProgressComment,
} from "./progressComment.ts";
import { hashWorkflow } from "./settingsModel.ts";

// Re-export as the canonical public name for this module.
export const MANAGED_COMMENT_MARKER = SYMPHONY_MANAGED_PROGRESS_MARKER;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
  }
  return result;
}

export function appendOwnedCommentId(
  progress: SymphonyRun["linearProgress"],
  commentId: string | null,
): SymphonyRun["linearProgress"] {
  if (!commentId) return progress;
  return {
    ...progress,
    ownedCommentIds: dedupeStrings([...progress.ownedCommentIds, commentId]),
  };
}

// ---------------------------------------------------------------------------
// Dependency shapes
// ---------------------------------------------------------------------------

type EmitProjectEventFn = (input: {
  readonly projectId: ProjectId;
  readonly type: string;
  readonly message: string;
  readonly payload?: Record<string, unknown>;
  readonly runId?: SymphonyRun["runId"] | null;
  readonly issueId?: SymphonyIssueId | null;
}) => Effect.Effect<SymphonyEvent, SymphonyError>;

/**
 * Minimal dependencies needed to emit a Linear-related project event.
 * Both `upsertManagedComment` and `transitionLinearState` accept this so
 * callers inject just what's needed.
 */
export interface LinearWriterEventDeps {
  readonly emitProjectEvent: EmitProjectEventFn;
}

export interface LinearWriterRunDeps extends LinearWriterEventDeps {
  readonly readLinearApiKey: (projectId: ProjectId) => Effect.Effect<string | null, SymphonyError>;
  readonly upsertRun: (run: SymphonyRun) => Effect.Effect<SymphonyRun, SymphonyError>;
}

export interface LinearWriterStateDeps extends LinearWriterEventDeps {
  readonly readLinearApiKey: (projectId: ProjectId) => Effect.Effect<string | null, SymphonyError>;
}

// ---------------------------------------------------------------------------
// Public write operations
// ---------------------------------------------------------------------------

/**
 * Create or update the Symphony managed-progress comment on the Linear issue.
 *
 * - If the run already has a `linearProgress.commentId`, updates that comment.
 * - Otherwise creates a new comment and stores its id on the returned run.
 * - On any failure emits a `linear.progress-warning` event and returns the
 *   original run unchanged (best-effort, never throws).
 */
export function upsertManagedComment(
  deps: LinearWriterRunDeps,
  input: {
    readonly projectId: ProjectId;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly run: SymphonyRun;
    readonly planMarkdown: string | null;
    readonly statusLine: string;
    readonly milestone?: string | null;
    readonly milestoneDetail?: string | null;
  },
): Effect.Effect<SymphonyRun, never> {
  return Effect.gen(function* () {
    const apiKey = yield* deps.readLinearApiKey(input.projectId);
    if (!apiKey) return input.run;

    const updatedAt = nowIso();
    const body = renderManagedProgressComment({
      phase: input.run.lifecyclePhase,
      lastUpdate: updatedAt,
      executionTarget: input.run.executionTarget,
      currentStep: input.run.currentStep?.label ?? input.statusLine,
      pullRequestUrl: input.run.prUrl ?? input.run.pullRequest?.url ?? null,
      planMarkdown: input.planMarkdown,
      reviewFindings: input.run.qualityGate.lastReviewFindings,
    });
    const endpoint = input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT;
    const comment =
      input.run.linearProgress.commentId !== null
        ? yield* updateLinearComment({
            endpoint,
            apiKey,
            commentId: input.run.linearProgress.commentId,
            body,
          })
        : yield* createLinearComment({
            endpoint,
            apiKey,
            issueId: input.run.issue.id,
            body,
          });

    const nextRun: SymphonyRun = {
      ...input.run,
      linearProgress: appendOwnedCommentId(
        {
          ...input.run.linearProgress,
          commentId: comment.id,
          commentUrl: comment.url,
          lastRenderedHash: hashWorkflow(body),
          lastUpdatedAt: updatedAt,
          lastMilestoneAt: input.milestone ? updatedAt : input.run.linearProgress.lastMilestoneAt,
        },
        comment.id,
      ),
      updatedAt,
    };

    yield* deps.upsertRun(nextRun);

    return nextRun;
  }).pipe(
    Effect.catch((error) =>
      deps
        .emitProjectEvent({
          projectId: input.projectId,
          issueId: input.run.issue.id,
          runId: input.run.runId,
          type: "linear.progress-warning",
          message: `Linear progress comment update failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        .pipe(
          Effect.as(input.run),
          Effect.orElseSucceed(() => input.run),
        ),
    ),
  );
}

/**
 * Move a Linear issue to the target workflow state by name.
 *
 * - Fetches the current issue state first; skips if already in target state.
 * - Emits a `linear.state-updated` event when the state changes.
 * - All failures are swallowed (best-effort, never throws).
 */
export function transitionLinearState(
  deps: LinearWriterStateDeps,
  input: {
    readonly projectId: ProjectId;
    readonly workflow: { readonly config: SymphonyWorkflowConfig };
    readonly run: SymphonyRun;
    readonly stateName: string | null | undefined;
    readonly reason: string;
  },
): Effect.Effect<void, never> {
  const stateName = input.stateName?.trim();
  if (!stateName) return Effect.void;

  return Effect.gen(function* () {
    const apiKey = yield* deps.readLinearApiKey(input.projectId);
    if (!apiKey) return;

    const issues = yield* fetchLinearIssuesByIds({
      endpoint: input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
      apiKey,
      issueIds: [input.run.issue.id],
    });
    const issue = issues.find(
      (trackedIssue: LinearIssueWorkflowContext) => trackedIssue.issue.id === input.run.issue.id,
    );
    if (!issue) return;

    const result = yield* updateLinearIssueState({
      endpoint: input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT,
      apiKey,
      issue,
      stateName,
    });

    if (result.changed) {
      yield* deps.emitProjectEvent({
        projectId: input.projectId,
        issueId: input.run.issue.id,
        runId: input.run.runId,
        type: "linear.state-updated",
        message: `${input.run.issue.identifier} moved to ${result.stateName}`,
        payload: {
          stateId: result.stateId,
          stateName: result.stateName,
          reason: input.reason,
        },
      });
    }
  }).pipe(Effect.ignoreCause({ log: true }));
}
