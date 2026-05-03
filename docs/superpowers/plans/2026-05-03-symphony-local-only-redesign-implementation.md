# Symphony Local-Only Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the local-only Symphony redesign per `docs/superpowers/specs/2026-05-03-symphony-local-only-redesign-design.md`. Delete Codex Cloud delegation and orchestrator-level GitHub PR lookup. Decompose the 4,375-line `Layers/SymphonyService.ts`. Add a guided setup wizard. Fix the recurring Linear 400 / "issues not picked up" cascade. Make Symphony a local-execution-only workflow controller modeled on the Elixir reference.

**Architecture:** Three independent runtime daemons (Scheduler, Run Orchestrator, Reconciler) call into pure helper modules (`scheduler.ts`, `orchestrator.ts`, `reconciler.ts`, `linearWriter.ts`, `threadOutputParser.ts`). Symphony runs are first-class T3 chat threads using existing `codexAppServerManager`. Linear writes centralized in `linearWriter.ts`. Per-run + per-symptom isolation kills cascade failures structurally.

**Tech Stack:** Bun workspace, Turborepo, Effect (with `effect/unstable/sql/SqlClient`, Effect Schema, Layers/Services), Effect Schema RPC contracts, React 19, TypeScript, Vitest, Vitest browser, Tailwind, lucide-react, SQLite.

---

## Files

### Server (`apps/server/src/symphony/`)

**Delete:**

- `codexCloud.ts` and `codexCloud.test.ts` — Codex Cloud delegation (Phase 1)
- `lifecyclePhase.ts` and `lifecyclePhase.test.ts` — multi-phase enum (Phase 4 after collapse)
- `phasePrompts.ts` and `phasePrompts.test.ts` — replaced by `prompts.ts` (Phase 4)
- `phaseOutput.ts` and `phaseOutput.test.ts` — replaced by `threadOutputParser.ts` (Phase 4)
- `Layers/SymphonyService.lifecycle.test.ts` — split into per-module tests (Phase 2)

**Create:**

- `scheduler.ts` and `scheduler.test.ts` — pure scheduler logic
- `orchestrator.ts` and `orchestrator.test.ts` — pure run orchestrator logic
- `reconciler.ts` and `reconciler.test.ts` — pure reconciler logic
- `linearWriter.ts` and `linearWriter.test.ts` — Linear-write helpers
- `prompts.ts` and `prompts.test.ts` — Phase 1 / Phase 2 prompt builders
- `threadOutputParser.ts` and `threadOutputParser.test.ts` — marker extraction
- `Layers/SymphonyService.test.ts` — composition test

**Modify:**

- `linear.ts` — auth scheme detection, full-body logging, schema-deprecation hints, `projectSlug → projectSlugId` rename
- `linear.test.ts` — expanded coverage
- `workflow.ts` — strip cloud keys, add `concurrency`, polling intervals
- `workflow.test.ts` — updated
- `runModel.ts` — strip cloud fields, add `lastSeenLinearState`, collapse status enum to 7
- `runModel.test.ts` — updated
- `runLifecycle.ts` — strip cloud branches
- `runLifecycle.test.ts` — updated
- `lifecyclePolicy.ts` — strip cloud-specific helpers
- `progressComment.ts` — drop cloud rendering
- `progressComment.test.ts` — updated
- `settingsModel.ts` — strip cloud fields
- `Layers/SymphonyService.ts` — slim composition shell (~500-800 lines from 4,375)
- `Layers/SymphonyRepository.ts` — schema row updates, `last_seen_linear_state`, drop cloud columns
- `Services/SymphonyService.ts` — drop cloud methods, add wizard methods

### Server (`apps/server/src/git/`)

**Modify:**

- `Layers/GitHubCli.ts` — delete `getPullRequest`, `listOpenPullRequests`, `listPullRequestFeedbackSignals`, `withRestFallback`
- `Services/GitHubCli.ts` — trim service interface

### Server (`apps/server/src/persistence/`)

**Create:**

- `Migrations/032_SymphonyLocalOnly.ts` — drop cloud columns, add `last_seen_linear_state`, backfill cloud runs to canceled+archived
- `Migrations/032_SymphonyLocalOnly.test.ts`

**Modify:**

- `Migrations.ts` — register migration 032

### Server (`apps/server/src/`)

**Modify:**

- `ws.ts` — wire new wizard RPCs
- `wsServer.ts` — wire new wizard RPCs

### Contracts (`packages/contracts/src/`)

**Modify:**

- `symphony.ts` — strip cloud, add wizard RPCs (`fetchLinearProjects`, `fetchLinearWorkflowStates`, `applyConfiguration`), add `lastSeenLinearState`, collapse status to 7 values
- `symphony.test.ts` — updated
- `rpc.ts` — wire wizard RPCs
- `ipc.ts` — wire wizard methods
- `index.ts` — exports

### Shared (`packages/shared/src/`)

**Modify:**

- `symphony.ts` — archive eligibility helper without cloud phases
- `symphony.test.ts` — updated

### Web (`apps/web/src/`)

**Delete:**

- `components/symphony/LinearAuthSettings.tsx` — folded into wizard
- Cloud-specific components (audit list in Phase 3)

**Create:**

- `components/symphony/LinearKeyInput.tsx`
- `components/symphony/LinearKeyInput.browser.tsx`
- `components/symphony/LinearProjectPicker.tsx`
- `components/symphony/LinearProjectPicker.browser.tsx`
- `components/symphony/LinearStateMapper.tsx`
- `components/symphony/LinearStateMapper.browser.tsx`
- `components/symphony/WizardProgress.tsx`
- `components/symphony/SettingsWizard.tsx` — wizard host (orchestrates the four child components)
- `components/symphony/SettingsWizard.browser.tsx`

**Modify:**

- `components/symphony/SymphonySettingsPanel.tsx` and `.browser.tsx` — render `SettingsWizard`
- `components/symphony/SymphonyPanel.tsx` and `.browser.tsx` — strip cloud
- `components/symphony/SymphonyEventTimeline.tsx` — drop cloud event types
- `components/symphony/IssueQueueTable.tsx` and `.browser.tsx` — drop "Target" column
- `components/symphony/RunDetailsDrawer.tsx` — drop cloud rows
- `components/symphony/WorkflowStatus.tsx` — drop cloud branches
- `components/symphony/SymphonyToolbar.tsx` — drop cloud branches
- `components/symphony/symphonyDisplay.ts` — drop cloud actions
- `components/symphony/symphonySettingsDisplay.ts` — drop cloud labels
- `components/symphony/SymphonyProjectSelector.tsx` — adjust to wizard data
- `components/symphony/SymphonyEmptyState.tsx` — copy update
- `components/symphony/WorkflowSettingsSection.tsx` — becomes review surface inside wizard
- `routes/settings.symphony.tsx` — wizard route
- `routes/_chat.$environmentId.project.$projectId.symphony.tsx` — strip cloud branches
- `uiStateStore.ts` and `uiStateStore.test.ts` — strip cloud UI state
- `environmentApi.ts` — wire wizard client methods
- `localApi.test.ts` — typed mock fixtures for wizard methods
- `rpc/wsRpcClient.ts` — wire wizard RPCs
- `routeTree.gen.ts` — auto-regenerated

---

## Pre-flight

Verify the worktree is clean and gates pass before starting any task.

- [ ] **Step 1: Confirm working tree clean and on the right branch**

Run:

```bash
git status
git branch --show-current
```

Expected: clean tree on `t3code/symphony-lookup-errors`. The spec commit `a78869c4` should be at HEAD (or close to it).

- [ ] **Step 2: Run all gates to confirm baseline passes**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass. (If any fails before we start, fix it as a separate prerequisite commit so this plan starts from a green baseline.)

---

## Phase 1: Safe Parallel Deletes

Goal: remove files that have no inbound references after their immediate consumers are also stripped, in the order that yields a green tree at each step.

### Task 1.1: Audit and delete `codexCloud.ts`

**Files:**

- Delete: `apps/server/src/symphony/codexCloud.ts`
- Delete: `apps/server/src/symphony/codexCloud.test.ts`
- Modify: any file importing from `codexCloud.ts` (audit identifies callers)

- [ ] **Step 1: Find all importers of `codexCloud.ts`**

Run:

```bash
grep -rn "from.*codexCloud" apps/server/src apps/web/src packages/
```

Note every importing file and the symbols it imports. Most likely callers: `Layers/SymphonyService.ts` and possibly UI components rendering cloud diagnostics.

- [ ] **Step 2: Replace each `codexCloud` import with stub returns or remove the calling code**

For each importer found in Step 1, replace calls to deleted helpers with explicit "cloud not supported" errors or remove the calling branches entirely. This may temporarily make `Layers/SymphonyService.ts` larger/ugly — that's fine; Phase 2 decomposes it. The goal here is only that nothing imports `codexCloud.ts` anymore.

Concretely, in `Layers/SymphonyService.ts`, search for `codexCloud` and either:

- Delete the entire branch if it's purely cloud (e.g., `if (executionTarget === "cloud") { ... }`)
- Replace with a `throw new SymphonyError({ message: "Codex Cloud is no longer supported; this build is local-only." })` for any path that legitimately can't be deleted yet (clean up in Phase 3)

- [ ] **Step 3: Verify no imports remain**

Run:

```bash
grep -rn "codexCloud" apps/server/src apps/web/src packages/
```

Expected: zero hits in source files. (Hits in `docs/`, `.plans/`, or `node_modules/` are fine and stay.)

- [ ] **Step 4: Delete the files**

Run:

```bash
rm apps/server/src/symphony/codexCloud.ts apps/server/src/symphony/codexCloud.test.ts
```

- [ ] **Step 5: Run gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass. If lint flags unused imports, clean them up. If typecheck fails, the audit in Step 1 missed an importer — fix and re-run.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): delete codexCloud module

Remove the Codex Cloud delegation helpers as the first step in the
local-only redesign. Cloud-only branches in SymphonyService.ts are
stubbed pending decomposition in Phase 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.2: Audit cloud-only UI components

**Files:**

- Audit: `apps/web/src/components/symphony/*.tsx` and `*.ts`

- [ ] **Step 1: List all Symphony UI files**

Run:

```bash
ls apps/web/src/components/symphony/
```

- [ ] **Step 2: Find files that import or reference cloud-specific identifiers**

Run:

```bash
grep -rln "executionTarget\|cloudTask\|CodexCloud\|cloudSubmission\|cloud-submitted\|cloud-running\|waiting-cloud" apps/web/src/components/symphony/
```

Note each file. For each, decide one of:

- **Delete entirely** if the file is purely cloud (e.g., a "cloud diagnostics" panel)
- **Strip branches** if the file has both local and cloud code (handle in Phase 3)

- [ ] **Step 3: Delete purely-cloud component files**

For each file marked "delete entirely" in Step 2:

```bash
rm apps/web/src/components/symphony/<FileName>.tsx
rm apps/web/src/components/symphony/<FileName>.browser.tsx  # if exists
```

Then `grep -rn "<FileName>"` to find re-exporters or route imports and remove those references too.

- [ ] **Step 4: Run gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): delete cloud-only UI components

Audit identified <list>. Strip cloud branches from mixed-mode
components is handled in Phase 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Replace `<list>` in the commit message with the actual file names deleted.)

### Task 1.3: Defer `lifecyclePhase.ts` deletion to Phase 4

`lifecyclePhase.ts` is referenced from `runModel.ts` and `runLifecycle.ts`, which still encode multi-phase semantics. Deleting now would cascade. We delete after the status enum is collapsed in Phase 4. No action in Phase 1.

### Task 1.4: Defer `LinearAuthSettings.tsx` deletion to Phase 4

`LinearAuthSettings.tsx` is the only place to set the Linear API key today. Deleting before the wizard exists would brick configuration. We delete it as part of Phase 4 (wizard implementation). No action in Phase 1.

---

## Phase 2: Decompose `Layers/SymphonyService.ts`

Goal: extract the four pure helper modules from the 4,375-line file. Each extraction is behavior-preserving — tests at the Service level still pass after each extraction. Tests at the new module level get added during the extraction.

The extraction order (linearWriter → reconciler → orchestrator → scheduler) is chosen so each extraction has the fewest unresolved internal dependencies.

### Task 2.1: Extract `linearWriter.ts`

**Files:**

- Create: `apps/server/src/symphony/linearWriter.ts`
- Create: `apps/server/src/symphony/linearWriter.test.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`

- [ ] **Step 1: Identify Linear-write code in SymphonyService.ts**

Run:

```bash
grep -n "commentCreate\|commentUpdate\|issueUpdate\|managed-progress\|symphony-managed-progress" apps/server/src/symphony/Layers/SymphonyService.ts
```

Note the line ranges of:

- The managed-comment upsert function
- The state-transition function
- Any helpers they share

- [ ] **Step 2: Write the failing tests for `linearWriter.ts`**

Create `apps/server/src/symphony/linearWriter.test.ts` with tests for the public surface we're about to extract:

```ts
import { describe, expect, it } from "vitest";

import {
  buildManagedCommentBody,
  parseManagedCommentMarker,
  MANAGED_COMMENT_MARKER,
} from "./linearWriter.ts";

describe("linearWriter", () => {
  describe("buildManagedCommentBody", () => {
    it("includes the managed-comment marker as a comment line", () => {
      const body = buildManagedCommentBody({
        status: "planning",
        plan: null,
        prUrl: null,
        lastError: null,
      });
      expect(body).toContain(MANAGED_COMMENT_MARKER);
    });

    it("renders the plan checklist when present", () => {
      const body = buildManagedCommentBody({
        status: "implementing",
        plan: ["Step one", "Step two"],
        prUrl: null,
        lastError: null,
      });
      expect(body).toContain("- [ ] Step one");
      expect(body).toContain("- [ ] Step two");
    });

    it("renders the PR link when present", () => {
      const body = buildManagedCommentBody({
        status: "in-review",
        plan: ["Step one"],
        prUrl: "https://github.com/owner/repo/pull/123",
        lastError: null,
      });
      expect(body).toContain("https://github.com/owner/repo/pull/123");
    });

    it("renders the failed footer when status is failed", () => {
      const body = buildManagedCommentBody({
        status: "failed",
        plan: null,
        prUrl: null,
        lastError: "stalled",
      });
      expect(body).toContain("(failed)");
      expect(body).toContain("stalled");
    });
  });

  describe("parseManagedCommentMarker", () => {
    it("returns true when the body contains the marker", () => {
      const body = `${MANAGED_COMMENT_MARKER}\n\n# Plan\n- [ ] step`;
      expect(parseManagedCommentMarker(body)).toBe(true);
    });

    it("returns false when the body does not contain the marker", () => {
      expect(parseManagedCommentMarker("hi there")).toBe(false);
    });
  });
});
```

- [ ] **Step 3: Verify the new test fails**

Run:

```bash
bun run test apps/server/src/symphony/linearWriter.test.ts
```

Expected: FAIL — the file `linearWriter.ts` doesn't exist yet.

- [ ] **Step 4: Create `linearWriter.ts` with the extracted code**

Create `apps/server/src/symphony/linearWriter.ts`. Move the relevant pure helpers from `Layers/SymphonyService.ts` (lines identified in Step 1):

```ts
/**
 * Linear-write helpers for Symphony.
 *
 * The single place that owns the managed-progress comment marker and the
 * shape of the comment body. Scheduler, orchestrator, and reconciler all
 * call into this module for any Linear-side mutation.
 */

