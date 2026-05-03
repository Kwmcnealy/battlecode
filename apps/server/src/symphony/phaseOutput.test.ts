import { describe, expect, it } from "vitest";

import {
  extractLatestAssistantText,
  extractLatestPlanMarkdown,
  extractReviewOutcome,
  type PhaseOutputThread,
} from "./phaseOutput.ts";

function makeThread(overrides: Partial<PhaseOutputThread> = {}): PhaseOutputThread {
  return {
    proposedPlans: [],
    messages: [],
    ...overrides,
  };
}

describe("Symphony phase output extraction", () => {
  it("prefers the newest proposed plan by updated timestamp", () => {
    const plan = extractLatestPlanMarkdown(
      makeThread({
        proposedPlans: [
          {
            planMarkdown: "- [ ] Older plan",
            updatedAt: "2026-05-02T12:00:00.000Z",
          },
          {
            planMarkdown: "- [ ] Newer plan",
            updatedAt: "2026-05-02T12:05:00.000Z",
          },
        ],
      }),
    );

    expect(plan).toBe("- [ ] Newer plan");
  });

  it("falls back to the newest completed assistant checklist", () => {
    const plan = extractLatestPlanMarkdown(
      makeThread({
        messages: [
          {
            role: "assistant",
            text: "- [ ] Older checklist",
            streaming: false,
            updatedAt: "2026-05-02T12:00:00.000Z",
          },
          {
            role: "assistant",
            text: "still streaming\n- [ ] Ignore me",
            streaming: true,
            updatedAt: "2026-05-02T12:10:00.000Z",
          },
          {
            role: "assistant",
            text: "No checklist here",
            streaming: false,
            updatedAt: "2026-05-02T12:11:00.000Z",
          },
          {
            role: "assistant",
            text: "1. [ ] Newer checklist",
            streaming: false,
            updatedAt: "2026-05-02T12:05:00.000Z",
          },
        ],
      }),
    );

    expect(plan).toBe("1. [ ] Newer checklist");
  });

  it("extracts the newest completed assistant text", () => {
    const text = extractLatestAssistantText(
      makeThread({
        messages: [
          {
            role: "assistant",
            text: "Older response",
            streaming: false,
            updatedAt: "2026-05-02T12:00:00.000Z",
          },
          {
            role: "assistant",
            text: "Streaming response",
            streaming: true,
            updatedAt: "2026-05-02T12:10:00.000Z",
          },
          {
            role: "assistant",
            text: "Newest completed response",
            streaming: false,
            updatedAt: "2026-05-02T12:05:00.000Z",
          },
        ],
      }),
    );

    expect(text).toBe("Newest completed response");
  });

  it("parses pass and fail review markers", () => {
    expect(extractReviewOutcome("Looks good.\nREVIEW_PASS: Ready to open PR")).toEqual({
      status: "pass",
      summary: "Ready to open PR",
      findings: [],
    });

    expect(
      extractReviewOutcome(
        [
          "Review notes",
          "REVIEW_FAIL: Missing updateLinearComment failure handling",
          "- Add a parser test",
          "- Keep retry behavior unchanged",
        ].join("\n"),
      ),
    ).toEqual({
      status: "fail",
      summary: "Missing updateLinearComment failure handling",
      findings: [
        "Missing updateLinearComment failure handling",
        "Add a parser test",
        "Keep retry behavior unchanged",
      ],
    });
  });

  it("returns unknown when no review marker is present", () => {
    expect(extractReviewOutcome("No marker yet")).toEqual({
      status: "unknown",
      summary: null,
      findings: [],
    });
  });
});
