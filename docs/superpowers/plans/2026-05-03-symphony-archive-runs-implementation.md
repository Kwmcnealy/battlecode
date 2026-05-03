# Symphony Archive Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local-only Symphony Archive action for inactive runs and automatically archive runs reconciled to terminal Done or Canceled truth.

**Architecture:** Reuse the existing `archivedAt` persistence field, Archived queue, Active/Archived Symphony view, and sidebar filtering. Add one shared archive eligibility policy in `@t3tools/shared/symphony`, wire a new `symphony.archiveIssue` RPC through contracts/server/web, enforce the policy server-side, and update terminal reconciliation to archive both completed and canceled runs.

**Tech Stack:** Bun workspace, Turborepo, Effect, Effect Schema RPC contracts, React 19, TypeScript, Vitest, Vitest browser, Tailwind, lucide-react.

---

## Files

- Create: `packages/shared/src/symphony.ts` — shared archive eligibility policy used by server and web.
- Create: `packages/shared/src/symphony.test.ts` — unit tests for allowed and blocked archive states.
- Modify: `packages/shared/package.json` — export `@t3tools/shared/symphony`.
- Modify: `packages/contracts/src/symphony.ts` — add `symphony.archiveIssue` method constant.
- Modify: `packages/contracts/src/ipc.ts` — add `archiveIssue` to `EnvironmentApi["symphony"]`.
- Modify: `packages/contracts/src/rpc.ts` — add `WsSymphonyArchiveIssueRpc` to the RPC group.
- Modify: `packages/contracts/src/symphony.test.ts` — assert the new method name and existing issue-action input shape.
- Modify: `apps/server/src/symphony/Services/SymphonyService.ts` — add `archiveIssue` to the service interface.
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts` — implement manual archive and update terminal auto-archive reconciliation.
- Modify: `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts` — add manual archive tests and terminal canceled/PR closed archive coverage.
- Modify: `apps/server/src/ws.ts` — expose the new RPC handler.
- Modify: `apps/web/src/rpc/wsRpcClient.ts` — expose `api.symphony.archiveIssue`.
- Modify: `apps/web/src/environmentApi.ts` — map `archiveIssue` through environment APIs.
- Modify: `apps/web/src/localApi.test.ts` — add the mock method to typed test fixtures.
- Modify: `apps/web/src/components/symphony/symphonyDisplay.ts` — add `"archive"` to `SymphonyAction`.
- Modify: `apps/web/src/components/symphony/IssueQueueTable.tsx` — show Archive only for inactive rows.
- Modify: `apps/web/src/components/symphony/IssueQueueTable.browser.tsx` — test button visibility and click behavior.
- Modify: `apps/web/src/components/symphony/SymphonyPanel.tsx` — call `archiveIssue` and commit the returned snapshot.
- Modify: `apps/web/src/components/symphony/SymphonyPanel.browser.tsx` — test Active to Archived movement after archive click.

No database migration is needed because `archivedAt` and the Archived queue already exist.

---

## Task 1: Add Shared Archive Eligibility Policy

**Files:**

- Create: `packages/shared/src/symphony.ts`
- Create: `packages/shared/src/symphony.test.ts`
- Modify: `packages/shared/package.json`

- [ ] **Step 1: Write the failing shared-policy tests**

Create `packages/shared/src/symphony.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SymphonyLifecyclePhase, SymphonyRunStatus } from "@t3tools/contracts";

import {
  SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
  canArchiveSymphonyRun,
  getSymphonyArchiveEligibility,
} from "./symphony.ts";

function runState(input: {
  readonly status: SymphonyRunStatus;
  readonly lifecyclePhase: SymphonyLifecyclePhase;
  readonly archivedAt?: string | null;
}) {
  return {
    status: input.status,
    lifecyclePhase: input.lifecyclePhase,
    archivedAt: input.archivedAt ?? null,
  };
}