import type { SymphonyRunStatus } from "@t3tools/contracts";

export const MANAGED_COMMENT_MARKER = "<!-- symphony-managed-progress v1 -->";

export interface ManagedCommentInput {
  readonly status: SymphonyRunStatus;
  readonly plan: readonly string[] | null;
  readonly prUrl: string | null;
  readonly lastError: string | null;
}

export function buildManagedCommentBody(input: ManagedCommentInput): string {
  const lines: string[] = [MANAGED_COMMENT_MARKER, ""];

  lines.push(`**Symphony status:** \`${input.status}\``);
  lines.push("");

  if (input.plan && input.plan.length > 0) {
    lines.push("**Plan:**");
    for (const step of input.plan) {
      lines.push(`- [ ] ${step}`);
    }
    lines.push("");
  }

  if (input.prUrl) {
    lines.push(`**PR:** ${input.prUrl}`);
    lines.push("");
  }

  if (input.status === "failed" && input.lastError) {
    lines.push(`_(failed)_ ${input.lastError}`);
  }

  if (input.status === "canceled") {
    lines.push(`_(canceled)_`);
  }

  return lines.join("\n");
}

export function parseManagedCommentMarker(body: string): boolean {
  return body.includes(MANAGED_COMMENT_MARKER);
}
```

(Adjust the body shape to match what `Layers/SymphonyService.ts` is actually rendering today; the goal is behavior preservation, not redesign of the comment format.)

- [ ] **Step 5: Replace inline code in `Layers/SymphonyService.ts` with imports**

In `Layers/SymphonyService.ts`, replace the inline managed-comment rendering with:

```ts
import {
  MANAGED_COMMENT_MARKER,
  buildManagedCommentBody,
  parseManagedCommentMarker,
} from "../linearWriter.ts";
```

Then delete the inline functions that you just moved.

- [ ] **Step 6: Verify both test suites pass**

Run:

```bash
bun run test apps/server/src/symphony/linearWriter.test.ts apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Expected: both pass. The existing lifecycle tests are the behavior-preservation check.

- [ ] **Step 7: Run all gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): extract linearWriter module

Move managed-comment rendering and the symphony-managed-progress marker
constant from Layers/SymphonyService.ts to a focused module. Pure helpers
with unit tests; behavior preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.2: Extract `reconciler.ts`

**Files:**

- Create: `apps/server/src/symphony/reconciler.ts`
- Create: `apps/server/src/symphony/reconciler.test.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`

- [ ] **Step 1: Identify reconciler code in SymphonyService.ts**

Run:

```bash
grep -n "reconcile\|terminal\|archivedAt\|done.*archive" apps/server/src/symphony/Layers/SymphonyService.ts
```

Note the line ranges of: terminal-state archive logic, "should this run be archived" decision logic, signal classification helpers.

- [ ] **Step 2: Write the failing reconciler tests**

Create `apps/server/src/symphony/reconciler.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decideArchive, type ReconcilerInput } from "./reconciler.ts";

function makeRun(overrides: Partial<ReconcilerInput["run"]>): ReconcilerInput["run"] {
  return {
    runId: "run_1",
    issueId: "iss_1",
    status: "in-review",
    archivedAt: null,
    lastSeenLinearState: "In Review",
    ...overrides,
  };
}

describe("reconciler.decideArchive", () => {
  it("archives when Linear state matches done", () => {
    const result = decideArchive({
      run: makeRun({}),
      linearState: "Done",
      doneStates: ["Done"],
      canceledStates: ["Canceled"],
    });
    expect(result).toEqual({
      archive: true,
      newStatus: "completed",
      reason: "linear_done",
    });
  });

  it("archives when Linear state matches canceled", () => {
    const result = decideArchive({
      run: makeRun({}),
      linearState: "Canceled",
      doneStates: ["Done"],
      canceledStates: ["Canceled", "Cancelled"],
    });
    expect(result).toEqual({
      archive: true,
      newStatus: "canceled",
      reason: "linear_canceled",
    });
  });

  it("returns no-op when run is already archived", () => {
    const result = decideArchive({
      run: makeRun({ archivedAt: "2026-05-03T10:00:00.000Z" }),
      linearState: "Done",
      doneStates: ["Done"],
      canceledStates: ["Canceled"],
    });
    expect(result).toEqual({ archive: false, reason: "already_archived" });
  });

  it("returns no-op when Linear state is not terminal", () => {
    const result = decideArchive({
      run: makeRun({ status: "in-review" }),
      linearState: "In Review",
      doneStates: ["Done"],
      canceledStates: ["Canceled"],
    });
    expect(result).toEqual({ archive: false, reason: "not_terminal" });
  });
});
```

- [ ] **Step 3: Verify tests fail**

Run:

```bash
bun run test apps/server/src/symphony/reconciler.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Create `reconciler.ts`**

Create `apps/server/src/symphony/reconciler.ts`:

```ts
/**
 * Pure reconciler logic for Symphony.
 *
 * Given a run and the latest Linear state for its issue, decide whether
 * to archive the run and what its new status should be. Side-effect free.
 */

import type { SymphonyRunStatus } from "@t3tools/contracts";

export interface ReconcilerInput {
  readonly run: {
    readonly runId: string;
    readonly issueId: string;
    readonly status: SymphonyRunStatus;
    readonly archivedAt: string | null;
    readonly lastSeenLinearState: string | null;
  };
  readonly linearState: string;
  readonly doneStates: readonly string[];
  readonly canceledStates: readonly string[];
}

export type ReconcilerDecision =
  | {
      readonly archive: true;
      readonly newStatus: "completed" | "canceled";
      readonly reason: string;
    }
  | { readonly archive: false; readonly reason: string };

export function decideArchive(input: ReconcilerInput): ReconcilerDecision {
  if (input.run.archivedAt !== null) {
    return { archive: false, reason: "already_archived" };
  }

  if (input.doneStates.includes(input.linearState)) {
    return { archive: true, newStatus: "completed", reason: "linear_done" };
  }

  if (input.canceledStates.includes(input.linearState)) {
    return { archive: true, newStatus: "canceled", reason: "linear_canceled" };
  }

  return { archive: false, reason: "not_terminal" };
}
```

- [ ] **Step 5: Replace inline reconciler code in `Layers/SymphonyService.ts`**

In `Layers/SymphonyService.ts`, find the terminal-state reconciliation loop and replace its decision logic with calls to `decideArchive`. Keep the side-effect code (database writes, PubSub events) inline; only move the pure decision logic.

- [ ] **Step 6: Run all gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): extract reconciler module

Move terminal-state archive decision logic from Layers/SymphonyService.ts
to a pure module. Side-effect-free; unit-tested in isolation. Behavior
preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.3: Extract `orchestrator.ts`

**Files:**

- Create: `apps/server/src/symphony/orchestrator.ts`
- Create: `apps/server/src/symphony/orchestrator.test.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`

- [ ] **Step 1: Identify orchestrator code in SymphonyService.ts**

Run:

```bash
grep -n "Phase 1\|Phase 2\|planning\|implementing\|nextPhase\|threadOutput\|parsePlan\|parsePR" apps/server/src/symphony/Layers/SymphonyService.ts
```

Note line ranges of: phase-transition decision logic ("given a run and a thread event, what's the next action?"), Phase 1 → Phase 2 transition, marker parsing dispatch.

- [ ] **Step 2: Write the failing orchestrator tests**

Create `apps/server/src/symphony/orchestrator.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decideNextAction, type OrchestratorInput } from "./orchestrator.ts";

function makeRun(overrides: Partial<OrchestratorInput["run"]>): OrchestratorInput["run"] {
  return {
    runId: "run_1",
    issueId: "iss_1",
    status: "planning",
    archivedAt: null,
    lastSeenLinearState: "In Progress",
    ...overrides,
  };
}

describe("orchestrator.decideNextAction", () => {
  it("transitions planning -> implementing when plan markers found", () => {
    const result = decideNextAction({
      run: makeRun({ status: "planning" }),
      threadOutput: "SYMPHONY_PLAN_BEGIN\n- [ ] Step 1\nSYMPHONY_PLAN_END",
      threadComplete: true,
    });
    expect(result).toEqual({
      action: "advance-to-implementing",
      plan: ["Step 1"],
    });
  });

  it("fails the run when planning ends with no plan markers", () => {
    const result = decideNextAction({
      run: makeRun({ status: "planning" }),
      threadOutput: "I implemented something but forgot the plan.",
      threadComplete: true,
    });
    expect(result).toEqual({
      action: "fail",
      reason: "no_parseable_plan",
    });
  });

  it("transitions implementing -> in-review when PR URL marker found", () => {
    const result = decideNextAction({
      run: makeRun({ status: "implementing" }),
      threadOutput: "Done!\nSYMPHONY_PR_URL: https://github.com/owner/repo/pull/42",
      threadComplete: true,
    });
    expect(result).toEqual({
      action: "advance-to-in-review",
      prUrl: "https://github.com/owner/repo/pull/42",
    });
  });

  it("fails the run when implementing ends with no PR URL", () => {
    const result = decideNextAction({
      run: makeRun({ status: "implementing" }),
      threadOutput: "I tried but couldn't.",
      threadComplete: true,
    });
    expect(result).toEqual({
      action: "fail",
      reason: "no_pr_url",
    });
  });

  it("returns no-op while turn is still streaming", () => {
    const result = decideNextAction({
      run: makeRun({ status: "planning" }),
      threadOutput: "SYMPHONY_PLAN_BEGIN\n- [ ] partial...",
      threadComplete: false,
    });
    expect(result).toEqual({ action: "wait", reason: "turn_streaming" });
  });
});
```

- [ ] **Step 3: Verify tests fail**

Run:

```bash
bun run test apps/server/src/symphony/orchestrator.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Create `orchestrator.ts`**

Create `apps/server/src/symphony/orchestrator.ts`:

```ts
/**
 * Pure orchestrator logic for Symphony runs.
 *
 * Given a run and a thread event, decides the next action. Side-effect free.
 * The Effect Layer that wraps this calls into:
 *  - parsePlanFromOutput / parsePRUrlFromOutput from threadOutputParser.ts
 *  - linearWriter for any Linear-side write
 *  - codexAppServerManager to drive the next turn
 */

import type { SymphonyRunStatus } from "@t3tools/contracts";

import { parsePlanFromOutput, parsePRUrlFromOutput } from "./threadOutputParser.ts";

export interface OrchestratorInput {
  readonly run: {
    readonly runId: string;
    readonly issueId: string;
    readonly status: SymphonyRunStatus;
    readonly archivedAt: string | null;
    readonly lastSeenLinearState: string | null;
  };
  readonly threadOutput: string;
  readonly threadComplete: boolean;
}

export type OrchestratorAction =
  | { readonly action: "wait"; readonly reason: string }
  | { readonly action: "advance-to-implementing"; readonly plan: readonly string[] }
  | { readonly action: "advance-to-in-review"; readonly prUrl: string }
  | { readonly action: "fail"; readonly reason: string };

export function decideNextAction(input: OrchestratorInput): OrchestratorAction {
  if (!input.threadComplete) {
    return { action: "wait", reason: "turn_streaming" };
  }

  if (input.run.status === "planning") {
    const plan = parsePlanFromOutput(input.threadOutput);
    if (plan === null) {
      return { action: "fail", reason: "no_parseable_plan" };
    }
    return { action: "advance-to-implementing", plan };
  }

  if (input.run.status === "implementing") {
    const prUrl = parsePRUrlFromOutput(input.threadOutput);
    if (prUrl === null) {
      return { action: "fail", reason: "no_pr_url" };
    }
    return { action: "advance-to-in-review", prUrl };
  }

  return { action: "wait", reason: "unrecognized_status" };
}
```

Note: `threadOutputParser.ts` does not exist yet. We'll add it as part of this task to satisfy the import. (This is OK because Phase 4 promises to create that module — we're just front-loading it here.)

- [ ] **Step 5: Create stub `threadOutputParser.ts` to satisfy the import**

Create `apps/server/src/symphony/threadOutputParser.ts`:

```ts
const PLAN_BEGIN = "SYMPHONY_PLAN_BEGIN";
const PLAN_END = "SYMPHONY_PLAN_END";
const PR_URL_PREFIX = "SYMPHONY_PR_URL:";

export function parsePlanFromOutput(text: string): readonly string[] | null {
  const beginIdx = text.indexOf(PLAN_BEGIN);
  if (beginIdx === -1) return null;
  const endIdx = text.indexOf(PLAN_END, beginIdx);
  if (endIdx === -1) return null;
  const block = text.slice(beginIdx + PLAN_BEGIN.length, endIdx);
  const items = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- [ ] ") || line.startsWith("- [x] "))
    .map((line) => line.slice("- [ ] ".length).trim());
  return items.length === 0 ? null : items;
}

export function parsePRUrlFromOutput(text: string): string | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(PR_URL_PREFIX)) {
      const url = trimmed.slice(PR_URL_PREFIX.length).trim();
      if (url.startsWith("https://github.com/")) {
        return url;
      }
    }
  }
  return null;
}
```

(Phase 4 will add comprehensive `threadOutputParser.test.ts` and may refine these implementations.)

- [ ] **Step 6: Replace inline orchestrator code in `Layers/SymphonyService.ts`**

In `Layers/SymphonyService.ts`, replace the inline phase-transition decision logic with calls to `decideNextAction`. Keep the side-effect code (Linear writes, Codex turn dispatch, run-row updates) inline.

- [ ] **Step 7: Run all gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): extract orchestrator and threadOutputParser modules

Move phase-transition decision logic and marker extraction from
Layers/SymphonyService.ts to focused pure modules. Behavior preserved.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.4: Extract `scheduler.ts`

**Files:**

- Create: `apps/server/src/symphony/scheduler.ts`
- Create: `apps/server/src/symphony/scheduler.test.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`

- [ ] **Step 1: Identify scheduler code in SymphonyService.ts**

Run:

```bash
grep -n "shouldQueueIntakeRun\|launchQueuedRuns\|refreshCandidates\|runSchedulerTick\|capacity\|max_concurrent" apps/server/src/symphony/Layers/SymphonyService.ts
```

