import {
  type ModelSelection,
  type ProjectId,
  type SymphonyIssue,
  type SymphonyRun,
  type SymphonySnapshot,
} from "@t3tools/contracts";

import { branchNameForIssue, runId } from "./identity.ts";

export function defaultSymphonyLocalModelSelection(): ModelSelection {
  return {
    provider: "codex",
    model: "gpt-5.5",
    options: [{ id: "reasoningEffort", value: "high" }],
  };
}

function dateMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function shouldPoll(
  lastPollAt: string | null,
  intervalMs: number,
  now = Date.now(),
): boolean {
  const lastPollMs = dateMs(lastPollAt);
  return lastPollMs === null || now - lastPollMs >= intervalMs;
}

function retryBackoffMs(attempt: number, maxRetryBackoffMs: number): number {
  return Math.min(10_000 * 2 ** Math.max(0, attempt - 1), maxRetryBackoffMs);
}

export function retryAfterIso(attempt: number, maxRetryBackoffMs: number): string {
  return new Date(Date.now() + retryBackoffMs(attempt, maxRetryBackoffMs)).toISOString();
}

export function retryIsReady(nextRetryAt: string | null, now = Date.now()): boolean {
  const nextRetryMs = dateMs(nextRetryAt);
  return nextRetryMs === null || nextRetryMs <= now;
}

function replaceAll(input: string, token: string, value: string): string {
  return input.split(token).join(value);
}

export function buildIssuePrompt(input: {
  readonly issue: SymphonyIssue;
  readonly workflowPrompt: string;
  readonly workflowPath: string;
  readonly workspacePath: string;
  readonly branchName: string;
}): string {
  const basePrompt =
    input.workflowPrompt.trim().length > 0
      ? input.workflowPrompt.trim()
      : "Resolve the Linear issue using the repository workflow.";
  const issueDescription = input.issue.description?.trim() || "(no Linear description)";
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["{{issue.id}}", input.issue.id],
    ["{{issue.identifier}}", input.issue.identifier],
    ["{{issue.title}}", input.issue.title],
    ["{{issue.description}}", issueDescription],
    ["{{issue.state}}", input.issue.state],
    ["{{issue.url}}", input.issue.url ?? ""],
    ["{{workspace.path}}", input.workspacePath],
    ["{{git.branch}}", input.branchName],
    ["{{workflow.path}}", input.workflowPath],
  ];
  const rendered = replacements.reduce(
    (next, [token, value]) => replaceAll(next, token, value),
    basePrompt,
  );

  return [
    rendered,
    "",
    "Symphony run context:",
    `- Linear issue: ${input.issue.identifier} - ${input.issue.title}`,
    `- Branch: ${input.branchName}`,
    `- Workspace: ${input.workspacePath}`,
    `- Workflow: ${input.workflowPath}`,
    "",
    "Work in this workspace. Commit, push, and open a PR according to WORKFLOW.md.",
  ].join("\n");
}

export function buildContinuationPrompt(input: {
  readonly turnNumber: number;
  readonly maxTurns: number;
}): string {
  return [
    "Continuation guidance:",
    "",
    "- The previous Codex turn completed normally, but the Linear issue is still in an active state.",
    `- This is continuation turn #${input.turnNumber} of ${input.maxTurns} for the current agent run.`,
    "- Resume from the current workspace and workpad state instead of restarting from scratch.",
    "- The original task instructions and prior turn context are already present in this thread, so do not restate them before acting.",
    "- Focus on the remaining ticket work and do not end the turn while the issue stays active unless you are truly blocked.",
  ].join("\n");
}