describe("Symphony archive eligibility", () => {
  it("allows inactive runs to be manually archived", () => {
    for (const state of [
      runState({ status: "target-pending", lifecyclePhase: "intake" }),
      runState({ status: "eligible", lifecyclePhase: "intake" }),
      runState({ status: "failed", lifecyclePhase: "failed" }),
      runState({ status: "canceled", lifecyclePhase: "canceled" }),
      runState({ status: "completed", lifecyclePhase: "done" }),
      runState({ status: "released", lifecyclePhase: "done" }),
      runState({ status: "review-ready", lifecyclePhase: "in-review" }),
      runState({
        status: "completed",
        lifecyclePhase: "done",
        archivedAt: "2026-05-03T10:00:00.000Z",
      }),
    ]) {
      expect(canArchiveSymphonyRun(state)).toBe(true);
      expect(getSymphonyArchiveEligibility(state)).toEqual({
        canArchive: true,
        reason: null,
      });
    }
  });

  it("blocks active execution statuses", () => {
    for (const status of ["running", "retry-queued", "cloud-submitted", "cloud-running"] as const) {
      expect(
        getSymphonyArchiveEligibility(
          runState({
            status,
            lifecyclePhase: status.startsWith("cloud") ? "waiting-cloud" : "implementing",
          }),
        ),
      ).toEqual({
        canArchive: false,
        reason: SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
      });
    }
  });

  it("blocks active execution phases even when the status is stale", () => {
    for (const lifecyclePhase of [
      "planning",
      "implementing",
      "waiting-cloud",
      "simplifying",
      "reviewing",
      "fixing",
    ] as const) {
      expect(
        getSymphonyArchiveEligibility(
          runState({
            status: "eligible",
            lifecyclePhase,
          }),
        ),
      ).toEqual({
        canArchive: false,
        reason: SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
      });
    }
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
(cd packages/shared && bun run test src/symphony.test.ts)
```

Expected: fail because `packages/shared/src/symphony.ts` does not exist.

- [ ] **Step 3: Export the shared module**

In `packages/shared/package.json`, add this export next to the other explicit subpath exports:

```json
    "./symphony": {
      "types": "./src/symphony.ts",
      "import": "./src/symphony.ts"
    },
```

- [ ] **Step 4: Implement the shared policy**

Create `packages/shared/src/symphony.ts`:

```ts
import type { SymphonyLifecyclePhase, SymphonyRun, SymphonyRunStatus } from "@t3tools/contracts";

export const SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE =
  "Cannot archive a run while Symphony is actively working on it. Stop it first.";

const ARCHIVE_BLOCKED_STATUSES = new Set<SymphonyRunStatus>([
  "running",
  "retry-queued",
  "cloud-submitted",
  "cloud-running",
]);

const ARCHIVE_BLOCKED_PHASES = new Set<SymphonyLifecyclePhase>([
  "planning",
  "implementing",
  "waiting-cloud",
  "simplifying",
  "reviewing",
  "fixing",
]);

export interface SymphonyArchiveEligibility {
  readonly canArchive: boolean;
  readonly reason: string | null;
}

export function getSymphonyArchiveEligibility(
  run: Pick<SymphonyRun, "archivedAt" | "lifecyclePhase" | "status">,
): SymphonyArchiveEligibility {
  if (run.archivedAt !== null) {
    return { canArchive: true, reason: null };
  }
  if (ARCHIVE_BLOCKED_STATUSES.has(run.status) || ARCHIVE_BLOCKED_PHASES.has(run.lifecyclePhase)) {
    return {
      canArchive: false,
      reason: SYMPHONY_ACTIVE_ARCHIVE_ERROR_MESSAGE,
    };
  }
  return { canArchive: true, reason: null };
}

export function canArchiveSymphonyRun(
  run: Pick<SymphonyRun, "archivedAt" | "lifecyclePhase" | "status">,
): boolean {
  return getSymphonyArchiveEligibility(run).canArchive;
}
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
(cd packages/shared && bun run test src/symphony.test.ts)
```

Expected: pass.

- [ ] **Step 6: Commit Task 1**

```bash
git add packages/shared/package.json packages/shared/src/symphony.ts packages/shared/src/symphony.test.ts
git commit -m "feat(shared): add Symphony archive eligibility policy" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 2: Wire `symphony.archiveIssue` Through Contracts, RPC, and Server

**Files:**

- Modify: `packages/contracts/src/symphony.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/symphony.test.ts`
- Modify: `apps/server/src/symphony/Services/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/web/src/rpc/wsRpcClient.ts`
- Modify: `apps/web/src/environmentApi.ts`
- Modify: `apps/web/src/localApi.test.ts`

- [ ] **Step 1: Add contract tests for the new method**

In `packages/contracts/src/symphony.test.ts`, extend the existing method-name test:

```ts
expect(SYMPHONY_WS_METHODS.archiveIssue).toBe("symphony.archiveIssue");
```

Also add a small input decode assertion near the other Symphony input tests:

```ts
it("accepts archive issue action input", () => {
  const input = Schema.decodeUnknownSync(SymphonyIssueActionInput)({
    projectId: ProjectId.make("project-symphony"),
    issueId: "issue-archive",
  });

  expect(input.issueId).toBe("issue-archive");
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run:

```bash
(cd packages/contracts && bun run test src/symphony.test.ts)
```

Expected: fail because `SYMPHONY_WS_METHODS.archiveIssue` does not exist.

- [ ] **Step 3: Add the method constant**

In `packages/contracts/src/symphony.ts`, add this entry immediately after `retryIssue`:

```ts
  archiveIssue: "symphony.archiveIssue",
```

- [ ] **Step 4: Add the Environment API contract**

In `packages/contracts/src/ipc.ts`, add the method immediately after `retryIssue`:

```ts
archiveIssue: (input: SymphonyIssueActionInput) => Promise<SymphonySnapshot>;
```

- [ ] **Step 5: Add the RPC definition and group registration**

In `packages/contracts/src/rpc.ts`, add this definition immediately after `WsSymphonyRetryIssueRpc`:

```ts
export const WsSymphonyArchiveIssueRpc = Rpc.make(SYMPHONY_WS_METHODS.archiveIssue, {
  payload: SymphonyIssueActionInput,
  success: SymphonySnapshot,
  error: SymphonyError,
});
```

Then add `WsSymphonyArchiveIssueRpc` to `WsRpcGroup` immediately after `WsSymphonyRetryIssueRpc`:

```ts
  WsSymphonyArchiveIssueRpc,
```

- [ ] **Step 6: Add service interface support**

In `apps/server/src/symphony/Services/SymphonyService.ts`, add this method immediately after `retryIssue`:

```ts
  readonly archiveIssue: (
    input: SymphonyIssueActionInput,
  ) => Effect.Effect<SymphonySnapshot, SymphonyError>;
```

- [ ] **Step 7: Write manual archive service tests**

In `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`, add these tests inside the existing `layer("SymphonyService lifecycle reconciliation", ...)` block:

```ts
it.effect("archives an inactive run locally without changing Linear", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;
    yield* repository.upsertRun(
      makeServiceRun({
        status: "failed",
        lifecyclePhase: "failed",
        executionTarget: "local",
        workspacePath: projectRoot,
        branchName: "symphony/bc-1",
        currentStep: {
          source: "local-thread",
          label: "Codex turn failed",
          detail: "lint failed",
          updatedAt: CREATED_AT,
        },
        attempts: [
          {
            attempt: 1,
            status: "failed",
            startedAt: CREATED_AT,
            completedAt: "2026-05-02T12:05:00.000Z",
            error: "lint failed",
          },
        ],
        lastError: "lint failed",
      }),
    );

    const snapshot = yield* service.archiveIssue({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    });

    const run = yield* repository.getRunByIssue({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    });
    assert.strictEqual(run?.status, "failed");
    assert.strictEqual(run?.lifecyclePhase, "failed");
    assert.strictEqual(run?.currentStep?.label, "Codex turn failed");
    assert.strictEqual(run?.attempts.length, 1);
    assert.strictEqual(run?.lastError, "lint failed");
    assert.notStrictEqual(run?.archivedAt, null);
    assert.strictEqual(snapshot.totals.archived, 1);
    assert.strictEqual(snapshot.queues.failed.length, 0);
    expect(linearMocks.updateLinearIssueState).not.toHaveBeenCalled();
  }),
);

it.effect("rejects manual archive while a run is active", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;
    yield* repository.upsertRun(
      makeServiceRun({
        status: "running",
        lifecyclePhase: "implementing",
        executionTarget: "local",
      }),
    );

    const exit = yield* Effect.exit(
      service.archiveIssue({
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
      }),
    );

    assert.strictEqual(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.match(
        String(exit.cause),
        /Cannot archive a run while Symphony is actively working on it/,
      );
    }
    const run = yield* repository.getRunByIssue({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    });
    assert.strictEqual(run?.archivedAt, null);
  }),
);