Note line ranges of: candidate-from-Linear-poll → run-creation logic, capacity gating, the `shouldQueueIntakeRun` filter (that we'll fix in Phase 4).

- [ ] **Step 2: Write the failing scheduler tests**

Create `apps/server/src/symphony/scheduler.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { decideSchedulerActions, type SchedulerInput } from "./scheduler.ts";

function makeIssue(id: string, state: string): SchedulerInput["candidates"][number] {
  return {
    id,
    identifier: `ISS-${id}`,
    title: `Issue ${id}`,
    state,
  };
}

function makeRun(
  issueId: string,
  status: SchedulerInput["existingRuns"][number]["status"],
  archivedAt: string | null = null,
  lastSeenLinearState: string | null = null,
): SchedulerInput["existingRuns"][number] {
  return {
    runId: `run_${issueId}`,
    issueId,
    status,
    archivedAt,
    lastSeenLinearState,
  };
}

describe("scheduler.decideSchedulerActions", () => {
  it("creates fresh runs for issues with no existing run", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [],
      intakeStates: ["Todo", "To Do"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([{ issueId: "1", linearState: "Todo" }]);
    expect(result.archive).toEqual([]);
    expect(result.updateLastSeen).toEqual([]);
  });

  it("does not create when capacity is full", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 3,
    });
    expect(result.create).toEqual([]);
  });

  it("does not re-engage a failed run that has been continuously in intake", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [makeRun("1", "failed", null, "Todo")],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([]);
    expect(result.archive).toEqual([]);
    expect(result.updateLastSeen).toEqual([{ runId: "run_1", linearState: "Todo" }]);
  });

  it("re-engages a failed run when issue transitions back into intake", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [makeRun("1", "failed", null, "Done")],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([{ issueId: "1", linearState: "Todo" }]);
    expect(result.archive).toEqual([{ runId: "run_1" }]);
  });

  it("creates a fresh run for an archived completed issue moved back to intake", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "Todo")],
      existingRuns: [makeRun("1", "completed", "2026-05-03T10:00:00.000Z", "Done")],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 0,
    });
    expect(result.create).toEqual([{ issueId: "1", linearState: "Todo" }]);
    expect(result.archive).toEqual([]);
  });

  it("is no-op when there is already an active run for the issue", () => {
    const result = decideSchedulerActions({
      candidates: [makeIssue("1", "In Progress")],
      existingRuns: [makeRun("1", "implementing", null, "Todo")],
      intakeStates: ["Todo"],
      capacity: 3,
      runningCount: 1,
    });
    expect(result.create).toEqual([]);
    expect(result.archive).toEqual([]);
    expect(result.updateLastSeen).toEqual([{ runId: "run_1", linearState: "In Progress" }]);
  });
});
```

- [ ] **Step 3: Verify tests fail**

Run:

```bash
bun run test apps/server/src/symphony/scheduler.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Create `scheduler.ts`**

Create `apps/server/src/symphony/scheduler.ts`:

```ts
/**
 * Pure scheduler logic for Symphony.
 *
 * Given current state (Linear poll result + existing local runs + capacity),
 * decides what runs to create, what runs to archive (because their issue
 * transitioned back into intake), and what last-seen-state values to update.
 *
 * Side-effect-free. The Effect Layer wrapping this performs the actual writes.
 */

import type { SymphonyRunStatus } from "@t3tools/contracts";

export interface SchedulerInput {
  readonly candidates: readonly {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly state: string;
  }[];
  readonly existingRuns: readonly {
    readonly runId: string;
    readonly issueId: string;
    readonly status: SymphonyRunStatus;
    readonly archivedAt: string | null;
    readonly lastSeenLinearState: string | null;
  }[];
  readonly intakeStates: readonly string[];
  readonly capacity: number;
  readonly runningCount: number;
}

export interface SchedulerDecisions {
  readonly create: readonly { readonly issueId: string; readonly linearState: string }[];
  readonly archive: readonly { readonly runId: string }[];
  readonly updateLastSeen: readonly { readonly runId: string; readonly linearState: string }[];
}

const ACTIVE_STATUSES: ReadonlySet<SymphonyRunStatus> = new Set([
  "intake",
  "planning",
  "implementing",
  "in-review",
]);

export function decideSchedulerActions(input: SchedulerInput): SchedulerDecisions {
  const create: SchedulerDecisions["create"][number][] = [];
  const archive: SchedulerDecisions["archive"][number][] = [];
  const updateLastSeen: SchedulerDecisions["updateLastSeen"][number][] = [];

  let availableCapacity = Math.max(0, input.capacity - input.runningCount);

  const intakeSet = new Set(input.intakeStates);

  for (const issue of input.candidates) {
    const existing = input.existingRuns.find((run) => run.issueId === issue.id);

    if (existing) {
      updateLastSeen.push({ runId: existing.runId, linearState: issue.state });

      if (ACTIVE_STATUSES.has(existing.status)) {
        continue; // active run; nothing to do beyond updating last-seen
      }

      if (!intakeSet.has(issue.state)) {
        continue; // issue is not in intake; nothing to do
      }

      const lastSeenInIntake =
        existing.lastSeenLinearState !== null && intakeSet.has(existing.lastSeenLinearState);

      if (lastSeenInIntake && existing.archivedAt === null) {
        continue; // issue has been continuously in intake; do not auto-recreate failed runs
      }

      if (existing.archivedAt === null) {
        archive.push({ runId: existing.runId });
      }

      if (availableCapacity > 0) {
        create.push({ issueId: issue.id, linearState: issue.state });
        availableCapacity -= 1;
      }
      continue;
    }

    if (!intakeSet.has(issue.state)) continue;

    if (availableCapacity > 0) {
      create.push({ issueId: issue.id, linearState: issue.state });
      availableCapacity -= 1;
    }
  }

  return { create, archive, updateLastSeen };
}
```

- [ ] **Step 5: Replace inline scheduler code in `Layers/SymphonyService.ts`**

In `Layers/SymphonyService.ts`, replace the inline candidate-evaluation loop with calls to `decideSchedulerActions`. Keep the side-effect code (creating run rows, archiving runs, updating `last_seen_linear_state`) inline. The `shouldQueueIntakeRun` helper is replaced by this scheduler logic.

Note: this task is the moment where the bug-fix from the spec ("`shouldQueueIntakeRun` regression") and the new policy (`lastSeenLinearState`) are introduced. The status enum collapse to 7 values happens in Phase 3/4; for this task, the scheduler should still tolerate today's wider status set without crashing.

- [ ] **Step 6: Run all gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): extract scheduler module with lastSeenLinearState policy

Move candidate-dispatch decision logic from Layers/SymphonyService.ts to
a pure module. Introduces the lastSeenLinearState re-engagement policy:
runs only re-engage when the issue transitions into an intake state, not
while it sits there continuously. Fixes the failed-run runaway loop.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.5: Slim composition shell in `Layers/SymphonyService.ts`

**Files:**

- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`

- [ ] **Step 1: Inventory remaining inline logic**

Run:

```bash
wc -l apps/server/src/symphony/Layers/SymphonyService.ts
grep -n "^function\|^const.*=.*=>\|^export\|^class" apps/server/src/symphony/Layers/SymphonyService.ts
```

After the previous tasks extracted `linearWriter`, `reconciler`, `orchestrator`, and `scheduler`, the remaining file should be substantially smaller. Identify any remaining inline pure helpers that are still candidates for extraction (any unmoved utility functions).

- [ ] **Step 2: Move remaining stragglers**

For any pure helper still inline that is more than ~30 lines, extract it to one of the existing modules where it fits topically:

- Run-status helpers → `runModel.ts`
- Lifecycle helpers → `runLifecycle.ts`
- Linear helpers → `linear.ts`
- Effect-shape helpers → leave inline if they're small

Goal: the Layer file should be under ~1,000 lines, ideally ~500-800.

- [ ] **Step 3: Run all gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): finish slimming SymphonyService composition shell

Move remaining stragglers to topical modules. The Layer is now a thin
composition over scheduler.ts, orchestrator.ts, reconciler.ts,
linearWriter.ts, plus runModel/runLifecycle/linear helpers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.6: Split `Layers/SymphonyService.lifecycle.test.ts`

**Files:**

- Modify: `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`
- Create: `apps/server/src/symphony/Layers/SymphonyService.test.ts` (composition test)

- [ ] **Step 1: Inventory the existing 1,889-line lifecycle test**

Run:

```bash
grep -n "describe(\|it(\|test(" apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Note each test's topic. Many will already cover scheduler / orchestrator / reconciler logic that is now better-tested at the module level.

- [ ] **Step 2: Identify true composition tests**

A composition test exercises the wiring of multiple modules together (e.g., "scheduler picks up an issue → orchestrator drives Phase 1 → linearWriter posts comment → state transitions"). Identify these tests and keep them in a new `SymphonyService.test.ts`.

- [ ] **Step 3: Identify tests that duplicate module-level coverage**

Many tests in the lifecycle file will duplicate what `scheduler.test.ts`, `orchestrator.test.ts`, `reconciler.test.ts`, `linearWriter.test.ts` now cover. Mark these for deletion.

- [ ] **Step 4: Move composition tests to new file**

Create `apps/server/src/symphony/Layers/SymphonyService.test.ts`. Move the composition tests identified in Step 2.

- [ ] **Step 5: Delete duplicate tests from lifecycle file**

Remove tests identified in Step 3 from `SymphonyService.lifecycle.test.ts`.

- [ ] **Step 6: Run all gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass. Coverage should not regress (module-level tests fill any gap).

- [ ] **Step 7: Decide on the lifecycle file**

If the lifecycle file is now empty or near-empty, delete it:

```bash
rm apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

If it still has unique tests that don't fit elsewhere, leave it.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(symphony): split lifecycle test into per-module + composition

Per-module tests (scheduler/orchestrator/reconciler/linearWriter) now
cover unit-level concerns. SymphonyService.test.ts covers wiring.
Lifecycle file is removed/trimmed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3: Strip Cloud Branches from Kept Files

Goal: remove all cloud-specific branches, fields, types, and references from files that are kept. Each task strips one file and runs gates. Order chosen so types flow naturally (contracts first, then server, then web).

### Task 3.1: Strip cloud from `packages/contracts/src/symphony.ts`

**Files:**

- Modify: `packages/contracts/src/symphony.ts`
- Modify: `packages/contracts/src/symphony.test.ts`

- [ ] **Step 1: Search for cloud identifiers**

Run:

```bash
grep -n "cloud\|executionTarget\|CodexCloud" packages/contracts/src/symphony.ts
```

Note each match: schemas, types, RPC methods.

- [ ] **Step 2: Remove cloud-specific schemas and types**

In `packages/contracts/src/symphony.ts`, delete:

- `SymphonyCloudTask` schema and type
- `SymphonyExecutionTarget` schema (or collapse to a `Schema.Literal("local")` constant)
- Any cloud-specific run status values from `SymphonyRunStatus` enum (the full collapse to 7 values is in Phase 4; here just remove obvious cloud ones like `cloud-submitted`, `cloud-running`, `waiting-cloud-signal`)
- Cloud-specific RPC method names (search for `cloud` in the method-name constants block)

Run typecheck after every save to catch dangling references:

```bash
bun typecheck
```

- [ ] **Step 3: Update `SymphonyRun` schema**

Remove the `cloudTask` and `executionTarget` fields from `SymphonyRun`. Keep `pullRequest` for now; orchestrator-level PR lookup is removed in a later task.

- [ ] **Step 4: Update tests**

In `packages/contracts/src/symphony.test.ts`, remove assertions that referenced deleted schemas/methods.

- [ ] **Step 5: Run gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Typecheck will surface every server/web file still using deleted schemas. Note them — they get fixed in subsequent tasks. For this task, fix only the contracts file and its tests; let typecheck remain failing on downstream files until those tasks land.

If typecheck has too many cascade errors to be useful, you can temporarily mark this commit as WIP and proceed to the next task to clean up call sites. The branch should be green after Task 3.10.

- [ ] **Step 6: Commit (WIP if needed)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(contracts): strip cloud schemas and types from symphony

WIP — call sites in apps/server and apps/web still reference removed
schemas; subsequent tasks in Phase 3 fix them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.2: Strip cloud from `apps/server/src/symphony/runModel.ts`

**Files:**

- Modify: `apps/server/src/symphony/runModel.ts`
- Modify: `apps/server/src/symphony/runModel.test.ts`

- [ ] **Step 1: Search for cloud identifiers**

Run:

```bash
grep -n "cloud\|executionTarget" apps/server/src/symphony/runModel.ts
```

- [ ] **Step 2: Remove cloud fields from run-creation helpers**

Delete `executionTarget`, `cloudTask` parameters and references.

- [ ] **Step 3: Update tests**

Remove assertions about cloud fields.

- [ ] **Step 4: Run targeted tests**

Run:

```bash
bun run test apps/server/src/symphony/runModel.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): strip cloud fields from runModel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.3: Strip cloud from `apps/server/src/symphony/runLifecycle.ts`

**Files:**

- Modify: `apps/server/src/symphony/runLifecycle.ts`
- Modify: `apps/server/src/symphony/runLifecycle.test.ts`

- [ ] **Step 1: Search and identify cloud branches**

Run:

```bash
grep -n "cloud\|executionTarget" apps/server/src/symphony/runLifecycle.ts
```

- [ ] **Step 2: Delete cloud-specific status resolution branches**

The lifecycle resolver currently classifies cloud-submitted/cloud-running statuses. Delete those branches; leave only local-execution paths.

- [ ] **Step 3: Update tests**

Remove the cloud-specific cases from `runLifecycle.test.ts`.

- [ ] **Step 4: Run gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test apps/server/src/symphony/runLifecycle.test.ts
```

Expected: targeted test passes; full typecheck may still cascade-fail until later tasks land.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): strip cloud branches from runLifecycle

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.4: Strip cloud from `lifecyclePolicy.ts`

**Files:**

- Modify: `apps/server/src/symphony/lifecyclePolicy.ts`

- [ ] **Step 1: Search**

Run:

```bash
grep -n "cloud\|executionTarget\|CLOUD\|MONITORED" apps/server/src/symphony/lifecyclePolicy.ts
```

- [ ] **Step 2: Remove cloud-specific eligibility helpers**

Delete cloud-only entries from any constant sets like `MONITORED_RUN_STATUSES`. Adjust `LINEAR_INELIGIBLE_LEGACY_ERROR` only if it explicitly references cloud.

- [ ] **Step 3: Run gates**

Run:

```bash
bun typecheck
```

Expected: typecheck on this file passes locally; downstream may still cascade.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): strip cloud eligibility from lifecyclePolicy

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.5: Strip cloud from `progressComment.ts` and tests

**Files:**

- Modify: `apps/server/src/symphony/progressComment.ts`
- Modify: `apps/server/src/symphony/progressComment.test.ts`

- [ ] **Step 1: Find cloud rendering**

Run:

```bash
grep -n "cloud\|executionTarget" apps/server/src/symphony/progressComment.ts
```

- [ ] **Step 2: Remove cloud-specific rendering**

Drop branches that emit cloud-target labels or cloud-task URLs. Simplify the phase label set.

- [ ] **Step 3: Update tests**

- [ ] **Step 4: Run targeted tests**

Run:

```bash
bun run test apps/server/src/symphony/progressComment.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): strip cloud rendering from progressComment

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.6: Strip cloud from `settingsModel.ts`

**Files:**

- Modify: `apps/server/src/symphony/settingsModel.ts`

- [ ] **Step 1: Find cloud fields**

Run:

```bash
grep -n "cloud\|executionTarget\|executionDefaultTarget" apps/server/src/symphony/settingsModel.ts
```

- [ ] **Step 2: Remove cloud-specific defaults and types**

The `executionDefaultTarget` field becomes either constant `"local"` or removed entirely.

- [ ] **Step 3: Run gates**

Run:

```bash
bun typecheck
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): strip cloud fields from settingsModel

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.7: Strip cloud from `workflow.ts` and update schema

