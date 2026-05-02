import "../../index.css";

import {
  EnvironmentId,
  ProjectId,
  SymphonyIssueId,
  SymphonyRunId,
  type EnvironmentApi,
  type SymphonyRun,
  type SymphonySettings,
  type SymphonySnapshot,
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
    status: "review-ready",
    workspacePath: null,
    branchName: `symphony/bc-${id}`,
    threadId: null,
    prUrl: `https://github.com/t3/battlecode/pull/${id}`,
    executionTarget: "codex-cloud",
    cloudTask: null,
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
    executionDefaultTarget: "local",
    updatedAt: CREATED_AT,
  };
}

function makeSnapshot(input: {
  readonly activeRuns?: readonly SymphonyRun[];
  readonly archivedRuns?: readonly SymphonyRun[];
}): SymphonySnapshot {
  const activeRuns = input.activeRuns ?? [];
  const archivedRuns = input.archivedRuns ?? [];
  return {
    projectId: PROJECT_ID,
    status: "idle",
    settings: makeSettings(),
    queues: {
      pendingTarget: [],
      eligible: [],
      running: activeRuns,
      retrying: [],
      completed: [],
      failed: [],
      canceled: [],
      archived: archivedRuns,
    },
    totals: {
      pendingTarget: 0,
      eligible: 0,
      running: activeRuns.length,
      retrying: 0,
      completed: 0,
      failed: 0,
      canceled: 0,
      archived: archivedRuns.length,
    },
    events: [],
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
      stopIssue: vi.fn(async () => input.snapshotRef.current),
      retryIssue: vi.fn(async () => input.snapshotRef.current),
      openLinkedThread: vi.fn(async () => ({ threadId: null })),
      launchIssue: vi.fn(async () => input.snapshotRef.current),
      updateExecutionDefault: vi.fn(async () => input.snapshotRef.current.settings),
      refreshCloudStatus: vi.fn(async () => input.snapshotRef.current),
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
    const activeRun = makeRun("1", "Active cloud run");
    const archivedRun = makeRun("2", "Archived cloud run", {
      status: "completed",
      archivedAt: ARCHIVED_AT,
      pullRequest: {
        number: 2,
        title: "Archived cloud run",
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
      await expect.element(page.getByText("Active cloud run")).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Archived cloud run");

      await userEvent.click(page.getByRole("button", { name: /Archived/ }));

      await expect.element(page.getByText("Archived cloud run")).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Active cloud run");

      await userEvent.click(page.getByText("Archived cloud run"));
      await expect.element(page.getByText("Archived at")).toBeInTheDocument();
      await expect.element(page.getByText("Merged")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the drawer open when a selected run becomes archived by snapshot update", async () => {
    const activeRun = makeRun("3", "Selected cloud run");
    const archivedRun = makeRun("3", "Selected cloud run", {
      status: "completed",
      archivedAt: ARCHIVED_AT,
      pullRequest: {
        number: 3,
        title: "Selected cloud run",
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
      await expect.element(page.getByText("Selected cloud run")).toBeInTheDocument();
      await userEvent.click(page.getByText("Selected cloud run"));
      expect(document.body.textContent).toContain("Pull request open");

      snapshotRef.current = makeSnapshot({ archivedRuns: [archivedRun] });
      await act(async () => {
        subscriptionCallback?.({ kind: "snapshot", snapshot: snapshotRef.current });
      });

      await expect.element(page.getByText("Archived at")).toBeInTheDocument();
      expect(document.body.textContent).toContain("Pull request merged");
      await expect.element(page.getByText("Selected cloud run")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
