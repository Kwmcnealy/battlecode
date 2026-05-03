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
  const baseRun: SymphonyRun = {
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
    lifecyclePhase: "intake",
    workspacePath: null,
    branchName: null,
    threadId: null,
    prUrl: null,
    executionTarget: null,
    cloudTask: null,
    pullRequest: null,
    currentStep: null,
    linearProgress: {
      commentId: null,
      commentUrl: null,
      lastRenderedHash: null,
      lastUpdatedAt: null,
      lastMilestoneAt: null,
      lastFeedbackAt: null,
    },
    qualityGate: {
      reviewFixLoops: 0,
      lastReviewPassedAt: null,
      lastReviewSummary: null,
      lastReviewFindings: [],
    },
    archivedAt: null,
    attempts: [],
    nextRetryAt: null,
    lastError: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
  return {
    ...baseRun,
    ...overrides,
    issue: {
      ...baseRun.issue,
      ...overrides.issue,
    },
  };
}

function makeCloudTask(
  overrides: Partial<NonNullable<SymphonyRun["cloudTask"]>> = {},
): NonNullable<SymphonyRun["cloudTask"]> {
  return {
    provider: "codex-cloud-linear",
    status: "submitted",
    taskUrl: null,
    linearCommentId: null,
    linearCommentUrl: null,
    repository: null,
    repositoryUrl: null,
    lastMessage: null,
    delegatedAt: CREATED_AT,
    lastCheckedAt: CREATED_AT,
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
    const onSelectRun = vi.fn();
    const screen = await render(
      <IssueQueueTable
        runs={[makeRun()]}
        busyAction={null}
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onIssueAction={onIssueAction}
        onOpenLinkedThread={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Intake")).toBeInTheDocument();
      await expect.element(page.getByText("Target Pending")).toBeInTheDocument();
      await userEvent.click(page.getByRole("button", { name: "Run Local", exact: true }));
      await userEvent.click(page.getByRole("button", { name: "Send to Cloud", exact: true }));

      expect(onIssueAction.mock.calls.map((call) => call[0])).toEqual([
        "launch-local",
        "launch-cloud",
      ]);
      expect(onSelectRun).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("selects rows when the issue body is clicked", async () => {
    const onSelectRun = vi.fn();
    const run = makeRun();
    const screen = await render(
      <IssueQueueTable
        runs={[run]}
        busyAction={null}
        selectedRunId={null}
        onSelectRun={onSelectRun}
        onIssueAction={vi.fn()}
        onOpenLinkedThread={vi.fn()}
      />,
    );

    try {
      await userEvent.click(page.getByText("Implement Symphony target routing"));

      expect(onSelectRun).toHaveBeenCalledWith(run);
    } finally {
      await screen.unmount();
    }
  });

  it("offers archive for inactive rows and forwards the archive action", async () => {
    const onIssueAction = vi.fn();
    const screen = await render(
      <IssueQueueTable
        runs={[makeRun({ status: "failed", lifecyclePhase: "failed" })]}
        busyAction={null}
        selectedRunId={null}
        onSelectRun={vi.fn()}
        onIssueAction={onIssueAction}
        onOpenLinkedThread={vi.fn()}
      />,
    );

    try {
      await userEvent.click(page.getByRole("button", { name: "Archive", exact: true }));

      expect(onIssueAction.mock.calls.map((call) => call[0])).toEqual(["archive"]);
    } finally {
      await screen.unmount();
    }
  });

  it("hides archive for active execution rows", async () => {
    const screen = await render(
      <IssueQueueTable
        runs={[makeRun({ status: "running", lifecyclePhase: "implementing" })]}
        busyAction={null}
        selectedRunId={null}
        onSelectRun={vi.fn()}
        onIssueAction={vi.fn()}
        onOpenLinkedThread={vi.fn()}
      />,
    );

    try {
      await expect
        .element(page.getByRole("button", { name: "Archive", exact: true }))
        .not.toBeInTheDocument();
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
            lifecyclePhase: "waiting-cloud",
            executionTarget: "codex-cloud",
            cloudTask: makeCloudTask({
              status: "detected",
              taskUrl: "https://codex.openai.com/tasks/task-123",
              linearCommentId: "comment-1",
            }),
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

  it("shows cloud setup diagnostics and Linear fallback actions for failed cloud replies", async () => {
    const screen = await render(
      <IssueQueueTable
        runs={[
          makeRun({
            status: "cloud-submitted",
            lifecyclePhase: "waiting-cloud",
            executionTarget: "codex-cloud",
            issue: {
              id: SymphonyIssueId.make("issue-app-1"),
              identifier: "APP-1",
              title: "Prepare cloud setup",
              description: null,
              priority: null,
              state: "Todo",
              branchName: null,
              url: "https://linear.app/t3/issue/APP-1",
              labels: [],
              blockedBy: [],
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
            cloudTask: makeCloudTask({
              status: "failed",
              linearCommentId: "comment-setup",
              linearCommentUrl: "https://linear.app/t3/issue/APP-1#comment-comment-setup",
              repository: "openai/codex",
              repositoryUrl: "https://github.com/openai/codex",
              delegatedAt: "2026-05-01T10:00:00.000Z",
              lastCheckedAt: "2026-05-01T10:01:00.000Z",
              lastMessage: "No suitable environment or repository is available.",
            }),
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
        .element(page.getByText("No suitable environment or repository is available."))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: /Open Linear Issue/i }))
        .toHaveAttribute("href", "https://linear.app/t3/issue/APP-1");
      await expect
        .element(page.getByRole("button", { name: "Refresh Cloud Status", exact: true }))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows launch failure diagnostics without cloud refresh on terminal rows", async () => {
    const screen = await render(
      <IssueQueueTable
        runs={[
          makeRun({
            status: "failed",
            lifecyclePhase: "failed",
            executionTarget: "codex-cloud",
            issue: {
              id: SymphonyIssueId.make("issue-app-2"),
              identifier: "APP-2",
              title: "Submit cloud run",
              description: null,
              priority: null,
              state: "Todo",
              branchName: null,
              url: "https://linear.app/t3/issue/APP-2",
              labels: [],
              blockedBy: [],
              createdAt: CREATED_AT,
              updatedAt: CREATED_AT,
            },
            cloudTask: makeCloudTask({
              status: "failed",
              delegatedAt: null,
            }),
            lastError: "Codex Cloud requires a GitHub origin remote for this project.",
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
      await expect
        .element(page.getByText("Codex Cloud requires a GitHub origin remote for this project."))
        .toBeInTheDocument();
      await expect
        .element(page.getByRole("link", { name: /Open Linear Issue/i }))
        .toHaveAttribute("href", "https://linear.app/t3/issue/APP-2");
      await expect
        .element(page.getByRole("button", { name: /Refresh Cloud Status/i }))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
