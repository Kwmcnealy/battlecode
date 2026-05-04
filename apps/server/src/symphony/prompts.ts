/**
 * Symphony agent prompt templates.
 *
 * @module
 *
 * Two-phase design:
 * - planningPrompt: emits SYMPHONY_PLAN_BEGIN / SYMPHONY_PLAN_END fences
 * - doingPrompt: implements the plan, emits SYMPHONY_PR_URL: <url>
 *
 * Legacy adapter functions (buildPlanningPrompt / buildImplementationPrompt /
 * buildSimplificationPrompt / buildReviewPrompt / buildFixPrompt) are kept
 * here for the transitional period while SymphonyService.ts is being
 * refactored (Task 4.6). They will be deleted when the lifecycle-phase
 * dispatch loop is removed.
 *
 * @deprecated buildPlanningPrompt, buildImplementationPrompt,
 *   buildSimplificationPrompt, buildReviewPrompt, buildFixPrompt — remove
 *   after Task 4.6 lands.
 *
 * Phase 1 (planningPrompt): the agent reads the Linear issue, produces a
 * structured checklist, and emits it inside SYMPHONY_PLAN_BEGIN/END fences.
 * Symphony parses the fences and posts the plan to Linear before Phase 2.
 *
 * Phase 2 (doingPrompt): the agent implements the plan, runs validation
 * commands, creates the PR, and emits SYMPHONY_PR_URL: <url> on its own line.
 */

export interface PromptIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string | null;
  readonly url: string | null;
}

export interface PromptWorkflow {
  readonly validation: readonly string[];
  readonly prBaseBranch: string;
  readonly branchName: string;
  readonly bodyMarkdown: string;
}

/**
 * Builds the planning-phase prompt.
 *
 * The agent should emit ONLY a structured plan checklist fenced by
 * SYMPHONY_PLAN_BEGIN / SYMPHONY_PLAN_END. No implementation in this turn.
 */
export function planningPrompt(input: {
  readonly issue: PromptIssue;
  readonly workflow: PromptWorkflow;
}): string {
  const { issue, workflow } = input;
  return [
    `You are picking up a Linear issue. Your first turn produces ONLY a structured plan checklist.`,
    ``,
    `## Linear issue`,
    `- Identifier: ${issue.identifier}`,
    `- Title: ${issue.title}`,
    `- URL: ${issue.url ?? "(no URL)"}`,
    ``,
    `## Description`,
    issue.description?.trim() || "(no description)",
    ``,
    `## Repo guidance`,
    workflow.bodyMarkdown.trim(),
    ``,
    `## Your output`,
    `Produce a comprehensive plan checklist. Each checklist item should be a single concrete action.`,
    `Wrap the checklist in these exact fence markers:`,
    ``,
    `SYMPHONY_PLAN_BEGIN`,
    `- [ ] First step`,
    `- [ ] Second step`,
    `SYMPHONY_PLAN_END`,
    ``,
    `Do not implement anything in this turn. Output only the plan.`,
  ].join("\n");
}

/**
 * Builds the doing-phase prompt.
 *
 * The agent should implement the approved plan, run validation gates, create
 * the PR with `gh pr create --base <prBaseBranch>`, then emit:
 *
 *   SYMPHONY_PR_URL: <url>
 *
 * on its own line at the end.
 */