**Files:**

- Modify: `apps/server/src/symphony/workflow.ts`
- Modify: `apps/server/src/symphony/workflow.test.ts`

- [ ] **Step 1: Find cloud config keys**

Run:

```bash
grep -n "cloud\|executionTarget\|projectSlug" apps/server/src/symphony/workflow.ts
```

- [ ] **Step 2: Remove cloud parser branches**

Delete parsing for any `cloud:` subtree, `executionTarget` field, etc.

- [ ] **Step 3: Rename `projectSlug` to `projectSlugId`**

Update the parser, type, and default constant (`STARTER_WORKFLOW_TEMPLATE`):

```ts
// in workflow.ts
export interface WorkflowTrackerConfig {
  readonly endpoint: string;
  readonly apiKey: string | null;
  readonly projectSlugId: string;
  readonly projectName: string | null;
}
```

The starter template's `project_slug:` becomes `project_slug_id:`.

- [ ] **Step 4: Add `concurrency` and explicit `polling` keys**

Extend the schema to include:

```ts
export interface WorkflowConfig {
  readonly tracker: WorkflowTrackerConfig;
  readonly states: WorkflowStatesConfig;
  readonly git: WorkflowGitConfig;
  readonly agent: WorkflowAgentConfig;
  readonly concurrency: { readonly max: number };
  readonly polling: {
    readonly schedulerIntervalMs: number;
    readonly reconcilerIntervalMs: number;
    readonly jitter: number;
  };
  readonly stall: { readonly timeoutMs: number };
}
```

Defaults:

- `concurrency.max`: 3
- `polling.schedulerIntervalMs`: 30000
- `polling.reconcilerIntervalMs`: 60000
- `polling.jitter`: 0.1
- `stall.timeoutMs`: 300000

- [ ] **Step 5: Update tests**

Update `workflow.test.ts`:

- Remove cloud parsing tests
- Add `projectSlugId` parsing test
- Add `concurrency`, `polling`, `stall` defaulting tests
- Test that the legacy `project_slug:` key produces a clear error pointing to `project_slug_id:`

- [ ] **Step 6: Run targeted tests**

Run:

```bash
bun run test apps/server/src/symphony/workflow.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): rename projectSlug to projectSlugId, add concurrency/polling/stall to WORKFLOW.md schema

Hard rename project_slug -> project_slug_id with a clear error message
when the legacy key is present. Adds the new schema sections required
by the local-only redesign.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.8: Strip cloud from `packages/shared/src/symphony.ts`

**Files:**

- Modify: `packages/shared/src/symphony.ts`
- Modify: `packages/shared/src/symphony.test.ts`

- [ ] **Step 1: Find cloud lifecycle phases**

Run:

```bash
grep -n "cloud\|executionTarget" packages/shared/src/symphony.ts
```

- [ ] **Step 2: Remove cloud-specific phases from archive eligibility**

Delete cloud-specific phases (e.g., `waiting-cloud-signal`) from the `disallowed` set in the archive eligibility helper.

- [ ] **Step 3: Update tests**

- [ ] **Step 4: Run targeted tests**

Run:

```bash
bun run test packages/shared/src/symphony.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(shared): drop cloud phases from archive eligibility

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.9: Strip cloud from web components

**Files:**

- Modify: `apps/web/src/components/symphony/SymphonyPanel.tsx` and `.browser.tsx`
- Modify: `apps/web/src/components/symphony/SymphonyEventTimeline.tsx`
- Modify: `apps/web/src/components/symphony/IssueQueueTable.tsx` and `.browser.tsx`
- Modify: `apps/web/src/components/symphony/RunDetailsDrawer.tsx`
- Modify: `apps/web/src/components/symphony/WorkflowStatus.tsx`
- Modify: `apps/web/src/components/symphony/SymphonyToolbar.tsx`
- Modify: `apps/web/src/components/symphony/symphonyDisplay.ts`
- Modify: `apps/web/src/components/symphony/symphonySettingsDisplay.ts`
- Modify: `apps/web/src/components/symphony/SymphonyProjectSelector.tsx`
- Modify: `apps/web/src/components/symphony/WorkflowSettingsSection.tsx`
- Modify: `apps/web/src/routes/_chat.$environmentId.project.$projectId.symphony.tsx`
- Modify: `apps/web/src/uiStateStore.ts` and `uiStateStore.test.ts`

- [ ] **Step 1: Find every cloud branch in web**

Run:

```bash
grep -rln "executionTarget\|cloudTask\|cloud-submitted\|cloud-running\|waiting-cloud\|RefreshCloud\|refresh-cloud" apps/web/src/
```

- [ ] **Step 2: For each file, remove cloud branches**

For each file in the list, find the cloud-specific branches and delete them:

- Conditional `if (executionTarget === "cloud") { ... }` branches → delete
- Cloud-specific table columns → delete
- Cloud-specific event types → delete
- "Refresh Cloud" buttons → delete

In `IssueQueueTable.tsx`, the "Target" column gets removed entirely (every run is local).

- [ ] **Step 3: Run gates after each file save**

Run:

```bash
bun typecheck
```

Fix import errors and unused vars as you go.

- [ ] **Step 4: Run all gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(web): strip cloud branches from Symphony UI

Removes Target column from IssueQueueTable, drops cloud detail rows
from RunDetailsDrawer, removes cloud-specific event types and refresh
actions. UI now shows only local runs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.10: Delete PR helpers from `apps/server/src/git/Layers/GitHubCli.ts`

**Files:**

- Modify: `apps/server/src/git/Layers/GitHubCli.ts`
- Modify: `apps/server/src/git/Services/GitHubCli.ts`
- Delete or trim: corresponding test files

- [ ] **Step 1: Find PR helpers and callers**

Run:

```bash
grep -n "getPullRequest\|listOpenPullRequests\|listPullRequestFeedbackSignals\|withRestFallback\|normalizeGitHubCliError" apps/server/src/git/Layers/GitHubCli.ts
grep -rln "getPullRequest\|listOpenPullRequests\|listPullRequestFeedbackSignals" apps/server/src apps/web/src
```

- [ ] **Step 2: Remove call sites in Symphony code**

If any call sites remain in `Layers/SymphonyService.ts` or other Symphony files, delete those branches (they should be the GitHub PR lookup paths called out in the spec — `resolvePullRequestSummary` and friends).

- [ ] **Step 3: Delete the four helpers**

In `Layers/GitHubCli.ts`, delete:

- `getPullRequest`
- `listOpenPullRequests`
- `listPullRequestFeedbackSignals`
- `withRestFallback`

In `Services/GitHubCli.ts`, remove the corresponding interface entries.

- [ ] **Step 4: Audit `normalizeGitHubCliError`**

Run:

```bash
grep -rn "normalizeGitHubCliError" apps/server/src apps/web/src
```

If zero callers remain, delete the function. If callers exist (e.g., for non-PR operations like worktree management), keep it.

- [ ] **Step 5: Run gates**

Run:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(git): delete GitHub PR lookup helpers

Removes getPullRequest, listOpenPullRequests, listPullRequestFeedback-
Signals, and withRestFallback. The Symphony orchestrator no longer
talks to GitHub; the agent handles PR creation via gh inside its
worktree.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4: New Code

Goal: implement everything that's net-new in the redesign — the migration, bug fixes, prompts, marker parser tests, wizard RPCs, wizard UI, and the structural changes (per-symptom isolation, stall detection, status enum collapse, capacity).

### Task 4.1: Create migration `032_SymphonyLocalOnly.ts`

**Files:**

- Create: `apps/server/src/persistence/Migrations/032_SymphonyLocalOnly.ts`
- Create: `apps/server/src/persistence/Migrations/032_SymphonyLocalOnly.test.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`

- [ ] **Step 1: Write the failing migration test**

Create `apps/server/src/persistence/Migrations/032_SymphonyLocalOnly.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as SqliteClient from "effect/unstable/sql-bun/SqliteClient";

import { runMigrations } from "../Migrations.ts";

const TestSqlite = SqliteClient.layer({ filename: ":memory:" });

describe("Migration 032: SymphonyLocalOnly", () => {
  it("adds last_seen_linear_state column", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 32 });
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(symphony_runs)
      `;
      return columns.map((c) => c.name);
    }).pipe(Effect.provide(TestSqlite));

    const columns = await Effect.runPromise(program);
    expect(columns).toContain("last_seen_linear_state");
  });

  it("drops execution_target column", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 32 });
      const sql = yield* SqlClient.SqlClient;
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(symphony_runs)
      `;
      return columns.map((c) => c.name);
    }).pipe(Effect.provide(TestSqlite));

    const columns = await Effect.runPromise(program);
    expect(columns).not.toContain("execution_target");
    expect(columns).not.toContain("cloud_task_json");
  });

  it("auto-archives existing cloud runs", async () => {
    const program = Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 31 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO symphony_runs (
          run_id, project_id, issue_json, status, execution_target,
          archived_at, attempts_json, created_at, updated_at
        )
        VALUES (
          'r1', 'p1', '{"id":"i1"}', 'running', 'cloud',
          NULL, '[]', '2026-05-03T10:00:00Z', '2026-05-03T10:00:00Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 32 });
      const rows = yield* sql<{ readonly status: string; readonly archived_at: string | null }>`
        SELECT status, archived_at FROM symphony_runs WHERE run_id = 'r1'
      `;
      return rows;
    }).pipe(Effect.provide(TestSqlite));

    const rows = await Effect.runPromise(program);
    expect(rows[0]?.status).toBe("canceled");
    expect(rows[0]?.archived_at).not.toBeNull();
  });
});
```

- [ ] **Step 2: Verify the test fails**

Run:

```bash
bun run test apps/server/src/persistence/Migrations/032_SymphonyLocalOnly.test.ts
```

Expected: FAIL — migration 032 not registered.

- [ ] **Step 3: Create the migration**

Create `apps/server/src/persistence/Migrations/032_SymphonyLocalOnly.ts`:

```ts
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

function hasColumn(columns: readonly { readonly name: string }[], columnName: string): boolean {
  return columns.some((column) => column.name === columnName);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // 1. Auto-archive existing cloud runs.
  yield* sql`
    UPDATE symphony_runs
    SET status = 'canceled',
        archived_at = COALESCE(archived_at, datetime('now')),
        last_error = COALESCE(last_error, 'Auto-archived during local-only migration; cloud execution is no longer supported')
    WHERE execution_target = 'cloud'
       OR status IN ('cloud-submitted', 'cloud-running', 'waiting-cloud-signal')
  `;

  // 2. Add last_seen_linear_state column if missing.
  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(symphony_runs)
  `;

  if (!hasColumn(runColumns, "last_seen_linear_state")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN last_seen_linear_state TEXT
    `;
  }

  // 3. Backfill last_seen_linear_state from issue_json where possible.
  // Issue rows store the issue JSON; the issue's state.name lives at $.state.name.
  yield* sql`
    UPDATE symphony_runs
    SET last_seen_linear_state = json_extract(issue_json, '$.state.name')
    WHERE last_seen_linear_state IS NULL
      AND json_extract(issue_json, '$.state.name') IS NOT NULL
  `;

  // 4. Drop cloud columns (SQLite supports DROP COLUMN since 3.35).
  if (hasColumn(runColumns, "execution_target")) {
    yield* sql`
      ALTER TABLE symphony_runs
      DROP COLUMN execution_target
    `;
  }

  if (hasColumn(runColumns, "cloud_task_json")) {
    yield* sql`
      ALTER TABLE symphony_runs
      DROP COLUMN cloud_task_json
    `;
  }

  // 5. Drop execution_default_target from settings if present.
  const settingsColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(symphony_project_settings)
  `;

  if (hasColumn(settingsColumns, "execution_default_target")) {
    yield* sql`
      ALTER TABLE symphony_project_settings
      DROP COLUMN execution_default_target
    `;
  }

  // 6. Index on last_seen_linear_state for the scheduler query.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_runs_last_seen_state
    ON symphony_runs(project_id, last_seen_linear_state)
  `;
});
```

(The actual cloud column names — `execution_target` vs `executionTarget`, `cloud_task_json` etc. — depend on the existing schema. Inspect the schema before writing this migration; adjust column names to match.)

- [ ] **Step 4: Register the migration**

In `apps/server/src/persistence/Migrations.ts`, add:

```ts
import Migration0032 from "./Migrations/032_SymphonyLocalOnly.ts";
```

And in `migrationEntries`:

```ts
[32, "SymphonyLocalOnly", Migration0032],
```

- [ ] **Step 5: Run the test**

Run:

```bash
bun run test apps/server/src/persistence/Migrations/032_SymphonyLocalOnly.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run all gates**

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(persistence): add migration 032 SymphonyLocalOnly

Auto-archives existing cloud runs, drops execution_target and
cloud_task_json columns, adds last_seen_linear_state with a backfill
from issue.state.name, and indexes for the scheduler.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.2: Linear client auth scheme detection and full body logging

**Files:**

- Modify: `apps/server/src/symphony/linear.ts`
- Modify: `apps/server/src/symphony/linear.test.ts`

- [ ] **Step 1: Write failing tests for auth detection and body logging**

In `apps/server/src/symphony/linear.test.ts`, add:

```ts
describe("Linear API key validation", () => {
  it("accepts a personal API key (lin_api_*) raw", () => {
    const result = classifyLinearApiKey("lin_api_abc123");
    expect(result).toEqual({ kind: "personal", token: "lin_api_abc123" });
  });

  it("strips the Bearer prefix and warns", () => {
    const result = classifyLinearApiKey("Bearer lin_api_abc123");
    expect(result).toEqual({
      kind: "personal-with-bearer-prefix",
      token: "lin_api_abc123",
      warning: expect.stringContaining("Bearer"),
    });
  });

  it("flags a JWT-shaped token as OAuth", () => {
    const result = classifyLinearApiKey(
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature",
    );
    expect(result).toEqual({
      kind: "oauth-token",
      token: null,
      error: expect.stringContaining("OAuth"),
    });
  });

  it("rejects empty strings", () => {
    const result = classifyLinearApiKey("");
    expect(result).toEqual({ kind: "empty", token: null });
  });
});

describe("Linear error body logging", () => {
  it("includes the full response body in the thrown error message (no truncation)", async () => {
    const longBody = "X".repeat(5000);
    vi.stubGlobal(
      "fetch",
      async () => new Response(longBody, { status: 400, statusText: "Bad Request" }),
    );

    try {
      await Effect.runPromise(linearGraphql({ query: "query Q { a }", apiKey: "lin_api_abc" }));
      throw new Error("expected to throw");
    } catch (e: unknown) {
      const message = (e as { message?: string }).message ?? String(e);
      expect(message).toContain(longBody);
    }
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run:

```bash
bun run test apps/server/src/symphony/linear.test.ts
```

Expected: FAIL — `classifyLinearApiKey` doesn't exist; truncation still active.

- [ ] **Step 3: Implement `classifyLinearApiKey`**

In `apps/server/src/symphony/linear.ts`, add:

```ts
export type LinearApiKeyClassification =
  | { readonly kind: "personal"; readonly token: string }
  | {
      readonly kind: "personal-with-bearer-prefix";
      readonly token: string;
      readonly warning: string;
    }
  | { readonly kind: "oauth-token"; readonly token: null; readonly error: string }
  | { readonly kind: "empty"; readonly token: null };

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export function classifyLinearApiKey(raw: string): LinearApiKeyClassification {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: "empty", token: null };

  if (trimmed.startsWith("Bearer ")) {
    const stripped = trimmed.slice("Bearer ".length).trim();
    return {
      kind: "personal-with-bearer-prefix",
      token: stripped,
      warning:
        'The "Bearer " prefix is for OAuth tokens. Personal API keys are sent as the raw token. The prefix has been stripped.',
    };
  }

  if (JWT_SHAPE.test(trimmed)) {
    return {
      kind: "oauth-token",
      token: null,
      error:
        "This looks like an OAuth/JWT token. Symphony requires a personal API key (lin_api_*). Generate one in Linear settings.",
    };
  }

  return { kind: "personal", token: trimmed };
}
```

- [ ] **Step 4: Update the GraphQL request helper to use classification**

In `linear.ts`, find the function that sends GraphQL requests (the one that sets `authorization: input.apiKey`). Update it to:

```ts
function buildAuthorizationHeader(
  rawKey: string,
): { ok: true; value: string } | { ok: false; error: string } {
  const classified = classifyLinearApiKey(rawKey);
  if (classified.token === null) {
    return {
      ok: false,
      error: classified.kind === "empty" ? "API key is empty" : classified.error,
    };
  }
  return { ok: true, value: classified.token };
}
```

And use this in the existing request flow before calling `fetch`.

- [ ] **Step 5: Remove the 1000-byte body truncation**

Find `formatLinearHttpError` (or the equivalent function that wraps non-2xx responses). Remove the `.slice(0, 1000)` truncation on the body. Replace with the full body. Add a separate helper for UI-display truncation if a truncation is still wanted in some surface, but the thrown error message should carry the full body.

```ts
function formatLinearHttpError(input: {
  readonly operationName: string;
  readonly status: number;
  readonly body: string;
  readonly rateLimit: string | null;
}): string {
  const parts = [`Linear ${input.operationName} request failed with HTTP ${input.status}`];
  parts.push(`response body: ${input.body}`); // full body, no truncation
  if (input.rateLimit) parts.push(`rate limit: ${input.rateLimit}`);
  return parts.join("; ");
}
```

- [ ] **Step 6: Run targeted tests**

```bash
bun run test apps/server/src/symphony/linear.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(symphony): classify Linear API keys and log full 400 body

classifyLinearApiKey distinguishes personal keys, Bearer-prefixed keys
(strip + warn), JWT/OAuth tokens (reject), and empty strings. Removes
the 1000-byte truncation on the response body so 400 diagnostics are
visible to the user.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.3: Linear schema-deprecation hints

**Files:**

- Modify: `apps/server/src/symphony/linear.ts`
- Modify: `apps/server/src/symphony/linear.test.ts`

- [ ] **Step 1: Write failing test**

In `linear.test.ts`:

```ts
describe("Linear schema-deprecation hints", () => {
  it("annotates GRAPHQL_VALIDATION_FAILED errors with a schema-drift hint", () => {
    const message = formatLinearHttpError({
      operationName: "SymphonyCandidateIssues",
      status: 400,
      body: '{"errors":[{"message":"Cannot query field \\"branchName\\" on type \\"Issue\\"","extensions":{"code":"GRAPHQL_VALIDATION_FAILED"}}]}',
      rateLimit: null,
    });
    expect(message).toContain("Linear's GraphQL schema may have changed");
    expect(message).toContain("branchName");
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
bun run test apps/server/src/symphony/linear.test.ts
```

- [ ] **Step 3: Implement schema-drift detection**

In `linear.ts`, modify `formatLinearHttpError` to detect known field names:

```ts
const KNOWN_LINEAR_FIELDS = ["branchName", "inverseRelations", "slugId"];

function formatLinearHttpError(input: {
  readonly operationName: string;
  readonly status: number;
  readonly body: string;
  readonly rateLimit: string | null;
}): string {
  const parts = [`Linear ${input.operationName} request failed with HTTP ${input.status}`];
  parts.push(`response body: ${input.body}`);
  if (input.rateLimit) parts.push(`rate limit: ${input.rateLimit}`);

  const offendingField = KNOWN_LINEAR_FIELDS.find((field) => input.body.includes(`"${field}"`));
  const isValidationError = input.body.includes("GRAPHQL_VALIDATION_FAILED");

  if (offendingField && isValidationError) {
    parts.push(
      `hint: Linear's GraphQL schema may have changed; the field "${offendingField}" is referenced in this Symphony build's queries. This Symphony build may be incompatible with the current Linear API; please update Symphony.`,
    );
  }

  return parts.join("; ");
}
```

- [ ] **Step 4: Run targeted tests**

```bash
bun run test apps/server/src/symphony/linear.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(symphony): annotate Linear 400s with schema-drift hints

When GRAPHQL_VALIDATION_FAILED references a known Linear field name
(branchName, inverseRelations, slugId), the error message tells the
user the schema may have changed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.4: `prompts.ts` (Phase 1 + Phase 2 prompt builders)

**Files:**

- Create: `apps/server/src/symphony/prompts.ts`
- Create: `apps/server/src/symphony/prompts.test.ts`
- Delete: `apps/server/src/symphony/phasePrompts.ts` and `phasePrompts.test.ts`

- [ ] **Step 1: Write failing prompt tests**

Create `apps/server/src/symphony/prompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { planningPrompt, doingPrompt } from "./prompts.ts";

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

  it("includes the repo guidance body", () => {
    const text = planningPrompt({ issue, workflow });
    expect(text).toContain("Follow the simplify skill before PR.");
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
});
```

- [ ] **Step 2: Verify failure**

```bash
bun run test apps/server/src/symphony/prompts.test.ts
```

- [ ] **Step 3: Implement `prompts.ts`**

Create `apps/server/src/symphony/prompts.ts`:

```ts
/**
 * Symphony agent prompt templates.
 *
 * Phase 1 (planningPrompt): the agent reads the Linear issue, produces a
 * structured checklist, and emits it inside SYMPHONY_PLAN_BEGIN/END fences.
 * Symphony parses the fences and posts the plan to Linear before Phase 2.
 *
 * Phase 2 (doingPrompt): the agent implements the plan, runs validation
 * commands, creates the PR, and emits SYMPHONY_PR_URL: <url> on its own line.
 */

export interface PromptIssue {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly description: string;
  readonly url: string;
}

export interface PromptWorkflow {
  readonly validation: readonly string[];
  readonly prBaseBranch: string;
  readonly branchName: string;
  readonly bodyMarkdown: string;
}

export function planningPrompt(input: {
  readonly issue: PromptIssue;
  readonly workflow: PromptWorkflow;
}): string {
  const { issue, workflow } = input;
  return [
    `You are picking up a Linear issue. Your first turn produces ONLY a structured plan checklist.`,
    ``,
    `## Linear issue`,
    `- Identifier: ${issue.identifier}`,
    `- Title: ${issue.title}`,
    `- URL: ${issue.url}`,
    ``,
    `## Description`,
    issue.description || "(no description)",
    ``,
    `## Repo guidance`,
    workflow.bodyMarkdown.trim(),
    ``,
    `## Your output`,
    `Produce a comprehensive plan checklist. Each checklist item should be a single concrete action.`,
    `Wrap the checklist in these exact fence markers:`,
    ``,
    `SYMPHONY_PLAN_BEGIN`,
    `- [ ] First step`,
    `- [ ] Second step`,
    `SYMPHONY_PLAN_END`,
    ``,
    `Do not implement anything in this turn. Output only the plan.`,
  ].join("\n");
}

export function doingPrompt(input: {
  readonly issue: PromptIssue;
  readonly workflow: PromptWorkflow;
  readonly plan: readonly string[];
}): string {
  const { issue, workflow, plan } = input;
  const planList = plan.map((item) => `- [ ] ${item}`).join("\n");
  const validationList = workflow.validation.map((cmd) => `- \`${cmd}\``).join("\n");
  return [
    `You are continuing the Linear issue ${issue.identifier}: "${issue.title}".`,
    ``,
    `## Plan`,
    planList,
    ``,
    `## Branch and PR`,
    `Your worktree is checked out on branch \`${workflow.branchName}\`.`,
    `When the plan is complete, run \`gh pr create --base ${workflow.prBaseBranch}\` and then emit a single line:`,
    ``,
    `SYMPHONY_PR_URL: <the PR URL from gh>`,
    ``,
    `## Validation gates`,
    `Before \`gh pr create\`, run each of these commands. If any fail, fix the cause and rerun until they pass:`,
    ``,
    validationList,
    ``,
    `## Repo guidance`,
    workflow.bodyMarkdown.trim(),
    ``,
    `Implement the plan now. End with the SYMPHONY_PR_URL line.`,
  ].join("\n");
}
```

- [ ] **Step 4: Replace imports of `phasePrompts.ts`**

Run:

```bash
grep -rn "phasePrompts" apps/server/src apps/web/src
```

For each call site, replace the import to use `prompts.ts`. Replace `planningPrompt`/`implementationPrompt`/etc. calls to map onto `planningPrompt` and `doingPrompt`.

- [ ] **Step 5: Delete the old files**

```bash
rm apps/server/src/symphony/phasePrompts.ts apps/server/src/symphony/phasePrompts.test.ts
```

- [ ] **Step 6: Run gates**

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(symphony): replace phasePrompts with two-phase prompts.ts

planningPrompt produces only a SYMPHONY_PLAN_BEGIN/END-fenced checklist.
doingPrompt continues the same Codex thread and ends with a
SYMPHONY_PR_URL line. Drops simplify/review/fix prompts; those become
agent-internal in Phase 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.5: Comprehensive `threadOutputParser.test.ts`

**Files:**

- Create: `apps/server/src/symphony/threadOutputParser.test.ts`
- Modify: `apps/server/src/symphony/threadOutputParser.ts` (refine if tests reveal issues)
- Delete: `apps/server/src/symphony/phaseOutput.ts` and `phaseOutput.test.ts`

- [ ] **Step 1: Write the comprehensive test suite**

Create `apps/server/src/symphony/threadOutputParser.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parsePlanFromOutput, parsePRUrlFromOutput } from "./threadOutputParser.ts";

describe("parsePlanFromOutput", () => {
  it("extracts a basic plan", () => {
    const text = "SYMPHONY_PLAN_BEGIN\n- [ ] Step 1\n- [ ] Step 2\nSYMPHONY_PLAN_END";
    expect(parsePlanFromOutput(text)).toEqual(["Step 1", "Step 2"]);
  });

  it("returns null when fences are missing", () => {
    expect(parsePlanFromOutput("just text")).toBeNull();
  });

  it("returns null when END fence is missing", () => {
    expect(parsePlanFromOutput("SYMPHONY_PLAN_BEGIN\n- [ ] Step")).toBeNull();
  });

  it("returns null when fences exist but no checklist items", () => {
    expect(parsePlanFromOutput("SYMPHONY_PLAN_BEGIN\nempty\nSYMPHONY_PLAN_END")).toBeNull();
  });

  it("returns the first plan when multiple are present", () => {
    const text = [
      "SYMPHONY_PLAN_BEGIN",
      "- [ ] First plan",
      "SYMPHONY_PLAN_END",
      "later...",
      "SYMPHONY_PLAN_BEGIN",
      "- [ ] Second plan",
      "SYMPHONY_PLAN_END",
    ].join("\n");
    expect(parsePlanFromOutput(text)).toEqual(["First plan"]);
  });

  it("ignores prose between checklist items", () => {
    const text =
      "SYMPHONY_PLAN_BEGIN\n- [ ] Step 1\nA paragraph in the middle.\n- [ ] Step 2\nSYMPHONY_PLAN_END";
    expect(parsePlanFromOutput(text)).toEqual(["Step 1", "Step 2"]);
  });

  it("accepts both `- [ ]` and `- [x]` checkbox forms", () => {
    const text = "SYMPHONY_PLAN_BEGIN\n- [ ] Open\n- [x] Done\nSYMPHONY_PLAN_END";
    expect(parsePlanFromOutput(text)).toEqual(["Open", "Done"]);
  });
});

describe("parsePRUrlFromOutput", () => {
  it("extracts a PR URL from its dedicated line", () => {
    const text = "stuff\nSYMPHONY_PR_URL: https://github.com/owner/repo/pull/42\ndone";
    expect(parsePRUrlFromOutput(text)).toBe("https://github.com/owner/repo/pull/42");
  });

  it("returns null when no marker is present", () => {
    expect(parsePRUrlFromOutput("no marker here")).toBeNull();
  });

  it("returns null when the marker has no URL", () => {
    expect(parsePRUrlFromOutput("SYMPHONY_PR_URL:")).toBeNull();
  });

  it("returns null for non-GitHub URLs", () => {
    expect(
      parsePRUrlFromOutput("SYMPHONY_PR_URL: https://gitlab.com/x/y/-/merge_requests/1"),
    ).toBeNull();
  });

  it("returns the first marker when multiple are present", () => {
    const text =
      "SYMPHONY_PR_URL: https://github.com/owner/repo/pull/1\nSYMPHONY_PR_URL: https://github.com/owner/repo/pull/2";
    expect(parsePRUrlFromOutput(text)).toBe("https://github.com/owner/repo/pull/1");
  });

  it("trims surrounding whitespace from the URL", () => {
    expect(parsePRUrlFromOutput("SYMPHONY_PR_URL:    https://github.com/o/r/pull/9   ")).toBe(
      "https://github.com/o/r/pull/9",
    );
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
bun run test apps/server/src/symphony/threadOutputParser.test.ts
```

Some tests should pass (the stub from Task 2.3 is decent). Any failures point to refinements needed in `threadOutputParser.ts`.

- [ ] **Step 3: Refine `threadOutputParser.ts` if needed**

If any tests fail, update the parsers in `threadOutputParser.ts` to make them pass. Use the test cases as the spec.

- [ ] **Step 4: Replace imports of `phaseOutput.ts`**

```bash
grep -rn "phaseOutput" apps/server/src apps/web/src
```

For each call site, switch to `threadOutputParser.ts`. The `REVIEW_PASS`/`REVIEW_FAIL` parser is removed (the review phase is gone in this redesign).

- [ ] **Step 5: Delete `phaseOutput.ts`**

```bash
rm apps/server/src/symphony/phaseOutput.ts apps/server/src/symphony/phaseOutput.test.ts
```

- [ ] **Step 6: Run gates**

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(symphony): replace phaseOutput with threadOutputParser tests

Comprehensive parser test suite (multi-fence, mid-prose checklist,
non-GitHub URL rejection). Removes the REVIEW_PASS/REVIEW_FAIL parser
since the review phase is no longer orchestrator-enforced.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.6: Status enum collapse to 7 values + delete `lifecyclePhase.ts`

**Files:**

- Modify: `packages/contracts/src/symphony.ts`
- Modify: `apps/server/src/symphony/runModel.ts`
- Modify: `apps/server/src/symphony/runLifecycle.ts`
- Modify: `apps/server/src/symphony/lifecyclePolicy.ts`
- Modify: `packages/shared/src/symphony.ts`
- Delete: `apps/server/src/symphony/lifecyclePhase.ts` and `lifecyclePhase.test.ts`

- [ ] **Step 1: Update `SymphonyRunStatus` in contracts**

In `packages/contracts/src/symphony.ts`, change `SymphonyRunStatus` to exactly:

```ts
export const SymphonyRunStatus = Schema.Literal(
  "intake",
  "planning",
  "implementing",
  "in-review",
  "completed",
  "canceled",
  "failed",
);
export type SymphonyRunStatus = Schema.Schema.Type<typeof SymphonyRunStatus>;
```

Remove all other status literals.

- [ ] **Step 2: Drop `SymphonyLifecyclePhase` and `lifecyclePhase` field**

Remove `SymphonyLifecyclePhase` schema/type entirely from contracts. Update `SymphonyRun` to drop the `lifecyclePhase` field.

- [ ] **Step 3: Run typecheck and fix every cascade error**

```bash
bun typecheck
```

Iterate file-by-file until typecheck passes:

- `runModel.ts`: drop `lifecyclePhase` from `makeRun` and any helpers
- `runLifecycle.ts`: drop branches keyed on phase; map remaining states to the 7-value enum
- `lifecyclePolicy.ts`: update `MONITORED_RUN_STATUSES` to the new set
- `packages/shared/src/symphony.ts`: update archive eligibility helper
- `apps/web/src/components/symphony/*`: update display labels and conditional renders

- [ ] **Step 4: Update tests**

Adjust every test that references the old enum or `lifecyclePhase`. Many existing tests need parameter updates.

- [ ] **Step 5: Delete `lifecyclePhase.ts`**

```bash
grep -rn "lifecyclePhase\|LifecyclePhase" apps/server/src apps/web/src packages/
```

If zero callers, delete:

```bash
rm apps/server/src/symphony/lifecyclePhase.ts apps/server/src/symphony/lifecyclePhase.test.ts
```

- [ ] **Step 6: Run all gates**

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(symphony): collapse status to 7 values, delete lifecyclePhase

intake / planning / implementing / in-review / completed / canceled /
failed. archivedAt remains separate. The lifecyclePhase enum is gone;
its semantics fold into status.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.7: Wizard server RPCs

**Files:**

- Modify: `packages/contracts/src/symphony.ts`
- Modify: `packages/contracts/src/rpc.ts`
- Modify: `packages/contracts/src/ipc.ts`
- Modify: `apps/server/src/symphony/Services/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/ws.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.test.ts`
- Modify: `apps/web/src/rpc/wsRpcClient.ts`
- Modify: `apps/web/src/environmentApi.ts`
- Modify: `apps/web/src/localApi.test.ts`

- [ ] **Step 1: Add RPC schemas to contracts**

In `packages/contracts/src/symphony.ts`, add:

```ts
export const SymphonyLinearProject = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slugId: Schema.String,
  teamName: Schema.String,
});
export type SymphonyLinearProject = Schema.Schema.Type<typeof SymphonyLinearProject>;

export const SymphonyLinearWorkflowState = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String, // "started", "completed", "canceled", etc.
  position: Schema.Number,
});
export type SymphonyLinearWorkflowState = Schema.Schema.Type<typeof SymphonyLinearWorkflowState>;

export const SymphonyApplyConfigurationInput = Schema.Struct({
  projectId: ProjectId,
  trackerProjectSlugId: Schema.String,
  trackerProjectName: Schema.String,
  states: Schema.Struct({
    intake: Schema.Array(Schema.String),
    active: Schema.Array(Schema.String),
    review: Schema.Array(Schema.String),
    done: Schema.Array(Schema.String),
    canceled: Schema.Array(Schema.String),
  }),
  validation: Schema.Array(Schema.String),
  prBaseBranch: Schema.String,
});
export type SymphonyApplyConfigurationInput = Schema.Schema.Type<
  typeof SymphonyApplyConfigurationInput
>;

// Method names
export const SYMPHONY_FETCH_LINEAR_PROJECTS = "symphony.fetchLinearProjects" as const;
export const SYMPHONY_FETCH_LINEAR_WORKFLOW_STATES = "symphony.fetchLinearWorkflowStates" as const;
export const SYMPHONY_APPLY_CONFIGURATION = "symphony.applyConfiguration" as const;
```

- [ ] **Step 2: Add RPC group entries in `rpc.ts`**

In `packages/contracts/src/rpc.ts`, add new RPC method definitions for each (`WsSymphonyFetchLinearProjectsRpc`, etc.) and add them to the Symphony RPC group.

- [ ] **Step 3: Add IPC entries in `ipc.ts`**

In `packages/contracts/src/ipc.ts`, add:

```ts
fetchLinearProjects: (input: { apiKey: string }) => Promise<readonly SymphonyLinearProject[]>;
fetchLinearWorkflowStates: (input: { apiKey: string; projectSlugId: string }) =>
  Promise<readonly SymphonyLinearWorkflowState[]>;
applyConfiguration: (input: SymphonyApplyConfigurationInput) =>
  Promise<{ ok: true; reloaded: boolean } | { ok: false; error: string }>;
```

- [ ] **Step 4: Add to Service interface and Layer implementation**

In `Services/SymphonyService.ts`, add three new methods to the interface.

In `Layers/SymphonyService.ts`, implement them. Each calls into `linear.ts`:

```ts
fetchLinearProjects: (input) => Effect.gen(function* () {
  const result = yield* fetchLinearTeamsAndProjects({ apiKey: input.apiKey });
  return result.teams.flatMap((team) =>
    team.projects.map((project) => ({
      id: project.id,
      name: project.name,
      slugId: project.slugId,
      teamName: team.name,
    })),
  );
}),
```

(`fetchLinearTeamsAndProjects` is a new helper added to `linear.ts`. The next sub-step.)

- [ ] **Step 5: Add Linear helpers in `linear.ts`**

In `linear.ts`, add the GraphQL queries:

```ts
const LINEAR_TEAMS_AND_PROJECTS_QUERY = `
  query SymphonyTeamsAndProjects {
    teams {
      nodes {
        id
        name
        projects {
          nodes {
            id
            name
            slugId
          }
        }
      }
    }
  }
`;

const LINEAR_WORKFLOW_STATES_QUERY = `
  query SymphonyWorkflowStates($teamId: String!) {
    team(id: $teamId) {
      states {
        nodes {
          id
          name
          type
          position
        }
      }
    }
  }
`;
```

Plus the corresponding `fetchLinearTeamsAndProjects(input)` and `fetchLinearWorkflowStates(input)` Effect functions.

- [ ] **Step 6: Wire WS handlers in `ws.ts`**

In `apps/server/src/ws.ts`, add three new RPC handlers that delegate to the Service.

- [ ] **Step 7: Wire client RPCs**

In `apps/web/src/rpc/wsRpcClient.ts` and `apps/web/src/environmentApi.ts`, expose the three new methods on `api.symphony`.

In `apps/web/src/localApi.test.ts`, add typed mock methods.

- [ ] **Step 8: Add wizard composition tests in `SymphonyService.test.ts`**

```ts
describe("Wizard RPCs", () => {
  it("fetchLinearProjects flattens teams.projects with slugId", async () => {
    // mocked Linear returns two teams, each with two projects
    // expect a flat list of 4 projects with team names attached
  });

  it("fetchLinearWorkflowStates returns the team's states sorted by position", async () => {
    // mocked Linear returns 5 states out of order
    // expect sorted output
  });

  it("applyConfiguration writes WORKFLOW.md and triggers reload", async () => {
    // mock the file system
    // verify the YAML written matches expected schema shape
    // verify the workflow store reloaded
  });
});
```

- [ ] **Step 9: Run gates**

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(symphony): add wizard RPCs (fetchLinearProjects, fetchLinearWorkflowStates, applyConfiguration)

Server-side endpoints called by the setup wizard. fetchLinearProjects
returns a flattened list of (team, project, slugId) tuples for the
project picker. fetchLinearWorkflowStates returns workflow states for
the chosen project, used by the state mapper. applyConfiguration writes
WORKFLOW.md atomically and triggers a reload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.8: Wizard UI — `LinearKeyInput.tsx`

**Files:**

- Create: `apps/web/src/components/symphony/LinearKeyInput.tsx`
- Create: `apps/web/src/components/symphony/LinearKeyInput.browser.tsx`

- [ ] **Step 1: Write failing browser test**

Create `apps/web/src/components/symphony/LinearKeyInput.browser.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "vitest-browser-react";

import { LinearKeyInput } from "./LinearKeyInput.tsx";

describe("LinearKeyInput", () => {
  it("calls onValidate with the key on blur", async () => {
    const onValidate = vi.fn().mockResolvedValue({ ok: true });
    const onValid = vi.fn();
    render(<LinearKeyInput onValidate={onValidate} onValid={onValid} />);

    const input = screen.getByLabelText("Linear API key");
    await userEvent.type(input, "lin_api_abc");
    await userEvent.tab(); // blur

    expect(onValidate).toHaveBeenCalledWith("lin_api_abc");
  });

  it("shows the OAuth-token error when the key looks JWT-shaped", async () => {
    const onValidate = vi.fn().mockResolvedValue({
      ok: false,
      error:
        "This looks like an OAuth/JWT token. Symphony requires a personal API key (lin_api_*).",
    });
    render(<LinearKeyInput onValidate={onValidate} onValid={() => {}} />);

    const input = screen.getByLabelText("Linear API key");
    await userEvent.type(input, "eyJhbGciOiJIUzI1NiJ9.payload.signature");
    await userEvent.tab();

    await expect.element(screen.getByText(/OAuth/)).toBeInTheDocument();
  });

  it("calls onValid when the API confirms the key", async () => {
    const onValidate = vi.fn().mockResolvedValue({ ok: true });
    const onValid = vi.fn();
    render(<LinearKeyInput onValidate={onValidate} onValid={onValid} />);

    const input = screen.getByLabelText("Linear API key");
    await userEvent.type(input, "lin_api_xxx");
    await userEvent.tab();

    await vi.waitFor(() => {
      expect(onValid).toHaveBeenCalledWith("lin_api_xxx");
    });
  });
});
```

- [ ] **Step 2: Run test (expected to fail)**

```bash
bun run test apps/web/src/components/symphony/LinearKeyInput.browser.tsx
```

- [ ] **Step 3: Implement `LinearKeyInput.tsx`**

Create `apps/web/src/components/symphony/LinearKeyInput.tsx`:

```tsx
import { useState } from "react";

export interface LinearKeyValidationResult {
  readonly ok: boolean;
  readonly error?: string;
}

export interface LinearKeyInputProps {
  readonly onValidate: (key: string) => Promise<LinearKeyValidationResult>;
  readonly onValid: (key: string) => void;
}

export function LinearKeyInput(props: LinearKeyInputProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);

  async function handleBlur() {
    if (value.trim().length === 0) {
      setError(null);
      return;
    }
    setValidating(true);
    setError(null);
    const result = await props.onValidate(value);
    setValidating(false);
    if (result.ok) {
      props.onValid(value);
    } else {
      setError(result.error ?? "Linear rejected the key");
    }
  }

  return (
    <div>
      <label htmlFor="linear-api-key">Linear API key</label>
      <input
        id="linear-api-key"
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={handleBlur}
        placeholder="lin_api_..."
        disabled={validating}
      />
      {validating ? <p>Validating...</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test**

```bash
bun run test apps/web/src/components/symphony/LinearKeyInput.browser.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(web): add LinearKeyInput wizard component

Validates the API key on blur via the parent-supplied callback. Shows
specific errors (Bearer prefix, OAuth/JWT, empty, network). Calls
onValid only when Linear confirms the key.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.9: Wizard UI — `LinearProjectPicker.tsx`

**Files:**

- Create: `apps/web/src/components/symphony/LinearProjectPicker.tsx`
- Create: `apps/web/src/components/symphony/LinearProjectPicker.browser.tsx`

- [ ] **Step 1: Write failing browser test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "vitest-browser-react";

import { LinearProjectPicker } from "./LinearProjectPicker.tsx";

describe("LinearProjectPicker", () => {
  it("renders a dropdown of projects grouped by team name", async () => {
    const projects = [
      { id: "p1", name: "Marketing site", slugId: "abc111", teamName: "Marketing" },
      { id: "p2", name: "Backend", slugId: "abc222", teamName: "Engineering" },
      { id: "p3", name: "Frontend", slugId: "abc333", teamName: "Engineering" },
    ];

    const onSelect = vi.fn();
    render(<LinearProjectPicker projects={projects} onSelect={onSelect} />);

    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.selectOptions(screen.getByRole("combobox"), "p2");

    expect(onSelect).toHaveBeenCalledWith({
      id: "p2",
      name: "Backend",
      slugId: "abc222",
      teamName: "Engineering",
    });
  });

  it("disables the select when no projects are available", () => {
    const onSelect = vi.fn();
    render(<LinearProjectPicker projects={[]} onSelect={onSelect} />);
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
bun run test apps/web/src/components/symphony/LinearProjectPicker.browser.tsx
```

- [ ] **Step 3: Implement `LinearProjectPicker.tsx`**

```tsx
import type { SymphonyLinearProject } from "@t3tools/contracts";

export interface LinearProjectPickerProps {
  readonly projects: readonly SymphonyLinearProject[];
  readonly onSelect: (project: SymphonyLinearProject) => void;
}

export function LinearProjectPicker(props: LinearProjectPickerProps) {
  const grouped = new Map<string, SymphonyLinearProject[]>();
  for (const project of props.projects) {
    const list = grouped.get(project.teamName) ?? [];
    list.push(project);
    grouped.set(project.teamName, list);
  }

  return (
    <div>
      <label htmlFor="symphony-project">Linear project</label>
      <select
        id="symphony-project"
        disabled={props.projects.length === 0}
        onChange={(e) => {
          const project = props.projects.find((p) => p.id === e.target.value);
          if (project) props.onSelect(project);
        }}
        defaultValue=""
      >
        <option value="" disabled>
          Choose a project
        </option>
        {[...grouped.entries()].map(([teamName, list]) => (
          <optgroup key={teamName} label={teamName}>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(web): add LinearProjectPicker wizard component

Dropdown grouped by team. Emits the full project object including
slugId — never raw text typed by the user.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.10: Wizard UI — `LinearStateMapper.tsx`

**Files:**

- Create: `apps/web/src/components/symphony/LinearStateMapper.tsx`
- Create: `apps/web/src/components/symphony/LinearStateMapper.browser.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "vitest-browser-react";

import { LinearStateMapper } from "./LinearStateMapper.tsx";

const states = [
  { id: "s1", name: "Backlog", type: "backlog", position: 0 },
  { id: "s2", name: "To Do", type: "unstarted", position: 1 },
  { id: "s3", name: "In Progress", type: "started", position: 2 },
  { id: "s4", name: "In Review", type: "started", position: 3 },
  { id: "s5", name: "Done", type: "completed", position: 4 },
  { id: "s6", name: "Canceled", type: "canceled", position: 5 },
];

describe("LinearStateMapper", () => {
  it("calls onChange when the user toggles state checkboxes", async () => {
    const onChange = vi.fn();
    render(<LinearStateMapper states={states} onChange={onChange} />);

    await userEvent.click(screen.getByLabelText("To Do (intake)"));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        intake: ["To Do"],
      }),
    );
  });

  it("seeds defaults from Linear state types", () => {
    const onChange = vi.fn();
    render(<LinearStateMapper states={states} onChange={onChange} />);

    expect(screen.getByLabelText("To Do (intake)")).toBeChecked();
    expect(screen.getByLabelText("In Progress (active)")).toBeChecked();
    expect(screen.getByLabelText("In Review (review)")).toBeChecked();
    expect(screen.getByLabelText("Done (done)")).toBeChecked();
    expect(screen.getByLabelText("Canceled (canceled)")).toBeChecked();
    expect(screen.getByLabelText("Backlog (intake)")).not.toBeChecked();
  });
});
```

- [ ] **Step 2: Verify failure**

- [ ] **Step 3: Implement `LinearStateMapper.tsx`**

```tsx
import { useEffect, useState } from "react";

import type { SymphonyLinearWorkflowState } from "@t3tools/contracts";

type SlotKey = "intake" | "active" | "review" | "done" | "canceled";
const SLOTS: readonly SlotKey[] = ["intake", "active", "review", "done", "canceled"] as const;

export interface LinearStateMapping {
  readonly intake: readonly string[];
  readonly active: readonly string[];
  readonly review: readonly string[];
  readonly done: readonly string[];
  readonly canceled: readonly string[];
}

export interface LinearStateMapperProps {
  readonly states: readonly SymphonyLinearWorkflowState[];
  readonly onChange: (mapping: LinearStateMapping) => void;
}

function defaultSlotForType(type: string): SlotKey | null {
  switch (type) {
    case "unstarted":
      return "intake";
    case "started":
      return "active";
    case "completed":
      return "done";
    case "canceled":
      return "canceled";
    default:
      return null;
  }
}

export function LinearStateMapper(props: LinearStateMapperProps) {
  const [mapping, setMapping] = useState<Record<SlotKey, Set<string>>>(() => {
    const initial: Record<SlotKey, Set<string>> = {
      intake: new Set(),
      active: new Set(),
      review: new Set(),
      done: new Set(),
      canceled: new Set(),
    };
    for (const state of props.states) {
      const slot = defaultSlotForType(state.type);
      if (slot) initial[slot].add(state.name);
    }
    // promote one "started" state to "review" if Linear has an "In Review" by name
    const inReview = props.states.find((s) => s.name === "In Review");
    if (inReview) {
      initial.active.delete("In Review");
      initial.review.add("In Review");
    }
    return initial;
  });

  useEffect(() => {
    const out: LinearStateMapping = {
      intake: [...mapping.intake],
      active: [...mapping.active],
      review: [...mapping.review],
      done: [...mapping.done],
      canceled: [...mapping.canceled],
    };
    props.onChange(out);
  }, [mapping, props]);

  function toggle(slot: SlotKey, name: string) {
    setMapping((prev) => {
      const next = { ...prev, [slot]: new Set(prev[slot]) };
      if (next[slot].has(name)) next[slot].delete(name);
      else next[slot].add(name);
      return next;
    });
  }

  return (
    <div>
      {props.states.map((state) => (
        <fieldset key={state.id}>
          <legend>{state.name}</legend>
          {SLOTS.map((slot) => (
            <label key={slot}>
              <input
                type="checkbox"
                checked={mapping[slot].has(state.name)}
                onChange={() => toggle(slot, state.name)}
              />
              {`${state.name} (${slot})`}
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run test**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(web): add LinearStateMapper wizard component

Checkbox grid mapping each lifecycle slot (intake/active/review/done/
canceled) to one or more Linear state names. Defaults seeded from
Linear state types and the "In Review" name.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.11: Wizard UI — `WizardProgress.tsx` and `SettingsWizard.tsx`

**Files:**

- Create: `apps/web/src/components/symphony/WizardProgress.tsx`
- Create: `apps/web/src/components/symphony/SettingsWizard.tsx`
- Create: `apps/web/src/components/symphony/SettingsWizard.browser.tsx`

- [ ] **Step 1: Write failing wizard composition test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "vitest-browser-react";

import { SettingsWizard } from "./SettingsWizard.tsx";

const noopApi = {
  validateKey: vi.fn().mockResolvedValue({ ok: true }),
  fetchProjects: vi
    .fn()
    .mockResolvedValue([{ id: "p1", name: "BattleTCG", slugId: "abc111", teamName: "Eng" }]),
  fetchStates: vi.fn().mockResolvedValue([
    { id: "s1", name: "To Do", type: "unstarted", position: 0 },
    { id: "s2", name: "In Progress", type: "started", position: 1 },
    { id: "s3", name: "In Review", type: "started", position: 2 },
    { id: "s4", name: "Done", type: "completed", position: 3 },
    { id: "s5", name: "Canceled", type: "canceled", position: 4 },
  ]),
  applyConfiguration: vi.fn().mockResolvedValue({ ok: true, reloaded: true }),
};

describe("SettingsWizard", () => {
  it("walks through key → project → states → save", async () => {
    render(<SettingsWizard api={noopApi} />);

    // Step 1: paste key
    const key = screen.getByLabelText("Linear API key");
    await userEvent.type(key, "lin_api_xxx");
    await userEvent.tab();

    // Step 2: pick project
    await vi.waitFor(() => screen.getByLabelText("Linear project"));
    await userEvent.selectOptions(screen.getByLabelText("Linear project"), "p1");

    // Step 3: state mapper appears with defaults
    await vi.waitFor(() => screen.getByLabelText("To Do (intake)"));

    // Step 4: save
    await userEvent.click(screen.getByText("Save configuration"));

    await vi.waitFor(() => {
      expect(noopApi.applyConfiguration).toHaveBeenCalledWith(
        expect.objectContaining({
          trackerProjectSlugId: "abc111",
          states: expect.objectContaining({
            intake: ["To Do"],
            active: ["In Progress"],
            review: ["In Review"],
            done: ["Done"],
            canceled: ["Canceled"],
          }),
        }),
      );
    });
  });
});
```

- [ ] **Step 2: Implement `WizardProgress.tsx`**

```tsx
export interface WizardProgressProps {
  readonly steps: readonly string[];
  readonly currentIndex: number;
}

export function WizardProgress(props: WizardProgressProps) {
  return (
    <ol>
      {props.steps.map((step, idx) => (
        <li key={step} aria-current={idx === props.currentIndex ? "step" : undefined}>
          {step}
        </li>
      ))}
    </ol>
  );
}
```

- [ ] **Step 3: Implement `SettingsWizard.tsx`**

```tsx
import { useState } from "react";

import { LinearKeyInput } from "./LinearKeyInput.tsx";
import { LinearProjectPicker } from "./LinearProjectPicker.tsx";
import { LinearStateMapper, type LinearStateMapping } from "./LinearStateMapper.tsx";
import { WizardProgress } from "./WizardProgress.tsx";

import type { SymphonyLinearProject, SymphonyLinearWorkflowState } from "@t3tools/contracts";

export interface SettingsWizardApi {
  readonly validateKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  readonly fetchProjects: (key: string) => Promise<readonly SymphonyLinearProject[]>;
  readonly fetchStates: (
    key: string,
    project: SymphonyLinearProject,
  ) => Promise<readonly SymphonyLinearWorkflowState[]>;
  readonly applyConfiguration: (input: {
    readonly trackerProjectSlugId: string;
    readonly trackerProjectName: string;
    readonly states: LinearStateMapping;
    readonly validation: readonly string[];
    readonly prBaseBranch: string;
  }) => Promise<{ ok: true; reloaded: boolean } | { ok: false; error: string }>;
}

export interface SettingsWizardProps {
  readonly api: SettingsWizardApi;
}

export function SettingsWizard(props: SettingsWizardProps) {
  const [step, setStep] = useState(0);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly SymphonyLinearProject[]>([]);
  const [project, setProject] = useState<SymphonyLinearProject | null>(null);
  const [states, setStates] = useState<readonly SymphonyLinearWorkflowState[]>([]);
  const [mapping, setMapping] = useState<LinearStateMapping | null>(null);
  const [saved, setSaved] = useState<{ ok: true } | { ok: false; error: string } | null>(null);

  async function handleValidKey(key: string) {
    setApiKey(key);
    const projects = await props.api.fetchProjects(key);
    setProjects(projects);
    setStep(1);
  }

  async function handleSelectProject(p: SymphonyLinearProject) {
    setProject(p);
    if (apiKey) {
      const states = await props.api.fetchStates(apiKey, p);
      setStates(states);
    }
    setStep(2);
  }

  async function handleSave() {
    if (!project || !mapping) return;
    const result = await props.api.applyConfiguration({
      trackerProjectSlugId: project.slugId,
      trackerProjectName: project.name,
      states: mapping,
      validation: ["bun fmt", "bun lint", "bun typecheck", "bun run test"],
      prBaseBranch: "development",
    });
    setSaved(result);
  }

  return (
    <div>
      <WizardProgress steps={["API key", "Project", "States", "Save"]} currentIndex={step} />
      {step === 0 ? (
        <LinearKeyInput onValidate={(k) => props.api.validateKey(k)} onValid={handleValidKey} />
      ) : null}
      {step === 1 ? (
        <LinearProjectPicker projects={projects} onSelect={handleSelectProject} />
      ) : null}
      {step === 2 ? (
        <>
          <LinearStateMapper states={states} onChange={setMapping} />
          <button type="button" onClick={handleSave}>
            Save configuration
          </button>
        </>
      ) : null}
      {saved && saved.ok ? <p>Configuration saved.</p> : null}
      {saved && !saved.ok ? <p role="alert">{saved.error}</p> : null}
    </div>
  );
}
```

- [ ] **Step 4: Run test**

```bash
bun run test apps/web/src/components/symphony/SettingsWizard.browser.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(web): add Symphony setup wizard

WizardProgress + SettingsWizard compose LinearKeyInput,
LinearProjectPicker, and LinearStateMapper into a 4-step guided flow.
On save, calls applyConfiguration with the captured slugId, project
name, state mapping, and defaults for validation + PR base branch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.12: Wire wizard into `SymphonySettingsPanel`, delete `LinearAuthSettings`

**Files:**

- Modify: `apps/web/src/components/symphony/SymphonySettingsPanel.tsx` and `.browser.tsx`
- Delete: `apps/web/src/components/symphony/LinearAuthSettings.tsx`

- [ ] **Step 1: Update settings panel to render `SettingsWizard`**

In `SymphonySettingsPanel.tsx`, replace the `LinearAuthSettings` reference with `SettingsWizard`. Map the panel's RPC client onto the `SettingsWizardApi` shape:

```tsx
import { useApi } from "../../api.ts"; // or wherever the api hook lives
import { SettingsWizard, type SettingsWizardApi } from "./SettingsWizard.tsx";

export function SymphonySettingsPanel() {
  const api = useApi();
  const wizardApi: SettingsWizardApi = {
    validateKey: async (key) => {
      try {
        await api.symphony.testLinearConnection({ apiKey: key });
        return { ok: true };
      } catch (e: unknown) {
        return { ok: false, error: (e as Error).message };
      }
    },
    fetchProjects: (key) => api.symphony.fetchLinearProjects({ apiKey: key }),
    fetchStates: (key, project) =>
      api.symphony.fetchLinearWorkflowStates({ apiKey: key, projectSlugId: project.slugId }),
    applyConfiguration: (input) =>
      api.symphony.applyConfiguration({
        projectId: useProjectId(), // hook to get current project
        ...input,
      }),
  };
  return <SettingsWizard api={wizardApi} />;
}
```

- [ ] **Step 2: Update browser test**

In `SymphonySettingsPanel.browser.tsx`, mock the api and verify the wizard renders.

- [ ] **Step 3: Delete `LinearAuthSettings.tsx`**

```bash
grep -rn "LinearAuthSettings" apps/web/src
rm apps/web/src/components/symphony/LinearAuthSettings.tsx
```

- [ ] **Step 4: Run gates**

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(web): replace LinearAuthSettings with SettingsWizard

The settings panel now hosts the guided wizard. LinearAuthSettings is
deleted; the wizard's first step covers API key entry and validation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.13: Per-symptom isolation in poll loops

**Files:**

- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.test.ts`

- [ ] **Step 1: Write failing isolation tests**

Add to `SymphonyService.test.ts`:

```ts
describe("Per-symptom isolation", () => {
  it("scheduler 400 does not block reconciler", async () => {
    // arrange: linear poll for intake fails 400; linear poll for terminals succeeds
    // act: run one tick of the runtime
    // assert: reconciler observed terminal issues; archived a run
    // assert: scheduler logged the 400 but did NOT prevent the reconciler from running
  });

  it("reconciler 400 does not block scheduler", async () => {
    // arrange: linear poll for intake succeeds; linear poll for terminals fails 400
    // act: run one tick
    // assert: scheduler created a new run; reconciler logged the 400
  });

  it("Linear write failure for run A does not affect run B", async () => {
    // arrange: two in-flight runs A and B; linear write for A fails
    // act: orchestrator processes both
    // assert: run B's writes succeeded; run A has lastError set; run B is unaffected
  });
});
```

- [ ] **Step 2: Verify failure (or partial pass)**

- [ ] **Step 3: Refactor scheduler/reconciler/orchestrator dispatch into independent Effects**

In `Layers/SymphonyService.ts`, find `runSchedulerTick` (or whatever the current top-level Effect chain is). Refactor so the three concerns each have their own catch boundary:

```ts
const tick = Effect.all(
  [
    schedulerTick().pipe(
      Effect.catchAll((error) =>
        Effect.logError("scheduler tick failed", { error }).pipe(Effect.as(undefined)),
      ),
    ),
    runOrchestratorTick().pipe(
      Effect.catchAll((error) =>
        Effect.logError("run orchestrator tick failed", { error }).pipe(Effect.as(undefined)),
      ),
    ),
    reconcilerTick().pipe(
      Effect.catchAll((error) =>
        Effect.logError("reconciler tick failed", { error }).pipe(Effect.as(undefined)),
      ),
    ),
  ],
  { concurrency: "unbounded" },
);
```

Inside `runOrchestratorTick`, each per-run Effect also has its own catch boundary so that one run's failure does not cascade to another:

```ts
const tickAllRuns = (runs) =>
  Effect.all(
    runs.map((run) =>
      orchestrateRun(run).pipe(
        Effect.catchAll((error) =>
          Effect.logError(`run ${run.runId} failed`, { error }).pipe(
            Effect.flatMap(() => recordRunError(run.runId, error)),
          ),
        ),
      ),
    ),
    { concurrency: "unbounded" },
  );
```

- [ ] **Step 4: Run isolation tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(symphony): per-symptom and per-run isolation in poll loops

Scheduler tick, run orchestrator tick, and reconciler tick run as
independent Effects with their own catch boundaries. Each in-flight
run is also isolated. A Linear 400 in scheduler can no longer cascade
to terminal-state reconciliation or to in-flight runs.

This is the structural fix for the user-reported "issues not picked up"
cascade.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.14: Stall detection

**Files:**

- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.test.ts`

- [ ] **Step 1: Write failing test**

```ts
describe("Stall detection", () => {
  it("kills a Codex turn and marks run failed when no thread events for stall_timeout_ms", async () => {
    // arrange: run in 'planning' status; thread last event 6 minutes ago
    // workflow.stall.timeoutMs = 300000 (5 min)
    // act: run one orchestrator tick
    // assert: run.status === 'failed', run.lastError contains 'stalled'
    // assert: codexAppServerManager.disposeSession was called for the run's thread
  });

  it("does not kill a turn that just had a thread event", async () => {
    // arrange: run in 'planning' status; thread last event 10 seconds ago
    // act: run one orchestrator tick
    // assert: run still in 'planning'
  });
});
```

- [ ] **Step 2: Implement stall check**

In `Layers/SymphonyService.ts`, add a stall check inside the per-run orchestrator tick:

```ts
function isStalled(
  run: { lastEventAt: string | null },
  now: Date,
  stallTimeoutMs: number,
): boolean {
  if (run.lastEventAt === null) return false;
  return now.getTime() - new Date(run.lastEventAt).getTime() > stallTimeoutMs;
}

// in orchestrateRun:
if (run.status === "planning" || run.status === "implementing") {
  const stallTimeoutMs = workflow.stall.timeoutMs;
  if (isStalled(run, new Date(), stallTimeoutMs)) {
    yield * codexAppServerManager.disposeSession(run.threadId);
    yield *
      runRepository.updateRun({
        runId: run.runId,
        status: "failed",
        lastError: `stalled (no agent progress for ${stallTimeoutMs}ms)`,
      });
    return;
  }
}
```

`run.lastEventAt` is updated whenever a thread event arrives. If it's not already a column, add it via the migration in Task 4.1 (revisit if needed; otherwise compute from existing event-log queries).

- [ ] **Step 3: Run tests**

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(symphony): stall detection per workflow.stall.timeoutMs

Per-run wallclock from the last thread event. When the elapsed time
exceeds the configured stall timeout (default 5 min), the orchestrator
disposes the Codex session and marks the run failed with reason
"stalled".

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.15: Concurrency cap enforcement

**Files:**

- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.test.ts`

- [ ] **Step 1: Write failing test**

```ts
describe("Concurrency cap", () => {
  it("dispatches only `concurrency.max` runs when more candidates are available", async () => {
    // arrange: 5 candidates in intake; concurrency.max = 3; 0 currently running
    // act: scheduler tick
    // assert: 3 new runs created (status 'planning'); 2 candidates left in Linear
  });

  it("counts only planning/implementing toward the cap", async () => {
    // arrange: 1 in-review run + 1 intake run + 5 candidates; concurrency.max = 3
    // act: scheduler tick
    // assert: 2 new runs dispatched (3 - 1 intake = 2 capacity)
  });
});
```

- [ ] **Step 2: Verify passes (scheduler.ts already has capacity logic)**

The capacity logic was added in Task 2.4. Verify the integration in `Layers/SymphonyService.ts` supplies the right `runningCount`:

```ts
const runningCount = (yield * runRepository.listRunsByStatus(["planning", "implementing"])).length;
const decisions = decideSchedulerActions({
  candidates,
  existingRuns,
  intakeStates: workflow.states.intake,
  capacity: workflow.concurrency.max,
  runningCount,
});
```

If the call site in `Layers/SymphonyService.ts` doesn't yet match this shape, fix it.

- [ ] **Step 3: Run tests**

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(symphony): enforce concurrency.max cap

Wires scheduler.decideSchedulerActions into the runtime with the
configured concurrency.max as the cap. Only planning/implementing
statuses count toward the running budget.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5: Audit and Cleanup

Goal: ensure no dead code remains. Run the dead-code analyzers and grep audits.

### Task 5.1: Audit `Layers/GitHubCli.ts` callers

**Files:**

- Possibly delete: `apps/server/src/git/Layers/GitHubCli.ts` and `Services/GitHubCli.ts`

- [ ] **Step 1: Find remaining callers**

Run:

```bash
grep -rn "GitHubCli\|GitHubCliShape\|@t3tools/server/git" apps/server/src apps/web/src packages/
```

- [ ] **Step 2: If zero callers, delete the file pair**

```bash
rm apps/server/src/git/Layers/GitHubCli.ts apps/server/src/git/Services/GitHubCli.ts
rm apps/server/src/git/Layers/GitHubCli.test.ts # if present
```

If callers remain (e.g., for clone/init operations), leave the file but verify only non-PR helpers remain.

- [ ] **Step 3: Run gates**

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

- [ ] **Step 4: Commit (only if changes were made)**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(git): delete GitHubCli (no remaining callers)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.2: Run `fallow` for dead exports

**Files:**

- (audit only)

- [ ] **Step 1: Run fallow**

Run:

```bash
fallow exports
```

- [ ] **Step 2: For each reported dead export in Symphony / Linear / cloud / git PR helpers**

Investigate. If truly dead, delete. If accidentally orphaned, restore the call site.

Run the relevant gates (`bun typecheck`) after each deletion.

- [ ] **Step 3: Commit any deletions**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: delete dead exports flagged by fallow

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.3: Strict unused-import lint

**Files:**

- (audit only)

- [ ] **Step 1: Run lint**

```bash
bun lint
```

- [ ] **Step 2: For each warning about unused imports/vars, fix it**

This should be near-zero after fallow, but lint catches different things.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore: remove unused imports flagged by oxlint

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.4: Manual greps for stale references

**Files:**

- (audit only)

- [ ] **Step 1: Grep for "cloud" in symphony source**

```bash
grep -rn "cloud" apps/server/src/symphony/ apps/web/src/components/symphony/ packages/contracts/src/symphony.ts packages/shared/src/symphony.ts
```

Expected: zero hits relevant to Symphony. Hits in unrelated docs are fine.

- [ ] **Step 2: Grep for "executionTarget"**

```bash
grep -rn "executionTarget" --exclude-dir=node_modules apps/ packages/
```

Expected: zero hits.

- [ ] **Step 3: Grep for "lifecyclePhase" outside type definitions**

```bash
grep -rn "lifecyclePhase\|LifecyclePhase" --exclude-dir=node_modules apps/ packages/
```

Expected: zero hits.

- [ ] **Step 4: If any hits remain, address them**

For each remaining hit, decide: delete, rename, or adjust.

- [ ] **Step 5: Commit any cleanup**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(symphony): final dead-reference sweep

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.5: Audit `.plans/` and `docs/` for stale notes

**Files:**

- Possibly modify: files under `.plans/` and `docs/`

- [ ] **Step 1: List candidates**

```bash
grep -rln "Symphony.*[Cc]loud\|cloud.*Symphony\|executionTarget" .plans/ docs/
```

- [ ] **Step 2: For each file**

- If it's a historical record (e.g., a spec from before the redesign), leave it.
- If it's an active design / plan that contradicts the new direction, mark as superseded.

For example, prepend to the May 1 cloud plan a note: `> SUPERSEDED by 2026-05-03-symphony-local-only-redesign-design.md`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: mark superseded Symphony cloud plans

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6: Migration and Verification

Goal: validate the migration runs cleanly on a real database and run the manual end-to-end script.

### Task 6.1: Verify migration on a test database

**Files:**

- (verification only — no code changes)

- [ ] **Step 1: Make a backup of the dev DB if one exists**

```bash
# inspect where dev SQLite DB lives; typically apps/server/data/*.sqlite or similar
find apps/server -name "*.sqlite" -not -path "*/node_modules/*"
```

If a dev DB exists, copy it:

```bash
cp <found-path> <found-path>.backup-$(date +%s)
```

- [ ] **Step 2: Start the server**

```bash
cd apps/server && bun run dev
```

Watch for migration log output. Migration 032 should run automatically and log:

```
Running all migrations...
Migrations ran successfully { migrations: [..., '32_SymphonyLocalOnly'] }
```

- [ ] **Step 3: Inspect schema**

In another terminal:

```bash
sqlite3 <db-path> "PRAGMA table_info(symphony_runs);"
```

Verify:

- `last_seen_linear_state` column exists
- `execution_target`, `cloud_task_json` columns are absent

```bash
sqlite3 <db-path> "SELECT run_id, status, archived_at FROM symphony_runs WHERE archived_at IS NOT NULL AND last_error LIKE '%Auto-archived%' LIMIT 10;"
```

Verify any pre-existing cloud runs are now status=canceled with `archivedAt` set and the auto-archive note.

- [ ] **Step 4: Stop the server**

```bash
# in the dev terminal
^C
```

### Task 6.2: Run end-to-end manual script

**Files:**

- (verification only)

This is the scripted manual end-to-end specified in the design's "Testing Strategy" section.

- [ ] **Step 1: Configure via wizard**

Open the web UI; navigate to Symphony settings. Walk through the wizard:

- Paste a valid `lin_api_*` key (use a test Linear workspace if possible)
- Pick a project
- Map states (defaults should be sensible for the test workspace)
- Save

Verify `WORKFLOW.md` at the repo root has the expected frontmatter.

- [ ] **Step 2: Create a test issue in Linear "To Do"**

Title: "Test Symphony local-only flow"
Description: short instruction the agent can act on (e.g., "Add a comment to README.md saying 'Symphony works'")

- [ ] **Step 3: Watch Symphony pick it up**

Within `polling.scheduler_interval_ms` + jitter (~30s), Symphony should:

- Create a run row
- Open a T3 chat thread for the issue
- Move Linear: To Do → In Progress
- Post the managed comment to Linear

- [ ] **Step 4: Watch Phase 1**

Inside the T3 chat UI, the agent should produce a plan. Look for `SYMPHONY_PLAN_BEGIN`/`SYMPHONY_PLAN_END` in the agent output. The Linear managed comment should update with the plan checklist.

- [ ] **Step 5: Watch Phase 2**

The agent should continue (turn 2), implement, run validation gates, and call `gh pr create`. Look for `SYMPHONY_PR_URL: <url>` in the agent output. The Linear managed comment should update with the PR link. Linear should move In Progress → In Review.

- [ ] **Step 6: Move issue to Done in Linear**

Within `polling.reconciler_interval_ms` (~60s), the run should auto-archive (status: completed, archivedAt set). It disappears from the active queue and the sidebar; appears in the Archived view.

- [ ] **Step 7: Test the cascade fix**

Temporarily break `WORKFLOW.md` (e.g., set `project_slug_id` to a bogus value). Trigger a scheduler tick. Verify:

- Linear poll fails with HTTP 400
- The full response body is visible in the dashboard event log
- The error banner offers "open wizard"
- In-flight runs are unaffected
- Reconciler still archives terminal issues
- Restoring the slugId restores normal operation

- [ ] **Step 8: Test stall detection**

Start a new run. Mid-Phase-1, kill the Codex process (find its PID; `kill <pid>`). After ~5 minutes (`stall.timeout_ms`), the run should mark `failed` with reason "stalled".

- [ ] **Step 9: Document any failures**

If any step fails, file an issue or adjust the implementation. The plan is not complete until all steps pass.

### Task 6.3: Documentation updates

**Files:**

- Modify: `README.md` (if it mentions Symphony)
- Modify: `AGENTS.md` (if it mentions Symphony)
- Possibly modify: `docs/` Symphony-related docs

- [ ] **Step 1: Grep docs for Symphony mentions**

```bash
grep -rln "Symphony\|symphony" README.md AGENTS.md docs/ --include="*.md"
```

- [ ] **Step 2: Update each doc**

For each file:

- Update any Symphony architecture description to reflect local-only
- Update setup instructions to point at the wizard
- Remove any references to cloud or Codex Cloud
- Remove any references to GitHub PR lookup at the orchestrator layer

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs: update Symphony references for local-only redesign

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.4: Final gates and PR

**Files:**

- (verification only)

- [ ] **Step 1: Run all gates one final time**

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

Expected: all pass.

- [ ] **Step 2: Check the dead-code criteria**

```bash
fallow exports # expect zero Symphony-related dead exports
grep -rn "cloud\|executionTarget\|lifecyclePhase" --exclude-dir=node_modules apps/server/src/symphony/ apps/web/src/components/symphony/ packages/contracts/src/symphony.ts packages/shared/src/symphony.ts
# expect zero hits
```

- [ ] **Step 3: Push branch**

```bash
git push -u origin t3code/symphony-lookup-errors
```

- [ ] **Step 4: Create PR**

```bash
gh pr create --base development --title "Symphony local-only redesign" --body "$(cat <<'EOF'
## Summary
- Implements the local-only Symphony redesign per `docs/superpowers/specs/2026-05-03-symphony-local-only-redesign-design.md`.
- Deletes Codex Cloud delegation and orchestrator-level GitHub PR lookup.
- Decomposes the 4,375-line `Layers/SymphonyService.ts` into focused pure helper modules.
- Adds a guided setup wizard so configuration is picked from Linear's API rather than typed by hand.
- Fixes the Linear 400 cascade by isolating scheduler / orchestrator / reconciler into independent Effects.

## Test plan
- [ ] `bun fmt` clean
- [ ] `bun lint` clean
- [ ] `bun typecheck` clean
- [ ] `bun run test` all pass
- [ ] Manual end-to-end (Phase 6, Task 6.2) — full lifecycle from wizard → run → PR → archive
- [ ] Cascade verification — break WORKFLOW.md and confirm reconciler/in-flight runs unaffected

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Validation Gates Summary

Every Phase ends with all four gates passing:

```bash
bun fmt && bun lint && bun typecheck && bun run test
```

A Phase is not "done" until these pass. If a Phase requires multiple commits to keep green, that's fine — but the final commit of the Phase must satisfy the gates.

## Self-Review Notes

- Spec coverage check: every "Files in Detail" item from the spec is touched by at least one task above. Cross-reference: deletion list (Phase 1, 4.4, 4.5, 4.6, 5.1) vs new files (Phase 2 extractions, 4.1, 4.4, 4.5, 4.7-4.12) vs modification list (Phase 3, 4.2, 4.3, 4.13, 4.14, 4.15).
- Acceptance criteria coverage: cleanup criteria → Phase 5; bug fix criteria → 4.2 (auth + body), 4.3 (schema hint), 4.13 (cascade isolation), 2.4 (lastSeenLinearState); new-behavior criteria → 4.7-4.12 (wizard), happy path → 6.2 (manual e2e), stall detection → 4.14, concurrency → 4.15.
- Type consistency: status enum values (`intake`, `planning`, `implementing`, `in-review`, `completed`, `canceled`, `failed`) used consistently across tasks 2.4, 3.x, 4.6. Marker constants (`SYMPHONY_PLAN_BEGIN`, `SYMPHONY_PLAN_END`, `SYMPHONY_PR_URL`) consistent across 2.3, 4.4, 4.5.
