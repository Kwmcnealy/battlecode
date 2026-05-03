import "../../index.css";

import {
  EnvironmentId,
  ProjectId,
  SymphonyIssueId,
  SymphonyRunId,
  type EnvironmentApi,
  type SymphonyEvent,
  type SymphonyRun,
  type SymphonySettings,
  type SymphonySnapshot,
  type SymphonySnapshotDiagnostics,
  type SymphonySubscribeEvent,
} from "@t3tools/contracts";
import { act } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { useUiStateStore } from "../../uiStateStore";
import { SymphonyPanel } from "./SymphonyPanel";

const ENVIRONMENT_ID = EnvironmentId.make("environment-symphony");
const PROJECT_ID = ProjectId.make("project-symphony");
const CREATED_AT = "2026-05-02T12:00:00.000Z";
const ARCHIVED_AT = "2026-05-02T12:30:00.000Z";

function makeRun(id: string, title: string, overrides: Partial<SymphonyRun> = {}): SymphonyRun {
  const issueId = SymphonyIssueId.make(`issue-${id}`);
  const baseRun: SymphonyRun = {
    runId: SymphonyRunId.make(`run-${id}`),
    projectId: PROJECT_ID,
    issue: {
      id: issueId,
      identifier: `BC-${id}`,
      title,
      description: null,
      priority: null,
      state: "In Review",
      branchName: null,
      url: `https://linear.app/t3/issue/BC-${id}`,
      labels: [],
      blockedBy: [],
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    status: "in-review",
    workspacePath: null,
    branchName: `symphony/bc-${id}`,
    threadId: null,
    prUrl: `https://github.com/t3/battlecode/pull/${id}`,
    pullRequest: {
      number: Number(id),
      title,
      url: `https://github.com/t3/battlecode/pull/${id}`,
      baseBranch: "development",
      headBranch: `symphony/bc-${id}`,
      state: "open",
      updatedAt: CREATED_AT,
    },
    currentStep: {
      source: "github",
      label: "Pull request open",
      detail: null,
      updatedAt: CREATED_AT,
    },
    linearProgress: {
      commentId: `comment-${id}`,
      commentUrl: `https://linear.app/t3/issue/BC-${id}#comment-comment-${id}`,
      ownedCommentIds: [],
      lastRenderedHash: null,
      lastUpdatedAt: CREATED_AT,
      lastMilestoneAt: CREATED_AT,
      lastFeedbackAt: null,
    },
    qualityGate: {
      reviewFixLoops: 0,
      lastReviewPassedAt: CREATED_AT,
      lastReviewSummary: "Ready for PR review",
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

function makeSettings(): SymphonySettings {
  return {
    projectId: PROJECT_ID,
    workflowPath: "WORKFLOW.md",
    workflowStatus: {
      status: "valid",
      message: "Workflow validated",
      validatedAt: CREATED_AT,
      configHash: "workflow-hash",
    },
    linearSecret: {
      source: "stored",
      configured: true,
      lastTestedAt: CREATED_AT,
      lastError: null,
    },
    updatedAt: CREATED_AT,
  };
}

function makeSnapshot(input: {
  readonly activeRuns?: readonly SymphonyRun[];
  readonly archivedRuns?: readonly SymphonyRun[];
  readonly diagnostics?: SymphonySnapshotDiagnostics;
  readonly events?: readonly SymphonyEvent[];
}): SymphonySnapshot {
  const activeRuns = input.activeRuns ?? [];
  const archivedRuns = input.archivedRuns ?? [];
  return {
    projectId: PROJECT_ID,
    status: "idle",
    settings: makeSettings(),
    queues: {
      intake: [],
      planning: [],
      implementing: activeRuns,
      "in-review": [],
      completed: [],
      failed: [],
      canceled: [],
      archived: archivedRuns,
    },
    totals: {
      intake: 0,
      planning: 0,
      implementing: activeRuns.length,
      "in-review": 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      archived: archivedRuns.length,
    },
    events: [...(input.events ?? [])],
    ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
    updatedAt: CREATED_AT,
  };
}

function makeEnvironmentApi(input: {
  readonly snapshotRef: { current: SymphonySnapshot };
  readonly onSubscribe: (callback: (event: SymphonySubscribeEvent) => void) => void;
}): EnvironmentApi {
  return {
    symphony: {
      getSnapshot: vi.fn(async () => input.snapshotRef.current),
      subscribe: vi.fn((_request: { readonly projectId: ProjectId }, callback) => {
        input.onSubscribe(callback);
        return () => input.onSubscribe(() => undefined);
      }),
      start: vi.fn(async () => input.snapshotRef.current),
      pause: vi.fn(async () => input.snapshotRef.current),
      resume: vi.fn(async () => input.snapshotRef.current),
      refresh: vi.fn(async () => input.snapshotRef.current),
      archiveIssue: vi.fn(async () => input.snapshotRef.current),
      stopIssue: vi.fn(async () => input.snapshotRef.current),
      retryIssue: vi.fn(async () => input.snapshotRef.current),
      openLinkedThread: vi.fn(async () => ({ threadId: null })),
      launchIssue: vi.fn(async () => input.snapshotRef.current),
    },
  } as unknown as EnvironmentApi;
}

function resetUiState() {
  useUiStateStore.setState({
    projectExpandedById: {},
    projectOrder: [],
    symphonyExpandedByProjectKey: {},
    selectedSymphonyRunByProjectKey: {},
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    threadActiveViewByKey: {},
  });
}

describe("SymphonyPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    __resetEnvironmentApiOverridesForTests();
    resetUiState();
    vi.restoreAllMocks();
  });

  it("hides archived runs by default and shows them in the archived view", async () => {
    const activeRun = makeRun("1", "Active run");
    const archivedRun = makeRun("2", "Archived run", {
      status: "completed",
      archivedAt: ARCHIVED_AT,
      pullRequest: {
        number: 2,
        title: "Archived run",
        url: "https://github.com/t3/battlecode/pull/2",
        baseBranch: "development",
        headBranch: "symphony/bc-2",
        state: "merged",
        updatedAt: ARCHIVED_AT,
      },
    });
    const snapshotRef = {
      current: makeSnapshot({
        activeRuns: [activeRun],
        archivedRuns: [archivedRun],
      }),
    };
    __setEnvironmentApiOverrideForTests(
      ENVIRONMENT_ID,
      makeEnvironmentApi({
        snapshotRef,
        onSubscribe: () => undefined,
      }),
    );

    const screen = await render(
      <SymphonyPanel
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        projectName="Battlecode"
        projectCwd="/repo/battlecode"
        onOpenThread={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Active run")).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Archived run");

      await userEvent.click(page.getByRole("button", { name: /Archived/ }));

      await expect.element(page.getByText("Archived run")).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Active run");

      await userEvent.click(page.getByText("Archived run"));
      await expect.element(page.getByText("Archived at")).toBeInTheDocument();
      await expect.element(page.getByText("Merged")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the drawer open when a selected run becomes archived by snapshot update", async () => {
    const activeRun = makeRun("3", "Selected run");
    const archivedRun = makeRun("3", "Selected run", {
      status: "completed",
      archivedAt: ARCHIVED_AT,
      pullRequest: {
        number: 3,
        title: "Selected run",
        url: "https://github.com/t3/battlecode/pull/3",
        baseBranch: "development",
        headBranch: "symphony/bc-3",
        state: "merged",
        updatedAt: ARCHIVED_AT,
      },
      currentStep: {
        source: "github",
        label: "Pull request merged",
        detail: null,
        updatedAt: ARCHIVED_AT,
      },
    });
    const snapshotRef = {
      current: makeSnapshot({ activeRuns: [activeRun] }),
    };
    let subscriptionCallback: ((event: SymphonySubscribeEvent) => void) | null = null;
    __setEnvironmentApiOverrideForTests(
      ENVIRONMENT_ID,
      makeEnvironmentApi({
        snapshotRef,
        onSubscribe: (callback) => {
          subscriptionCallback = callback;
        },
      }),
    );

    const screen = await render(
      <SymphonyPanel
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        projectName="Battlecode"
        projectCwd="/repo/battlecode"
        onOpenThread={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Selected run")).toBeInTheDocument();
      await userEvent.click(page.getByText("Selected run"));
      expect(document.body.textContent).toContain("Pull request open");

      snapshotRef.current = makeSnapshot({ archivedRuns: [archivedRun] });
      await act(async () => {
        subscriptionCallback?.({ kind: "snapshot", snapshot: snapshotRef.current });
      });

      await expect.element(page.getByText("Archived at")).toBeInTheDocument();
      await expect.element(page.getByText("Pull request merged")).toBeInTheDocument();
      await expect.element(page.getByText("Selected run")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("archives an inactive run from the active view", async () => {
    const activeRun = makeRun("4", "Failed run to archive", {
      status: "failed",
      pullRequest: null,
      prUrl: null,
    });
    const archivedRun = {
      ...activeRun,
      archivedAt: ARCHIVED_AT,
    };
    const snapshotRef = {
      current: makeSnapshot({ activeRuns: [activeRun] }),
    };
    const api = makeEnvironmentApi({
      snapshotRef,
      onSubscribe: () => undefined,
    });
    vi.mocked(api.symphony.archiveIssue).mockImplementation(async () => {
      snapshotRef.current = makeSnapshot({ archivedRuns: [archivedRun] });
      return snapshotRef.current;
    });
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api);

    const screen = await render(
      <SymphonyPanel
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        projectName="Battlecode"
        projectCwd="/repo/battlecode"
        onOpenThread={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Failed run to archive")).toBeInTheDocument();
      await userEvent.click(page.getByRole("button", { name: "Archive", exact: true }));

      expect(api.symphony.archiveIssue).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        issueId: activeRun.issue.id,
      });
      expect(document.body.textContent).not.toContain("Failed run to archive");

      await userEvent.click(page.getByRole("button", { name: /Archived/ }));
      await expect.element(page.getByText("Failed run to archive")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("shows compact diagnostics and keeps rows visible across warning-only snapshots", async () => {
    const activeRun = makeRun("5", "Stable run");
    const snapshotRef = {
      current: makeSnapshot({
        activeRuns: [activeRun],
        diagnostics: {
          lastPollAt: "2026-05-02T12:10:00.000Z",
          queriedStates: ["Todo", "In Progress"],
          candidateCount: 3,
          warningSummary: {
            count: 0,
            latestMessage: null,
          },
          errorSummary: {
            count: 0,
            latestMessage: null,
          },
        },
      }),
    };
    let subscriptionCallback: ((event: SymphonySubscribeEvent) => void) | null = null;
    __setEnvironmentApiOverrideForTests(
      ENVIRONMENT_ID,
      makeEnvironmentApi({
        snapshotRef,
        onSubscribe: (callback) => {
          subscriptionCallback = callback;
        },
      }),
    );

    const screen = await render(
      <SymphonyPanel
        environmentId={ENVIRONMENT_ID}
        projectId={PROJECT_ID}
        projectName="Battlecode"
        projectCwd="/repo/battlecode"
        onOpenThread={vi.fn()}
      />,
    );

    try {
      await expect.element(page.getByText("Stable run")).toBeInTheDocument();
      await expect.element(page.getByText("States Todo, In Progress")).toBeInTheDocument();
      await expect.element(page.getByText("3 candidates")).toBeInTheDocument();

      const warningEvent: SymphonyEvent = {
        eventId: "event-warning-1",
        projectId: PROJECT_ID,
        runId: activeRun.runId,
        issueId: activeRun.issue.id,
        type: "run.signal-warning",
        message: "PR lookup warning",
        payload: {},
        createdAt: "2026-05-02T12:11:00.000Z",
      };
      snapshotRef.current = makeSnapshot({
        activeRuns: [{ ...activeRun }],
        diagnostics: {
          lastPollAt: "2026-05-02T12:11:00.000Z",
          queriedStates: ["Todo", "In Progress"],
          candidateCount: 3,
          warningSummary: {
            count: 1,
            latestMessage: "PR lookup warning",
          },
          errorSummary: {
            count: 0,
            latestMessage: null,
          },
        },
        events: [warningEvent],
      });
      await act(async () => {
        subscriptionCallback?.({ kind: "snapshot", snapshot: snapshotRef.current });
      });

      await expect.element(page.getByText("Stable run")).toBeInTheDocument();
      await expect.element(page.getByText("1 warnings")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
