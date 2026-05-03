import { describe, expect, it } from "vitest";

import {
  buildFixPrompt,
  buildImplementationPrompt,
  buildPlanningPrompt,
  buildReviewPrompt,
  buildSimplificationPrompt,
} from "./phasePrompts.ts";

const issue = {
  issueId: "APP-1",
  title: "Automate release workflow",
  description: "Ship Symphony control-plane automation.",
};

describe("Symphony phase prompts", () => {
  it("builds a planning prompt that asks for a checklist and forbids code changes", () => {
    const prompt = buildPlanningPrompt({
      issue,
      workflowPrompt: "Use the repository workflow.",
    });

    expect(prompt).toContain("Issue ID: APP-1");
    expect(prompt).toContain("Title: Automate release workflow");
    expect(prompt).toContain("Ship Symphony control-plane automation.");
    expect(prompt).toContain("Use the repository workflow.");
    expect(prompt).toContain("comprehensive Markdown checklist");
    expect(prompt).toContain("Do not write code in this phase.");
  });

  it("builds an implementation prompt from the approved plan", () => {
    const prompt = buildImplementationPrompt({
      issue,
      workflowPrompt: "Run focused validation.",
      planMarkdown: "- [ ] Add helper tests\n- [ ] Implement helpers",
    });

    expect(prompt).toContain("Implement the approved plan");
    expect(prompt).toContain("- [ ] Add helper tests");
    expect(prompt).toContain("Keep Linear updates to Symphony");
    expect(prompt).toContain("Run focused validation.");
  });

  it("builds simplification and review prompts with phase-specific instructions", () => {
    const simplificationPrompt = buildSimplificationPrompt({
      issue,
      workflowPrompt: "Preserve behavior.",
      planMarkdown: "- [x] Implementation complete",
      phaseInstructions: "Run the code simplifier.",
    });
    const reviewPrompt = buildReviewPrompt({
      issue,
      workflowPrompt: "Review the diff against the plan.",
      planMarkdown: "- [x] Implementation complete",
      phaseInstructions: "Prioritize regressions.",
    });

    expect(simplificationPrompt).toContain("Simplify the implementation");
    expect(simplificationPrompt).toContain("Preserve behavior.");
    expect(simplificationPrompt).toContain("Run the code simplifier.");
    expect(reviewPrompt).toContain("REVIEW_PASS: <summary>");
    expect(reviewPrompt).toContain("REVIEW_FAIL: <first finding>");
    expect(reviewPrompt).toContain("Include exactly one review marker");
    expect(reviewPrompt).toContain("Prioritize regressions.");
  });

  it("builds a fix prompt that lists review findings and workflow instructions", () => {
    const prompt = buildFixPrompt({
      issue,
      workflowPrompt: "Fix only reviewed defects.",
      findings: ["Missing coverage for failed update", "Progress comment omits PR URL"],
    });

    expect(prompt).toContain("Fix the review findings");
    expect(prompt).toContain("- Missing coverage for failed update");
    expect(prompt).toContain("- Progress comment omits PR URL");
    expect(prompt).toContain("Fix only reviewed defects.");
  });
});
