import { describe, expect, it } from "vitest";

import { parseWorkflowMarkdown, resolveWorkflowPath } from "./workflow.ts";

describe("Symphony workflow parsing", () => {
  it("parses YAML front matter and normalizes spec snake_case keys", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: linear
  project_slug: battlecode
polling:
  interval_ms: 5000
agent:
  max_concurrent_agents: 3
hooks:
  after_create: |
    echo ready
---

Work on {{ issue.identifier }}.
`);

    expect(workflow.config.tracker.projectSlug).toBe("battlecode");
    expect(workflow.config.polling.intervalMs).toBe(5000);
    expect(workflow.config.agent.maxConcurrentAgents).toBe(3);
    expect(workflow.config.hooks.afterCreate).toBe("echo ready\n");
    expect(workflow.promptTemplate).toBe("Work on {{ issue.identifier }}.");
  });

  it("applies spec defaults when sections are omitted", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  project_slug: battlecode
---

Run the issue.
`);

    expect(workflow.config.tracker.kind).toBe("linear");
    expect(workflow.config.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(workflow.config.polling.intervalMs).toBe(30_000);
    expect(workflow.config.agent.maxConcurrentAgents).toBe(10);
  });

  it("rejects a workflow without a prompt body", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  project_slug: battlecode
---
`),
    ).toThrow(/prompt body/i);
  });
});

describe("Symphony workflow path safety", () => {
  it("keeps selected workflow files inside the project root", () => {
    expect(resolveWorkflowPath("/repo/project", "docs/WORKFLOW.md")).toBe(
      "/repo/project/docs/WORKFLOW.md",
    );
    expect(resolveWorkflowPath("/repo/project", "/repo/project/WORKFLOW.md")).toBe(
      "/repo/project/WORKFLOW.md",
    );
  });

  it("rejects workflow paths outside the project root", () => {
    expect(() => resolveWorkflowPath("/repo/project", "../WORKFLOW.md")).toThrow(
      /inside the project root/i,
    );
  });
});
