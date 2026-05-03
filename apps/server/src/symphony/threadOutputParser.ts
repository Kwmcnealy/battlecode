/**
 * Thread output parsing helpers for Symphony.
 *
 * Extracts structured markers from Codex thread output text.
 *
 * Today's callers are orchestrator.ts (pure decision logic) and
 * Layers/SymphonyService.ts (via reconcileRunWithThread phase dispatch).
 *
 * The transitional helpers (extractLatestPlanMarkdown, extractLatestAssistantText,
 * extractReviewOutcome) and their associated types were moved here from the
 * now-deleted phaseOutput.ts module. They support the legacy lifecycle-phase
 * dispatch in SymphonyService.ts while Task 4.6 removes it.
 *
 * @deprecated extractLatestPlanMarkdown, extractLatestAssistantText,
 *   extractReviewOutcome — remove with the lifecycle-phase dispatch in Task 4.6.
 */

const PLAN_BEGIN = "SYMPHONY_PLAN_BEGIN";
const PLAN_END = "SYMPHONY_PLAN_END";
const PR_URL_PREFIX = "SYMPHONY_PR_URL:";

// ---------------------------------------------------------------------------
// Transitional types (moved from phaseOutput.ts — delete with Task 4.6)
// ---------------------------------------------------------------------------

/** @deprecated Remove with lifecycle-phase dispatch in Task 4.6. */
export interface PhaseOutputProposedPlan {
  readonly planMarkdown: string;
  readonly updatedAt: string;
}

/** @deprecated Remove with lifecycle-phase dispatch in Task 4.6. */
export interface PhaseOutputMessage {
  readonly role: string;
  readonly text: string;
  readonly streaming: boolean;
  readonly updatedAt: string;
}

/** @deprecated Remove with lifecycle-phase dispatch in Task 4.6. */
export interface PhaseOutputThread {
  readonly proposedPlans: readonly PhaseOutputProposedPlan[];
  readonly messages: readonly PhaseOutputMessage[];
}

/** @deprecated Remove with lifecycle-phase dispatch in Task 4.6. */
export interface ReviewOutcome {
  readonly status: "pass" | "fail" | "unknown";
  readonly summary: string | null;
  readonly findings: readonly string[];
}

// ---------------------------------------------------------------------------
// Transitional helpers (moved from phaseOutput.ts — delete with Task 4.6)
// ---------------------------------------------------------------------------

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

const CHECKLIST_PATTERN = /^\s*(?:[-*+]|\d+\.)\s+\[[ xX]\]\s+/m;

/**
 * Extract the latest plan markdown from a thread.
 *
 * Prefers the newest proposedPlan by updatedAt; falls back to the newest
 * completed assistant message that contains a checklist pattern.
 *
 * @deprecated Use parsePlanFromOutput with raw text once all prompts emit
 *   SYMPHONY_PLAN_BEGIN/END markers (Task 4.6).
 */
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

/**
 * Extract the latest completed assistant message text from a thread.
 *
 * @deprecated Used only by extractReviewOutcome call site in Task 4.6 removal.
 */
export function extractLatestAssistantText(thread: PhaseOutputThread): string | null {
  return newestByUpdatedAt(completedAssistantMessages(thread))?.text ?? null;
}

const REVIEW_MARKER_PATTERN = /^REVIEW_(PASS|FAIL):\s*(.*)$/gim;

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

/**
 * Extract a REVIEW_PASS / REVIEW_FAIL outcome from thread output text.
 *
 * @deprecated Remove with the reviewing lifecycle phase in Task 4.6.
 */
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

/**
 * Extract plan steps from thread output.
 *
 * Looks for a SYMPHONY_PLAN_BEGIN / SYMPHONY_PLAN_END block and returns
 * the checklist items inside it. Returns null if no valid block is found.
 */
export function parsePlanFromOutput(text: string): readonly string[] | null {
  const beginIdx = text.indexOf(PLAN_BEGIN);
  if (beginIdx === -1) return null;
  const endIdx = text.indexOf(PLAN_END, beginIdx);
  if (endIdx === -1) return null;
  const block = text.slice(beginIdx + PLAN_BEGIN.length, endIdx);
  const items = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- [ ] ") || line.startsWith("- [x] "))
    .map((line) => line.slice("- [ ] ".length).trim());
  return items.length === 0 ? null : items;
}

/**
 * Extract a GitHub PR URL from thread output.
 *
 * Looks for a line starting with `SYMPHONY_PR_URL:` and returns the URL.
 * Returns null if no valid PR URL line is found.
 */
export function parsePRUrlFromOutput(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(PR_URL_PREFIX)) {
      const url = trimmed.slice(PR_URL_PREFIX.length).trim();
      if (url.startsWith("https://github.com/")) {
        return url;
      }
    }
  }
  return null;
}