it.effect("returns a fresh snapshot when archiving an already archived run", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;
    yield* repository.upsertRun(
      makeServiceRun({
        status: "canceled",
        lifecyclePhase: "canceled",
        archivedAt: "2026-05-02T12:30:00.000Z",
      }),
    );

    const snapshot = yield* service.archiveIssue({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    });

    assert.strictEqual(snapshot.totals.archived, 1);
    expect(linearMocks.updateLinearIssueState).not.toHaveBeenCalled();
  }),
);
```

- [ ] **Step 8: Run the service tests and verify they fail**

Run:

```bash
(cd apps/server && bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts)
```

Expected: fail because `archiveIssue` is not implemented.

- [ ] **Step 9: Implement `archiveIssue` in the service layer**

In `apps/server/src/symphony/Layers/SymphonyService.ts`, add this import:

```ts
import { getSymphonyArchiveEligibility } from "@t3tools/shared/symphony";
```

Add this function near `retryIssue`:

```ts
const archiveIssue: SymphonyServiceShape["archiveIssue"] = ({ projectId, issueId }) =>
  Effect.gen(function* () {
    const run = yield* repository
      .getRunByIssue({ projectId, issueId })
      .pipe(Effect.mapError(toSymphonyError("Failed to read Symphony run.")));
    if (!run) {
      return yield* buildSnapshot(projectId);
    }
    const eligibility = getSymphonyArchiveEligibility(run);
    if (!eligibility.canArchive) {
      return yield* new SymphonyError({
        message: eligibility.reason ?? "Symphony run cannot be archived right now.",
      });
    }
    if (run.archivedAt !== null) {
      return yield* buildSnapshot(projectId);
    }

    const archivedAt = nowIso();
    const nextRun: SymphonyRun = {
      ...run,
      archivedAt,
      updatedAt: archivedAt,
    };
    yield* repository
      .upsertRun(nextRun)
      .pipe(Effect.mapError(toSymphonyError("Failed to archive Symphony issue.")));
    yield* emitProjectEvent({
      projectId,
      issueId,
      runId: run.runId,
      type: "run.archived",
      message: `${run.issue.identifier} archived`,
      payload: {
        archivedAt,
        reason: "manual",
      },
    });
    return yield* buildSnapshot(projectId);
  });
