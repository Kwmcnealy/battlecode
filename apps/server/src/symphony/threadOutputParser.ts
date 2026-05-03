/**
 * Thread output parsing helpers for Symphony.
 *
 * Extracts structured markers from Codex thread output text.
 * Phase 4 will add comprehensive tests and may refine these implementations
 * to match the actual marker format emitted by phase prompts.
 *
 * Today's callers are orchestrator.ts (pure decision logic) and
 * Layers/SymphonyService.ts (via reconcileRunWithThread phase dispatch).
 */

const PLAN_BEGIN = "SYMPHONY_PLAN_BEGIN";
const PLAN_END = "SYMPHONY_PLAN_END";
const PR_URL_PREFIX = "SYMPHONY_PR_URL:";

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