export function doingPrompt(input: {
  readonly issue: PromptIssue;
  readonly workflow: PromptWorkflow;
  readonly plan: readonly string[];
}): string {
  const { issue, workflow, plan } = input;
  const planList = plan.map((item) => `- [ ] ${item}`).join("\n");
  const validationList = workflow.validation.map((cmd) => `- \`${cmd}\``).join("\n");
  return [
    `You are continuing the Linear issue ${issue.identifier}: "${issue.title}".`,
    ``,
    `## Plan`,
    planList,
    ``,
    `## Branch and PR`,
    `Your worktree is checked out on branch \`${workflow.branchName}\`.`,
    `When the plan is complete, run \`gh pr create --base ${workflow.prBaseBranch}\` and then emit a single line:`,
    ``,
    `SYMPHONY_PR_URL: <the PR URL from gh>`,
    ``,
    `## Validation gates`,
    `Before \`gh pr create\`, run each of these commands. If any fail, fix the cause and rerun until they pass:`,
    ``,
    validationList,
    ``,
    `## Repo guidance`,
    workflow.bodyMarkdown.trim(),
    ``,
    `Implement the plan now. End with the SYMPHONY_PR_URL line.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Legacy adapters — transitional until Task 4.6 removes lifecycle phases
// ---------------------------------------------------------------------------

export interface PhasePromptIssue {
  readonly issueId: string;
  readonly title: string;
  readonly description: string | null;
}

interface BasePhasePromptInput {
  readonly issue: PhasePromptIssue;
  readonly workflowPrompt: string;
}

export interface PlanPhasePromptInput extends BasePhasePromptInput {
  readonly planMarkdown: string;
  readonly phaseInstructions?: string | null;
}

export interface FixPhasePromptInput extends BasePhasePromptInput {
  readonly findings: readonly string[];
  readonly pullRequestUrl?: string | null;
}

function issueBlock(issue: PhasePromptIssue): string {
  return [
    "Issue",
    `Issue ID: ${issue.issueId}`,
    `Title: ${issue.title}`,
    "Description:",
    issue.description?.trim() || "No description provided.",
  ].join("\n");
}

function workflowBlock(workflowPrompt: string): string {
  return [
    "Workflow instructions",
    workflowPrompt.trim() || "No workflow instructions provided.",
  ].join("\n");
}

function planBlock(planMarkdown: string): string {
  return ["Approved plan", planMarkdown.trim() || "No approved plan was captured."].join("\n");
}

function phaseInstructionBlock(instructions: string | null | undefined): string | null {
  const normalized = instructions?.trim();
  return normalized ? ["Phase instructions", normalized].join("\n") : null;
}

/** @deprecated Remove after Task 4.6 removes the simplification phase. */
export function buildSimplificationPrompt(input: PlanPhasePromptInput): string {
  return [
    "You are in the Symphony simplification phase.",
    issueBlock(input.issue),
    workflowBlock(input.workflowPrompt),
    planBlock(input.planMarkdown),
    phaseInstructionBlock(input.phaseInstructions),
    "Simplify the implementation while preserving behavior and the approved plan scope.",
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

/** @deprecated Remove after Task 4.6 removes the review phase. */
export function buildReviewPrompt(input: PlanPhasePromptInput): string {
  return [
    "You are in the Symphony review phase.",
    issueBlock(input.issue),
    workflowBlock(input.workflowPrompt),
    planBlock(input.planMarkdown),
    phaseInstructionBlock(input.phaseInstructions),
    "Review the implementation against the approved plan and repository instructions.",
    [
      "Include exactly one review marker at the end of your response:",
      "REVIEW_PASS: <summary>",
      "REVIEW_FAIL: <first finding>",
      "- <additional finding>",
    ].join("\n"),
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}

/** @deprecated Remove after Task 4.6 removes the fix phase. */
export function buildFixPrompt(input: FixPhasePromptInput): string {
  const findings =
    input.findings
      .map((finding) => finding.trim())
      .filter(Boolean)
      .map((finding) => `- ${finding}`)
      .join("\n") || "- No specific findings were captured.";

  return [
    "You are in the Symphony fix phase.",
    issueBlock(input.issue),
    workflowBlock(input.workflowPrompt),
    input.pullRequestUrl ? `Pull request: ${input.pullRequestUrl}` : null,
    [
      "Fix the review findings below.",
      "Run focused validation for the changes.",
      "Commit any file changes with the required co-author trailer.",
      "Do not move Linear states or edit the managed Symphony progress comment.",
      "Do not stop after analysis only; either make the required code/test/docs change or report a true blocker.",
    ].join("\n"),
    findings,
  ]
    .filter((section): section is string => Boolean(section))
    .join("\n\n");
}