```

Add `archiveIssue` to the returned service object immediately after `retryIssue`.

- [ ] **Step 10: Wire the server RPC handler**

In `apps/server/src/ws.ts`, add this handler immediately after `retryIssue`:

```ts
        [SYMPHONY_WS_METHODS.archiveIssue]: (input) =>
          observeRpcEffect(
            SYMPHONY_WS_METHODS.archiveIssue,
            symphony
              .archiveIssue(input)
              .pipe(
                Effect.mapError((cause) =>
                  toSymphonyError(cause, "Failed to archive Symphony issue"),
                ),
              ),
            { "rpc.aggregate": "symphony" },
          ),
```

- [ ] **Step 11: Wire the web RPC client and environment API**

In `apps/web/src/rpc/wsRpcClient.ts`, add this to `WsRpcClient["symphony"]` immediately after `retryIssue`:

```ts
    readonly archiveIssue: RpcUnaryMethod<typeof SYMPHONY_WS_METHODS.archiveIssue>;
```

Add this implementation immediately after `retryIssue`:

```ts
      archiveIssue: (input) =>
        transport.request((client) => client[SYMPHONY_WS_METHODS.archiveIssue](input)),
```

In `apps/web/src/environmentApi.ts`, add this immediately after `retryIssue`:

```ts
      archiveIssue: rpcClient.symphony.archiveIssue,
