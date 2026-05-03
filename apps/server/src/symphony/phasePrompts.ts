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

export function buildPlanningPrompt(input: BasePhasePromptInput): string {
  return [
    "You are in the Symphony planning phase.",
    issueBlock(input.issue),
    workflowBlock(input.workflowPrompt),
    "Produce a comprehensive Markdown checklist plan for implementing this issue.",
    "Do not write code in this phase.",
  ].join("\n\n");
}

export function buildImplementationPrompt(input: PlanPhasePromptInput): string {
  return [
    "You are in the Symphony implementation phase.",
    issueBlock(input.issue),
    workflowBlock(input.workflowPrompt),
    planBlock(input.planMarkdown),
    "Implement the approved plan. Keep Linear updates to Symphony.",
  ].join("\n\n");
}

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
