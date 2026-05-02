import "../../index.css";

import { ProjectId, SymphonyIssueId, SymphonyRunId, type SymphonyRun } from "@t3tools/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { IssueQueueTable } from "./IssueQueueTable";

const PROJECT_ID = ProjectId.make("project-symphony");
const CREATED_AT = "2026-04-30T12:00:00.000Z";

function makeRun(overrides: Partial<SymphonyRun> = {}): SymphonyRun {
  const issueId = SymphonyIssueId.make(`issue-${overrides.status ?? "pending"}`);
  return {
    runId: SymphonyRunId.make(`run-${overrides.status ?? "pending"}`),
    projectId: PROJECT_ID,
    issue: {
      id: issueId,
      identifier: "BC-1",
      title: "Implement Symphony target routing",
      description: null,
      priority: null,
      state: "Todo",
      branchName: null,
      url: "https://linear.app/t3/issue/BC-1",
      labels: [],
      blockedBy: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    status: "target-pending",
    workspacePath: null,
    branchName: null,
    threadId: null,
    prUrl: null,
    executionTarget: null,
    cloudTask: null,
    attempts: [],
    nextRetryAt: null,
    lastError: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe("IssueQueueTable", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("offers local and cloud launch actions for target-pending rows", async () => {
    const onIssueAction = vi.fn();
    const screen = await render(
      <IssueQueueTable
        runs={[makeRun()]}
        busyAction={null}
        selectedRunId={null}
        onSelectRun={vi.fn()}
        onIssueAction={onIssueAction}
        onOpenLinkedThread={vi.fn()}
      />,
    );

    try {
      await userEvent.click(page.getByRole("button", { name: /Run Local/i }));
      await userEvent.click(page.getByRole("button", { name: /Send to Cloud/i }));

      expect(onIssueAction.mock.calls.map((call) => call[0])).toEqual([
        "launch-local",
        "launch-cloud",
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it("shows Codex task links for detected cloud runs", async () => {
    const screen = await render(
      <IssueQueueTable
        runs={[
          makeRun({
            status: "cloud-submitted",
            executionTarget: "codex-cloud",
            cloudTask: {
              provider: "codex-cloud-linear",
              status: "detected",
              taskUrl: "https://codex.openai.com/tasks/task-123",
              linearCommentId: "comment-1",
              delegatedAt: CREATED_AT,
              lastCheckedAt: CREATED_AT,
            },
          }),
        ]}
        busyAction={null}
        selectedRunId={null}
        onSelectRun={vi.fn()}
        onIssueAction={vi.fn()}
        onOpenLinkedThread={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Codex Cloud")).toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: /Open Codex Task/i }))
        .toHaveAttribute("href", "https://codex.openai.com/tasks/task-123");
    } finally {
      await screen.unmount();
    }
  });
});
