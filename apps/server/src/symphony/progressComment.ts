import type { SymphonyRunStatus } from "@t3tools/contracts";

export const SYMPHONY_MANAGED_PROGRESS_MARKER = "<!-- symphony-managed-progress v1 -->";

export interface ManagedProgressCommentInput {
  readonly phase: SymphonyRunStatus;
  readonly lastUpdate: string;
  readonly currentStep: string | null;
  readonly pullRequestUrl: string | null;
  readonly planMarkdown: string | null;
  readonly reviewFindings?: readonly string[];
}

export interface MilestoneCommentInput {
  readonly issueIdentifier: string;
  readonly milestone: string;
  readonly detail?: string | null;
}

function runStatusLabel(status: SymphonyRunStatus): string {
  switch (status) {
    case "intake":
      return "Intake";
    case "planning":
      return "Planning";
    case "implementing":
      return "Implementing";
    case "in-review":
      return "In Review";
    case "completed":
      return "Completed";
    case "canceled":
      return "Canceled";
    case "failed":
      return "Failed";
  }
}

function renderReviewFindings(findings: readonly string[] | undefined): string | null {
  const normalizedFindings = (findings ?? []).map((finding) => finding.trim()).filter(Boolean);
  if (normalizedFindings.length === 0) {
    return null;
  }
  return `## Review Findings\n\n${normalizedFindings.map((finding) => `- ${finding}`).join("\n")}`;
}

export function renderManagedProgressComment(input: ManagedProgressCommentInput): string {
  const planMarkdown = input.planMarkdown?.trim() || "No plan captured yet.";
  const reviewFindings = renderReviewFindings(input.reviewFindings);
  const sections = [
    SYMPHONY_MANAGED_PROGRESS_MARKER,
    "# Symphony Progress",
    [
      `- Status: ${runStatusLabel(input.phase)}`,
      `- Last update: ${input.lastUpdate}`,
      `- Current step: ${input.currentStep?.trim() || "Not started"}`,
      `- PR: ${input.pullRequestUrl?.trim() || "Not available"}`,
    ].join("\n"),
    `## Plan\n\n${planMarkdown}`,
  ];

  if (reviewFindings) {
    sections.push(reviewFindings);
  }

  return `${sections.join("\n\n")}\n`;
}

export function renderMilestoneComment(input: MilestoneCommentInput): string {
  const heading = `Symphony milestone for ${input.issueIdentifier}: ${input.milestone}`;
  const detail = input.detail?.trim();
  return detail ? `${heading}\n\n${detail}` : heading;
}