export function buildHookEnv(input: {
  readonly projectRoot: string;
  readonly workflowPath: string;
  readonly workspacePath: string;
  readonly branchName: string;
  readonly run: SymphonyRun;
}): NodeJS.ProcessEnv {
  const { LINEAR_API_KEY: _linearApiKey, ...safeProcessEnv } = process.env;
  return {
    ...safeProcessEnv,
    SYMPHONY_PROJECT_ROOT: input.projectRoot,
    SYMPHONY_WORKFLOW_PATH: input.workflowPath,
    SYMPHONY_WORKSPACE_PATH: input.workspacePath,
    SYMPHONY_BRANCH_NAME: input.branchName,
    SYMPHONY_RUN_ID: input.run.runId,
    SYMPHONY_ISSUE_ID: input.run.issue.id,
    SYMPHONY_ISSUE_IDENTIFIER: input.run.issue.identifier,
    SYMPHONY_ISSUE_TITLE: input.run.issue.title,
  };
}

export function blockerIsTerminal(
  blockerState: string | null,
  terminalStates: readonly string[],
): boolean {
  if (!blockerState) return false;
  return terminalStates.some(
    (state) => state.toLocaleLowerCase() === blockerState.toLocaleLowerCase(),
  );
}

export function queueRuns(runs: readonly SymphonyRun[]): SymphonySnapshot["queues"] {
  const activeRuns = runs.filter((run) => run.archivedAt === null);
  return {
    pendingTarget: activeRuns.filter((run) => run.status === "target-pending"),
    eligible: activeRuns.filter((run) => run.status === "eligible"),
    running: activeRuns.filter(
      (run) =>
        run.status === "running" ||
        run.status === "cloud-submitted" ||
        run.status === "cloud-running",
    ),
    retrying: activeRuns.filter((run) => run.status === "retry-queued"),
    completed: activeRuns.filter(
      (run) =>
        run.status === "review-ready" || run.status === "completed" || run.status === "released",
    ),
    failed: activeRuns.filter((run) => run.status === "failed"),
    canceled: activeRuns.filter((run) => run.status === "canceled"),
    archived: runs.filter((run) => run.archivedAt !== null),
  };
}

export function buildTotals(queues: SymphonySnapshot["queues"]): SymphonySnapshot["totals"] {
  return {
    pendingTarget: queues.pendingTarget.length,
    eligible: queues.eligible.length,
    running: queues.running.length,
    retrying: queues.retrying.length,
    completed: queues.completed.length,
    failed: queues.failed.length,
    canceled: queues.canceled.length,
    archived: queues.archived.length,
  };
}

export function replaceLatestAttempt(
  run: SymphonyRun,
  update: Partial<SymphonyRun["attempts"][number]>,
): SymphonyRun["attempts"] {
  const latestIndex = run.attempts.length - 1;
  if (latestIndex < 0) {
    return run.attempts;
  }
  return run.attempts.map((attempt, index) =>
    index === latestIndex ? { ...attempt, ...update } : attempt,
  );
}

export function makeRun(
  projectId: ProjectId,
  issue: SymphonyIssue,
  createdAt: string,
): SymphonyRun {
  return {
    runId: runId(projectId, issue.id),
    projectId,
    issue,
    status: "target-pending",
    lifecyclePhase: "intake",
    workspacePath: null,
    branchName: branchNameForIssue(issue.identifier),
    threadId: null,
    prUrl: null,
    executionTarget: null,
    cloudTask: null,
    pullRequest: null,
    currentStep: null,
    linearProgress: {
      commentId: null,
      commentUrl: null,
      ownedCommentIds: [],
      lastRenderedHash: null,
      lastUpdatedAt: null,
      lastMilestoneAt: null,
      lastFeedbackAt: null,
    },
    qualityGate: {
      reviewFixLoops: 0,
      lastReviewPassedAt: null,
      lastReviewSummary: null,
      lastReviewFindings: [],
      lastReviewedCommit: null,
      lastFixCommit: null,
      lastPublishedCommit: null,
      lastFeedbackFingerprint: null,
    },
    archivedAt: null,
    attempts: [],
    nextRetryAt: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  };
}