```

In `apps/web/src/localApi.test.ts`, add this to the `rpcClientMock.symphony` fixture immediately after `retryIssue`:

```ts
    archiveIssue: vi.fn(),
```

- [ ] **Step 12: Run focused tests and typecheck the touched packages**

Run:

```bash
(cd packages/contracts && bun run test src/symphony.test.ts)
(cd apps/server && bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts)
bun typecheck
```

Expected: the focused tests pass, and `bun typecheck` passes for the new RPC shape.

- [ ] **Step 13: Commit Task 2**

```bash
git add packages/contracts/src/symphony.ts packages/contracts/src/ipc.ts packages/contracts/src/rpc.ts packages/contracts/src/symphony.test.ts apps/server/src/symphony/Services/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts apps/server/src/ws.ts apps/web/src/rpc/wsRpcClient.ts apps/web/src/environmentApi.ts apps/web/src/localApi.test.ts
git commit -m "feat(symphony): add archive issue action" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 3: Archive Canceled Terminal Reconciliation

**Files:**

- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`

- [ ] **Step 1: Add terminal reconciliation assertions**

In `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`, update the existing `"maps Human Review, Done, and Canceled Linear states to lifecycle statuses"` test so the final Canceled assertion is:

```ts
assert.strictEqual(run?.status, "canceled");
assert.notStrictEqual(run?.archivedAt, null);
```

Add this PR closed coverage near the merged PR test:

```ts
it.effect("refreshes a known PR URL to closed, cancels the run, and archives it", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;
    yield* repository.upsertRun(
      makeServiceRun({
        status: "review-ready",
        executionTarget: "codex-cloud",
        branchName: "symphony/bc-1",
        prUrl: "https://github.com/t3/battlecode/pull/43",
        pullRequest: {
          number: 43,
          title: "Cancel cloud lifecycle",
          url: "https://github.com/t3/battlecode/pull/43",
          baseBranch: "development",
          headBranch: "symphony/bc-1",
          state: "open",
          updatedAt: CREATED_AT,
        },
      }),
    );
    githubMocks.getPullRequest.mockReturnValueOnce(
      Effect.succeed({
        number: 43,
        title: "Cancel cloud lifecycle",
        url: "https://github.com/t3/battlecode/pull/43",
        baseRefName: "development",
        headRefName: "symphony/bc-1",
        state: "closed",
        updatedAt: "2026-05-02T12:35:00.000Z",
      }),
    );

    yield* service.refreshCloudStatus({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    });

    const run = yield* repository.getRunByIssue({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    });
    assert.strictEqual(run?.status, "canceled");
    assert.strictEqual(run?.pullRequest?.state, "closed");
    assert.notStrictEqual(run?.archivedAt, null);
  }),
);
```

- [ ] **Step 2: Run the service test and verify the Canceled case fails**

Run:

```bash
(cd apps/server && bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts)
```

Expected: the Canceled Linear assertion fails because reconciliation only archives `completed`.

- [ ] **Step 3: Update terminal auto-archive logic**

In `apps/server/src/symphony/Layers/SymphonyService.ts`, replace the existing `nextArchivedAt` expression:

```ts
const nextArchivedAt =
  nextStatus === "completed"
    ? (runWithBranch.archivedAt ?? reconciledAt)
    : runWithBranch.archivedAt;
```

with:

```ts
const nextArchivedAt =
  nextStatus === "completed" || nextStatus === "canceled"
    ? (runWithBranch.archivedAt ?? reconciledAt)
    : runWithBranch.archivedAt;
