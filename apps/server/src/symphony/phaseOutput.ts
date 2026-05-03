export interface PhaseOutputProposedPlan {
  readonly planMarkdown: string;
  readonly updatedAt: string;
}

export interface PhaseOutputMessage {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly updatedAt: string;
}

export interface PhaseOutputThread {
  readonly proposedPlans: readonly PhaseOutputProposedPlan[];
  readonly messages: readonly PhaseOutputMessage[];
}

export interface ReviewOutcome {
  readonly status: "pass" | "fail" | "unknown";
  readonly summary: string | null;
  readonly findings: readonly string[];
}

const CHECKLIST_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s+/m;
const REVIEW_MARKER_PATTERN = /^REVIEW_(PASS|FAIL):\s*(.*)$/gim;

function timestampValue(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newestByUpdatedAt<T extends { readonly updatedAt: string }>(
  items: readonly T[],
): T | null {
  return (
    items.toSorted(
      (left, right) => timestampValue(right.updatedAt) - timestampValue(left.updatedAt),
    )[0] ?? null
  );
}

function completedAssistantMessages(thread: PhaseOutputThread): readonly PhaseOutputMessage[] {
  return thread.messages.filter(
    (message) =>
      message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
  );
}

export function extractLatestPlanMarkdown(thread: PhaseOutputThread): string | null {
  const newestPlan = newestByUpdatedAt(
    thread.proposedPlans.filter((plan) => plan.planMarkdown.trim().length > 0),
  );
  if (newestPlan) {
    return newestPlan.planMarkdown;
  }

  const newestChecklistMessage = newestByUpdatedAt(
    completedAssistantMessages(thread).filter((message) => CHECKLIST_PATTERN.test(message.text)),
  );
  return newestChecklistMessage?.text ?? null;
}

export function extractLatestAssistantText(thread: PhaseOutputThread): string | null {
  return newestByUpdatedAt(completedAssistantMessages(thread))?.text ?? null;
}

function parseReviewMarkers(text: string): readonly RegExpExecArray[] {
  REVIEW_MARKER_PATTERN.lastIndex = 0;
  return Array.from(text.matchAll(REVIEW_MARKER_PATTERN));
}

function parseBulletFindings(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .flatMap((line) => {
      const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
      return match?.[1] ? [match[1].trim()] : [];
    })
    .filter(Boolean);
}

export function extractReviewOutcome(text: string): ReviewOutcome {
  const marker = parseReviewMarkers(text).at(-1);
  if (!marker) {
    return {
      status: "unknown",
      summary: null,
      findings: [],
    };
  }

  const markerKind = marker[1];
  const markerSummary = marker[2]?.trim() ?? "";

  if (markerKind === "PASS") {
    return {
      status: "pass",
      summary: markerSummary || "Review passed.",
      findings: [],
    };
  }

  const remainingText = text.slice((marker.index ?? 0) + marker[0].length);
  const bulletFindings = parseBulletFindings(remainingText);
  const summary = markerSummary || bulletFindings[0] || "Review failed.";
  return {
    status: "fail",
    summary,
    findings: [summary, ...bulletFindings],
  };
}
