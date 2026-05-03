import { describe, expect, it } from "vitest";

import { doingPrompt, planningPrompt } from "./prompts.ts";

const issue = {
  id: "iss_1",
  identifier: "ENG-42",
  title: "Add the thing",
  description: "Make X do Y",
  url: "https://linear.app/team/issue/ENG-42",
};

const workflow = {
  validation: ["bun fmt", "bun lint", "bun typecheck", "bun run test"],
  prBaseBranch: "development",
  branchName: "symphony/eng-42",
  bodyMarkdown: "# Repo guidance\n\nFollow the simplify skill before PR.",
};

describe("planningPrompt", () => {
  it("instructs the agent to emit SYMPHONY_PLAN_BEGIN/END markers", () => {
    const text = planningPrompt({ issue, workflow });
    expect(text).toContain("SYMPHONY_PLAN_BEGIN");
    expect(text).toContain("SYMPHONY_PLAN_END");
  });

  it("includes the issue identifier and title", () => {
    const text = planningPrompt({ issue, workflow });
    expect(text).toContain("ENG-42");
    expect(text).toContain("Add the thing");
  });

  it("includes the issue URL", () => {
    const text = planningPrompt({ issue, workflow });
    expect(text).toContain("https://linear.app/team/issue/ENG-42");
  });

  it("includes the repo guidance body", () => {
    const text = planningPrompt({ issue, workflow });
    expect(text).toContain("Follow the simplify skill before PR.");
  });

  it("includes the issue description", () => {
    const text = planningPrompt({ issue, workflow });
    expect(text).toContain("Make X do Y");
  });

  it("tells the agent not to implement in this turn", () => {
    const text = planningPrompt({ issue, workflow });
    expect(text).toContain("Do not implement");
  });
});

describe("doingPrompt", () => {
  it("instructs the agent to emit SYMPHONY_PR_URL after gh pr create", () => {
    const text = doingPrompt({ issue, workflow, plan: ["Step one"] });
    expect(text).toContain("SYMPHONY_PR_URL");
    expect(text).toContain("gh pr create");
  });

  it("references each validation command", () => {
    const text = doingPrompt({ issue, workflow, plan: ["Step one"] });
    for (const cmd of workflow.validation) {
      expect(text).toContain(cmd);
    }
  });

  it("includes the previously-approved plan as a reminder", () => {
    const text = doingPrompt({ issue, workflow, plan: ["Step one", "Step two"] });
    expect(text).toContain("Step one");
    expect(text).toContain("Step two");
  });

  it("references the PR base branch", () => {
    const text = doingPrompt({ issue, workflow, plan: ["Step one"] });
    expect(text).toContain("development");
  });

  it("includes the branch name", () => {
    const text = doingPrompt({ issue, workflow, plan: ["Step one"] });
    expect(text).toContain("symphony/eng-42");
  });

  it("includes the repo guidance body", () => {
    const text = doingPrompt({ issue, workflow, plan: ["Step one"] });
    expect(text).toContain("Follow the simplify skill before PR.");
  });
});