```

- [ ] **Step 4: Run the focused service test**

Run:

```bash
(cd apps/server && bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts)
```

Expected: pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/server/src/symphony/Layers/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts
git commit -m "fix(symphony): archive canceled terminal runs" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 4: Add the Symphony Archive Row Action

**Files:**

- Modify: `apps/web/src/components/symphony/symphonyDisplay.ts`
- Modify: `apps/web/src/components/symphony/IssueQueueTable.tsx`
- Modify: `apps/web/src/components/symphony/IssueQueueTable.browser.tsx`
- Modify: `apps/web/src/components/symphony/SymphonyPanel.tsx`
- Modify: `apps/web/src/components/symphony/SymphonyPanel.browser.tsx`

- [ ] **Step 1: Add UI tests for row action visibility and click behavior**

In `apps/web/src/components/symphony/IssueQueueTable.browser.tsx`, add this test:

```tsx
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
```

In `apps/web/src/components/symphony/SymphonyPanel.browser.tsx`, update `makeEnvironmentApi` so `archiveIssue` is a mock:

```ts
      archiveIssue: vi.fn(async () => input.snapshotRef.current),
```

Then add this test:

```tsx
it("archives an inactive run from the active view", async () => {
  const activeRun = makeRun("4", "Failed run to archive", {
    status: "failed",
    lifecyclePhase: "failed",
    executionTarget: "local",
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
```

- [ ] **Step 2: Run browser tests and verify they fail**

Run:

```bash
(cd apps/web && bun run test:browser src/components/symphony/IssueQueueTable.browser.tsx src/components/symphony/SymphonyPanel.browser.tsx)
```

Expected: fail because the Archive button and `archiveIssue` client action are not wired.

- [ ] **Step 3: Add the archive action type**

In `apps/web/src/components/symphony/symphonyDisplay.ts`, add `"archive"` to `SymphonyAction` immediately after `"retry"`:

```ts
  | "archive"
```

- [ ] **Step 4: Render the Archive action in `IssueQueueTable`**

In `apps/web/src/components/symphony/IssueQueueTable.tsx`, add imports:

```ts
  ArchiveIcon,
```

from `lucide-react`, and:

```ts
import { canArchiveSymphonyRun } from "@t3tools/shared/symphony";
```

In `getIssueQueueRowState`, add:

```ts
    canArchive: run.archivedAt === null && canArchiveSymphonyRun(run),
```

Include `archivedAt: run.archivedAt` in `buildIssueQueueRowDigest`.

Update the `onIssueAction` type in both `IssueQueueRowProps` and `IssueQueueTable` props:

```ts
    action: Extract<
      SymphonyAction,
      "archive" | "stop" | "launch-local" | "launch-cloud" | "refresh-cloud"
    >,
```

Destructure `canArchive` from row state and insert this button before Stop:

```tsx
{
  canArchive ? (
    <Button
      size="xs"
      variant="outline"
      disabled={busyAction !== null}
      onClick={(event) => {
        event.stopPropagation();
        onIssueAction("archive", run);
      }}
    >
      <ArchiveIcon className="size-3" />
      Archive
    </Button>
  ) : null;
}
```

- [ ] **Step 5: Wire the panel action**

In `apps/web/src/components/symphony/SymphonyPanel.tsx`, update the `runIssueAction` action type:

```ts
      action: Extract<
        SymphonyAction,
        "archive" | "stop" | "launch-local" | "launch-cloud" | "refresh-cloud"
      >,
```

Update the action chain:

```ts
const next = await (action === "archive"
  ? api.symphony.archiveIssue({ projectId, issueId: run.issue.id })
  : action === "stop"
    ? api.symphony.stopIssue({ projectId, issueId: run.issue.id })
    : action === "launch-local"
      ? api.symphony.launchIssue({
          projectId,
          issueId: run.issue.id,
          target: "local",
        })
      : action === "launch-cloud"
        ? api.symphony.launchIssue({
            projectId,
            issueId: run.issue.id,
            target: "codex-cloud",
          })
        : api.symphony.refreshCloudStatus({ projectId, issueId: run.issue.id }));
```

- [ ] **Step 6: Run browser tests**

Run:

```bash
(cd apps/web && bun run test:browser src/components/symphony/IssueQueueTable.browser.tsx src/components/symphony/SymphonyPanel.browser.tsx)
```

Expected: pass.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/web/src/components/symphony/symphonyDisplay.ts apps/web/src/components/symphony/IssueQueueTable.tsx apps/web/src/components/symphony/IssueQueueTable.browser.tsx apps/web/src/components/symphony/SymphonyPanel.tsx apps/web/src/components/symphony/SymphonyPanel.browser.tsx
git commit -m "feat(web): add Symphony archive row action" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Task 5: Final Validation and Cleanup

**Files:**

- Verify all files changed by Tasks 1-4.

- [ ] **Step 1: Run formatting**

Run:

```bash
bun fmt
```

Expected: exits `0`. If it changes files, inspect `git diff --stat`.

- [ ] **Step 2: Run lint**

Run:

```bash
bun lint
```

Expected: exits `0`.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun typecheck
```

Expected: exits `0`.

- [ ] **Step 4: Run focused tests again**

Run:

```bash
(cd packages/shared && bun run test src/symphony.test.ts)
(cd packages/contracts && bun run test src/symphony.test.ts)
(cd apps/server && bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts)
(cd apps/web && bun run test:browser src/components/symphony/IssueQueueTable.browser.tsx src/components/symphony/SymphonyPanel.browser.tsx)
```

Expected: every command exits `0`.

- [ ] **Step 5: Run full test suite**

Run:

```bash
bun run test
```

Expected: exits `0`.

- [ ] **Step 6: Inspect final diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: no uncommitted changes if each task commit included all edits. If formatting changed files during this task, add the touched files from the implementation file map and commit them:

```bash
git add packages/shared/package.json packages/shared/src/symphony.ts packages/shared/src/symphony.test.ts packages/contracts/src/symphony.ts packages/contracts/src/ipc.ts packages/contracts/src/rpc.ts packages/contracts/src/symphony.test.ts apps/server/src/symphony/Services/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts apps/server/src/ws.ts apps/web/src/rpc/wsRpcClient.ts apps/web/src/environmentApi.ts apps/web/src/localApi.test.ts apps/web/src/components/symphony/symphonyDisplay.ts apps/web/src/components/symphony/IssueQueueTable.tsx apps/web/src/components/symphony/IssueQueueTable.browser.tsx apps/web/src/components/symphony/SymphonyPanel.tsx apps/web/src/components/symphony/SymphonyPanel.browser.tsx
git commit -m "chore: format Symphony archive changes" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

---

## Acceptance Checklist

- [ ] `symphony.archiveIssue` exists in contracts, RPC group, server handler, web RPC client, and environment API.
- [ ] Manual archive succeeds for inactive Symphony runs.
- [ ] Manual archive is local-only and does not call Linear state mutation.
- [ ] Manual archive preserves status, lifecycle, PR metadata, Linear metadata, attempts, current step, and errors.
- [ ] Manual archive rejects active execution runs with `Cannot archive a run while Symphony is actively working on it. Stop it first.`
- [ ] Already archived runs return a fresh snapshot without error.
- [ ] Terminal Done reconciliation archives completed runs.
- [ ] Terminal Canceled reconciliation archives canceled runs.
- [ ] Merged PR reconciliation archives completed runs.
- [ ] Closed unmerged PR reconciliation archives canceled runs.
- [ ] Retry still clears `archivedAt`.
- [ ] Archive button appears only for inactive rows.
- [ ] Archive click moves a run from Active to Archived in the Symphony panel.
- [ ] Archived runs remain inspectable in the Archived tab.
- [ ] Archived runs remain absent from the sidebar because the existing sidebar projection filters `archivedAt !== null`.
- [ ] `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass.
