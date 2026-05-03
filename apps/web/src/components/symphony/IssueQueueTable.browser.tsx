import "../../index.css";

import {
  ProjectId,
  SymphonyIssueId,
  SymphonyRunId,
  ThreadId,
  type SymphonyRun,
} from "@t3tools/contracts";
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
      title: "Implement Symphony routing",
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
    pullRequest: null,
    currentStep: null,
    linearProgress: {
      commentId: null,
      commentUrl: null,
      ownedCommentIds: [],
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
      lastReviewedCommit: null,
      lastFixCommit: null,
      lastPublishedCommit: null,
      lastFeedbackFingerprint: null,
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

describe("IssueQueueTable", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("offers a local launch action for target-pending rows", async () => {
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
      await userEvent.click(page.getByRole("button", { name: "Run", exact: true }));

      expect(onIssueAction.mock.calls.map((call) => call[0])).toEqual(["launch"]);
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
      await userEvent.click(page.getByText("Implement Symphony routing"));

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

  it("shows the Open Thread button when a thread is linked", async () => {
    const onOpenLinkedThread = vi.fn();
    const screen = await render(
      <IssueQueueTable
        runs={[
          makeRun({
            status: "running",
            lifecyclePhase: "implementing",
            threadId: ThreadId.make("thread-1"),
          }),
        ]}
        busyAction={null}
        selectedRunId={null}
        onSelectRun={vi.fn()}
        onIssueAction={vi.fn()}
        onOpenLinkedThread={onOpenLinkedThread}
      />,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Open Thread" })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
