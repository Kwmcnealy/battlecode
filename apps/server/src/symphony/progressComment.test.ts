import { describe, expect, it } from "vitest";

import {
  SYMPHONY_MANAGED_PROGRESS_MARKER,
  renderManagedProgressComment,
  renderMilestoneComment,
} from "./progressComment.ts";

describe("Symphony progress comments", () => {
  it("renders the managed progress marker and workflow status sections", () => {
    const comment = renderManagedProgressComment({
      phase: "in-review",
      lastUpdate: "2026-05-02T12:00:00.000Z",
      currentStep: "Reviewing the pull request",
      pullRequestUrl: "https://github.com/example/repo/pull/12",
      planMarkdown: "- [x] Implement helper slice\n- [ ] Wire service integration",
      reviewFindings: ["Missing Linear update test", "Retry state is not documented"],
    });

    expect(comment).toContain(SYMPHONY_MANAGED_PROGRESS_MARKER);
    expect(comment).toContain("# Symphony Progress");
    expect(comment).toContain("- Status: In Review");
    expect(comment).toContain("- Last update: 2026-05-02T12:00:00.000Z");
    expect(comment).not.toContain("- Execution:");
    expect(comment).toContain("- Current step: Reviewing the pull request");
    expect(comment).toContain("- PR: https://github.com/example/repo/pull/12");
    expect(comment).toContain("## Plan\n\n- [x] Implement helper slice");
    expect(comment).toContain("## Review Findings\n\n- Missing Linear update test");
  });

  it("renders missing progress fields explicitly", () => {
    const comment = renderManagedProgressComment({
      phase: "implementing",
      lastUpdate: "2026-05-02T12:00:00.000Z",
      currentStep: null,
      pullRequestUrl: null,
      planMarkdown: null,
    });

    expect(comment).toContain("- Status: Implementing");
    expect(comment).toContain("- Current step: Not started");
    expect(comment).toContain("- PR: Not available");
    expect(comment).toContain("## Plan\n\nNo plan captured yet.");
    expect(comment).not.toContain("## Review Findings");
  });

  it("renders milestone comments with optional detail", () => {
    expect(
      renderMilestoneComment({
        issueIdentifier: "APP-1",
        milestone: "PR opened",
        detail: "https://github.com/example/repo/pull/12",
      }),
    ).toBe("Symphony milestone for APP-1: PR opened\n\nhttps://github.com/example/repo/pull/12");

    expect(
      renderMilestoneComment({
        issueIdentifier: "APP-1",
        milestone: "PR opened",
        detail: null,
      }),
    ).toBe("Symphony milestone for APP-1: PR opened");
  });
});
