# Symphony Linear Workflow Control Plane Implementation Plan

> **SUPERSEDED** by `docs/superpowers/specs/2026-05-03-symphony-local-only-redesign-design.md`.
> The lifecycle control-plane model (cloud/local hybrid, LifecyclePhase) was replaced by the
> local-only 7-state status model. This document is kept as a historical record only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Symphony the owner of Linear ticket planning, progress comments, agent phases, PR creation/reconciliation, and local/cloud lifecycle state.

**Architecture:** Add a Symphony lifecycle phase model beside the existing run status model. Keep `WORKFLOW.md` as declarative repo config, persist Linear progress/comment metadata on each run, and add a server-side lifecycle controller that sequences planning, implementation, simplification, review, rework, and PR reconciliation for both local and cloud runs.

**Tech Stack:** TypeScript, Effect, Effect Schema, SQLite migrations, Linear GraphQL, GitHub CLI services, React 19, Tailwind, Vitest, Bun/Turborepo.

---

## Scope Check

The approved spec is one subsystem: Symphony workflow orchestration. It touches contracts, persistence, Linear helpers, server orchestration, and UI, but those changes all serve one testable workflow. Implement it in thin vertical slices so each task compiles and passes targeted tests before the next task.

## Current Code Anchors

- Spec: `docs/superpowers/specs/2026-05-02-symphony-linear-workflow-control-plane-design.md`
- Contracts: `packages/contracts/src/symphony.ts`
- Workflow parser: `apps/server/src/symphony/workflow.ts`
- Lifecycle resolver: `apps/server/src/symphony/runLifecycle.ts`
- Run model helpers: `apps/server/src/symphony/runModel.ts`
- Linear API helpers: `apps/server/src/symphony/linear.ts`
- Symphony service: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Symphony repository: `apps/server/src/symphony/Layers/SymphonyRepository.ts`
- Migrations loader: `apps/server/src/persistence/Migrations.ts`
- Symphony tab: `apps/web/src/components/symphony/SymphonyPanel.tsx`
- Issue table: `apps/web/src/components/symphony/IssueQueueTable.tsx`
- Details drawer: `apps/web/src/components/symphony/RunDetailsDrawer.tsx`
- Sidebar logic: `apps/web/src/components/Sidebar.logic.ts`
- Sidebar component: `apps/web/src/components/Sidebar.tsx`

## File Structure

Create these focused modules:

- `apps/server/src/symphony/lifecyclePhase.ts`: phase names, phase classification, progress labels, and terminal/active helpers.
- `apps/server/src/symphony/progressComment.ts`: render managed Linear progress comments and milestone comment bodies.
- `apps/server/src/symphony/phasePrompts.ts`: build planning, implementation, simplification, review, and rework prompts.
- `apps/server/src/symphony/phaseOutput.ts`: extract proposed plans and review outcomes from orchestration thread messages.
- `apps/server/src/persistence/Migrations/031_SymphonyLifecycleControlPlane.ts`: add durable lifecycle metadata columns.
- `apps/server/src/persistence/Migrations/031_SymphonyLifecycleControlPlane.test.ts`: migration coverage.

Modify these existing files:

- `packages/contracts/src/symphony.ts`: add lifecycle phase/config/progress schemas and optional run metadata.
- `packages/contracts/src/symphony.test.ts`: contract decode/default tests.
- `apps/server/src/symphony/workflow.ts`: starter workflow template and parser coverage.
- `apps/server/src/symphony/workflow.test.ts`: lifecycle config parsing tests.
- `apps/server/src/symphony/linear.ts`: managed comment create/update/list helpers and feedback query helpers.
- `apps/server/src/symphony/linear.test.ts`: Linear helper tests.
- `apps/server/src/symphony/runModel.ts`: initialize lifecycle metadata on new runs and update queue helpers only where needed.
- `apps/server/src/symphony/runLifecycle.ts`: derive status from PR/Linear while delegating user-facing phase to `lifecyclePhase.ts`.
- `apps/server/src/symphony/Layers/SymphonyRepository.ts`: persist/decode lifecycle metadata.
- `apps/server/src/symphony/Services/SymphonyRepository.ts`: repository contract updates.
- `apps/server/src/symphony/Layers/SymphonyService.ts`: lifecycle controller integration.
- `apps/server/src/server.ts`: provide `GitManagerLive` to `SymphonyLayerLive`.
- `packages/contracts/src/git.ts`: optional PR base branch override for stacked actions.
- `packages/contracts/src/git.test.ts`: stacked-action base branch contract tests.
- `apps/server/src/git/Layers/GitManager.ts`: pass PR base branch override through PR creation.
- `apps/server/src/git/Layers/GitManager.test.ts`: PR base branch override behavior tests.
- `apps/server/src/git/Services/GitHubCli.ts`: PR feedback signal contract.
- `apps/server/src/git/Layers/GitHubCli.ts`: GitHub review/comment signal implementation.
- `apps/server/src/git/Layers/GitHubCli.test.ts`: GitHub feedback signal parsing tests.
- `apps/web/src/components/symphony/symphonyDisplay.ts`: phase display helpers.
- `apps/web/src/components/symphony/IssueQueueTable.tsx`: phase/status display.
- `apps/web/src/components/symphony/RunDetailsDrawer.tsx`: managed comment and gate details.
- `apps/web/src/components/Sidebar.logic.ts`: active phase logic.
- `apps/web/src/components/Sidebar.tsx`: sidebar phase display.
- Existing Symphony tests in `apps/server/src/symphony/*.test.ts`, `apps/server/src/symphony/Layers/*.test.ts`, and `apps/web/src/components/*.test.ts`.

## Task 1: Extend Contracts And Workflow Config

**Files:**

- Modify: `packages/contracts/src/symphony.ts`
- Modify: `packages/contracts/src/symphony.test.ts`
- Modify: `apps/server/src/symphony/workflow.ts`
- Modify: `apps/server/src/symphony/workflow.test.ts`

- [ ] **Step 1: Add failing contract tests for lifecycle config defaults**

In `packages/contracts/src/symphony.test.ts`, add:

```ts
it("decodes Symphony lifecycle workflow config with Linear control-plane defaults", () => {
  const config = Schema.decodeUnknownSync(SymphonyWorkflowConfig)({});

  expect(config.tracker.intakeStates).toEqual(["To Do", "Todo"]);
  expect(config.tracker.activeStates).toEqual(["In Progress"]);
  expect(config.tracker.reviewStates).toEqual(["In Review", "Review"]);
  expect(config.tracker.doneStates).toEqual(["Done", "Closed"]);
  expect(config.tracker.canceledStates).toEqual(["Canceled", "Cancelled"]);
  expect(config.tracker.transitionStates).toEqual({
    started: "In Progress",
    review: "In Review",
    done: "Done",
    canceled: "Canceled",
  });
  expect(config.pullRequest.baseBranch).toBe(null);
  expect(config.quality.maxReviewFixLoops).toBe(1);
  expect(config.quality.simplificationPrompt).toContain(
    "Simplify only the code changed for this issue.",
  );
  expect(config.quality.reviewPrompt).toContain("Review the current branch for correctness.");
});
```

- [ ] **Step 2: Run the failing contract test**

Run:

```bash
cd packages/contracts
bun run test src/symphony.test.ts
```

Expected: FAIL because `tracker.intakeStates`, `pullRequest`, and `quality` do not exist.

- [ ] **Step 3: Add lifecycle schemas to contracts**

In `packages/contracts/src/symphony.ts`, add these schemas near the existing Symphony workflow config schemas:

```ts
export const SymphonyLifecyclePhase = Schema.Literals([
  "intake",
  "planning",
  "implementing",
  "waiting-cloud",
  "simplifying",
  "reviewing",
  "fixing",
  "pr-ready",
  "in-review",
  "done",
  "canceled",
  "failed",
]);
export type SymphonyLifecyclePhase = typeof SymphonyLifecyclePhase.Type;

export const SymphonyLinearProgressComment = Schema.Struct({
  commentId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  commentUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  lastRenderedHash: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastUpdatedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  lastMilestoneAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastFeedbackAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SymphonyLinearProgressComment = typeof SymphonyLinearProgressComment.Type;

export const SymphonyQualityGateState = Schema.Struct({
  reviewFixLoops: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  lastReviewPassedAt: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastReviewSummary: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  lastReviewFindings: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SymphonyQualityGateState = typeof SymphonyQualityGateState.Type;

export const SymphonyPullRequestConfig = Schema.Struct({
  baseBranch: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type SymphonyPullRequestConfig = typeof SymphonyPullRequestConfig.Type;

export const SymphonyQualityConfig = Schema.Struct({
  maxReviewFixLoops: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  simplificationPrompt: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(
        "Simplify only the code changed for this issue. Preserve behavior and UI unless a fix is required.",
      ),
    ),
  ),
  reviewPrompt: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(
        "Review the current branch for correctness, regressions, and missing validation. Return REVIEW_PASS or REVIEW_FAIL with concrete findings.",
      ),
    ),
  ),
});
export type SymphonyQualityConfig = typeof SymphonyQualityConfig.Type;
```

Extend `SymphonyTrackerConfig`:

```ts
intakeStates: Schema.Array(TrimmedNonEmptyString).pipe(
  Schema.withDecodingDefault(Effect.succeed(["To Do", "Todo"])),
),
```

Change default `activeStates` to:

```ts
activeStates: Schema.Array(TrimmedNonEmptyString).pipe(
  Schema.withDecodingDefault(Effect.succeed(["In Progress"])),
),
```

Change the `transitionStates` decoding default to:

```ts
}).pipe(
  Schema.withDecodingDefault(
    Effect.succeed({
      started: "In Progress",
      review: "In Review",
      done: "Done",
      canceled: "Canceled",
    }),
  ),
),
```

Extend `SymphonyWorkflowConfig`:

```ts
pullRequest: SymphonyPullRequestConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
quality: SymphonyQualityConfig.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
```

Extend `SymphonyRun`:

```ts
lifecyclePhase: SymphonyLifecyclePhase.pipe(
  Schema.optionalKey,
  Schema.withDecodingDefault(Effect.succeed("intake" as const)),
),
linearProgress: SymphonyLinearProgressComment.pipe(
  Schema.optionalKey,
  Schema.withDecodingDefault(Effect.succeed({})),
),
qualityGate: SymphonyQualityGateState.pipe(
  Schema.optionalKey,
  Schema.withDecodingDefault(Effect.succeed({})),
),
```

- [ ] **Step 4: Run contract tests**

Run:

```bash
cd packages/contracts
bun run test src/symphony.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing workflow parser test**

In `apps/server/src/symphony/workflow.test.ts`, add:

```ts
it("parses lifecycle, PR, and quality settings from WORKFLOW.md", () => {
  const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: linear
  project_slug: battlecode
  intake_states:
    - To Do
  active_states:
    - In Progress
  review_states:
    - In Review
  done_states:
    - Done
  canceled_states:
    - Canceled
  transition_states:
    started: In Progress
    review: In Review
    done: Done
    canceled: Canceled
pull_request:
  base_branch: development
quality:
  max_review_fix_loops: 2
  simplification_prompt: Run a focused simplification pass.
  review_prompt: Run a focused review pass.
---

Work on {{ issue.identifier }}.
`);

  expect(workflow.config.tracker.intakeStates).toEqual(["To Do"]);
  expect(workflow.config.pullRequest.baseBranch).toBe("development");
  expect(workflow.config.quality.maxReviewFixLoops).toBe(2);
  expect(workflow.config.quality.simplificationPrompt).toBe("Run a focused simplification pass.");
  expect(workflow.config.quality.reviewPrompt).toBe("Run a focused review pass.");
});
```

- [ ] **Step 6: Run the failing workflow test**

Run:

```bash
cd apps/server
bun run test src/symphony/workflow.test.ts
```

Expected: FAIL until `SymphonyWorkflowConfig` is imported through the workspace build correctly and the starter template is updated.

- [ ] **Step 7: Update the starter workflow template**

In `apps/server/src/symphony/workflow.ts`, update `STARTER_WORKFLOW_TEMPLATE` so the front matter includes:

```yaml
tracker:
  kind: linear
  project_slug: ""
  intake_states:
    - To Do
  active_states:
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Canceled
  review_states:
    - In Review
  done_states:
    - Done
    - Closed
  canceled_states:
    - Canceled
  transition_states:
    started: In Progress
    review: In Review
    done: Done
    canceled: Canceled
pull_request:
  base_branch: development
quality:
  max_review_fix_loops: 1
  simplification_prompt: Simplify only the code changed for this issue. Preserve behavior and UI unless a fix is required.
  review_prompt: Review the current branch for correctness, regressions, and missing validation. Return REVIEW_PASS or REVIEW_FAIL with concrete findings.
```

Update the prompt body so it says Symphony owns Linear state and comments:

```md
Symphony owns Linear status updates and progress comments. Do not edit Linear directly unless Symphony explicitly asks you to report a phase result.
```

- [ ] **Step 8: Run contract and workflow tests**

Run:

```bash
cd packages/contracts
bun run test src/symphony.test.ts
cd ../../apps/server
bun run test src/symphony/workflow.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 1**

```bash
git add packages/contracts/src/symphony.ts packages/contracts/src/symphony.test.ts apps/server/src/symphony/workflow.ts apps/server/src/symphony/workflow.test.ts
git commit -m "feat(symphony): add workflow lifecycle config" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 2: Persist Lifecycle Metadata

**Files:**

- Create: `apps/server/src/persistence/Migrations/031_SymphonyLifecycleControlPlane.ts`
- Create: `apps/server/src/persistence/Migrations/031_SymphonyLifecycleControlPlane.test.ts`
- Modify: `apps/server/src/persistence/Migrations.ts`
- Modify: `apps/server/src/symphony/Services/SymphonyRepository.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyRepository.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyRepository.test.ts`
- Modify: `apps/server/src/symphony/runModel.ts`
- Modify: `apps/server/src/symphony/runModel.test.ts`

- [ ] **Step 1: Write failing migration test**

Create `apps/server/src/persistence/Migrations/031_SymphonyLifecycleControlPlane.test.ts`:

```ts
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, layer } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const testLayer = NodeSqliteClient.layer({ filename: ":memory:" }).pipe(
  layer.provide(NodeServices.layer),
);

layer(testLayer)("031_SymphonyLifecycleControlPlane", (it) => {
  it.effect("adds lifecycle metadata columns to symphony_runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 30 });
      let columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(symphony_runs)`;
      assert.equal(
        columns.some((column) => column.name === "lifecycle_phase"),
        false,
      );

      yield* runMigrations({ toMigrationInclusive: 31 });
      columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(symphony_runs)`;
      const names = columns.map((column) => column.name);

      assert.equal(names.includes("lifecycle_phase"), true);
      assert.equal(names.includes("linear_progress_json"), true);
      assert.equal(names.includes("quality_gate_json"), true);
    }),
  );
});
```

- [ ] **Step 2: Run the failing migration test**

Run:

```bash
cd apps/server
bun run test src/persistence/Migrations/031_SymphonyLifecycleControlPlane.test.ts
```

Expected: FAIL because migration 31 is not registered.

- [ ] **Step 3: Add migration 31**

Create `apps/server/src/persistence/Migrations/031_SymphonyLifecycleControlPlane.ts`:

```ts
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

function hasColumn(columns: readonly { readonly name: string }[], columnName: string): boolean {
  return columns.some((column) => column.name === columnName);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(symphony_runs)
  `;

  if (!hasColumn(runColumns, "lifecycle_phase")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN lifecycle_phase TEXT
    `;
  }

  if (!hasColumn(runColumns, "linear_progress_json")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN linear_progress_json TEXT
    `;
  }

  if (!hasColumn(runColumns, "quality_gate_json")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN quality_gate_json TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_runs_lifecycle_phase
    ON symphony_runs(project_id, lifecycle_phase, updated_at)
  `;
});
```

Register it in `apps/server/src/persistence/Migrations.ts`:

```ts
import Migration0031 from "./Migrations/031_SymphonyLifecycleControlPlane.ts";
```

Add to `MIGRATIONS`:

```ts
[31, "SymphonyLifecycleControlPlane", Migration0031],
```

- [ ] **Step 4: Run migration test**

Run:

```bash
cd apps/server
bun run test src/persistence/Migrations/031_SymphonyLifecycleControlPlane.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing repository round-trip test**

In `apps/server/src/symphony/Layers/SymphonyRepository.test.ts`, add:

```ts
it.effect("round-trips Symphony lifecycle metadata", () =>
  Effect.gen(function* () {
    const repository = yield* SymphonyRepository;
    yield* runMigrations();

    const run = makeRepositoryRun(PROJECT_ID, makeIssue("issue-lifecycle", "BC-31"), {
      status: "running",
      lifecyclePhase: "planning",
      linearProgress: {
        commentId: "comment-31",
        commentUrl: "https://linear.app/t3/issue/BC-31#comment-comment-31",
        lastRenderedHash: "hash-31",
        lastUpdatedAt: "2026-05-02T12:31:00.000Z",
        lastMilestoneAt: "2026-05-02T12:32:00.000Z",
        lastFeedbackAt: "2026-05-02T12:33:00.000Z",
      },
      qualityGate: {
        reviewFixLoops: 1,
        lastReviewPassedAt: null,
        lastReviewSummary: "Review failed",
        lastReviewFindings: ["Missing validation"],
      },
    });

    yield* repository.upsertRun(run);
    const stored = yield* repository.getRunByIssue({
      projectId: PROJECT_ID,
      issueId: run.issue.id,
    });

    assert.strictEqual(stored?.lifecyclePhase, "planning");
    assert.strictEqual(stored?.linearProgress.commentId, "comment-31");
    assert.deepStrictEqual(stored?.qualityGate.lastReviewFindings, ["Missing validation"]);
  }),
);
```

- [ ] **Step 6: Run the failing repository test**

Run:

```bash
cd apps/server
bun run test src/symphony/Layers/SymphonyRepository.test.ts
```

Expected: FAIL because repository rows do not select or persist the new fields.

- [ ] **Step 7: Update repository types and row decoding**

In `apps/server/src/symphony/Layers/SymphonyRepository.ts`, import:

```ts
SymphonyLifecyclePhase,
SymphonyLinearProgressComment,
SymphonyQualityGateState,
```

Add decoders:

```ts
const decodeLifecyclePhase = Schema.decodeUnknownSync(SymphonyLifecyclePhase);
const decodeLinearProgress = Schema.decodeUnknownSync(SymphonyLinearProgressComment);
const decodeQualityGate = Schema.decodeUnknownSync(SymphonyQualityGateState);
```

Extend `RunRow`:

```ts
readonly lifecyclePhase: string | null;
readonly linearProgress: string | null;
readonly qualityGate: string | null;
```

In `decodeRunRow`, decode the JSON fields:

```ts
const linearProgressJson =
  row.linearProgress === null
    ? {}
    : yield * decodeJson("SymphonyRepository.run.linearProgress", row.linearProgress);
const qualityGateJson =
  row.qualityGate === null
    ? {}
    : yield * decodeJson("SymphonyRepository.run.qualityGate", row.qualityGate);
const lifecyclePhase =
  row.lifecyclePhase === null
    ? "intake"
    : yield *
      decodeWith(
        "SymphonyRepository.run.lifecyclePhase.decode",
        decodeLifecyclePhase,
        row.lifecyclePhase,
      );
const linearProgress =
  yield *
  decodeWith(
    "SymphonyRepository.run.linearProgress.decode",
    decodeLinearProgress,
    linearProgressJson,
  );
const qualityGate =
  yield *
  decodeWith("SymphonyRepository.run.qualityGate.decode", decodeQualityGate, qualityGateJson);
```

Include these properties in the object passed to `decodeRun`:

```ts
lifecyclePhase,
linearProgress,
qualityGate,
```

Update every run `SELECT` to include:

```sql
lifecycle_phase AS "lifecyclePhase",
linear_progress_json AS "linearProgress",
quality_gate_json AS "qualityGate",
```

Update `upsertRun` insert columns and values:

```sql
lifecycle_phase,
linear_progress_json,
quality_gate_json,
```

```ts
${run.lifecyclePhase},
${JSON.stringify(run.linearProgress)},
${JSON.stringify(run.qualityGate)},
```

Update conflict assignment:

```sql
lifecycle_phase = excluded.lifecycle_phase,
linear_progress_json = excluded.linear_progress_json,
quality_gate_json = excluded.quality_gate_json,
```

- [ ] **Step 8: Initialize new run metadata**

In `apps/server/src/symphony/runModel.ts`, update `makeRun`:

```ts
lifecyclePhase: "intake",
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
```

- [ ] **Step 9: Run repository and run model tests**

Run:

```bash
cd apps/server
bun run test src/symphony/Layers/SymphonyRepository.test.ts src/symphony/runModel.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```bash
git add apps/server/src/persistence/Migrations.ts apps/server/src/persistence/Migrations/031_SymphonyLifecycleControlPlane.ts apps/server/src/persistence/Migrations/031_SymphonyLifecycleControlPlane.test.ts apps/server/src/symphony/Services/SymphonyRepository.ts apps/server/src/symphony/Layers/SymphonyRepository.ts apps/server/src/symphony/Layers/SymphonyRepository.test.ts apps/server/src/symphony/runModel.ts apps/server/src/symphony/runModel.test.ts
git commit -m "feat(symphony): persist lifecycle metadata" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 3: Add Linear Managed Comment Helpers

**Files:**

- Modify: `apps/server/src/symphony/linear.ts`
- Modify: `apps/server/src/symphony/linear.test.ts`
- Create: `apps/server/src/symphony/progressComment.ts`
- Create: `apps/server/src/symphony/progressComment.test.ts`

- [ ] **Step 1: Write failing Linear helper tests**

In `apps/server/src/symphony/linear.test.ts`, add tests for comment update and comment listing:

```ts
it("updates a Linear comment body", async () => {
  const requests: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          data: {
            commentUpdate: {
              success: true,
              comment: {
                id: "comment-1",
                url: "https://linear.app/t3/issue/APP-1#comment-comment-1",
              },
            },
          },
        }),
        { status: 200 },
      );
    }),
  );

  const result = await Effect.runPromise(
    updateLinearComment({
      endpoint: "https://linear.example/graphql",
      apiKey: "linear-key",
      commentId: "comment-1",
      body: "Updated body",
    }),
  );

  expect(result.id).toBe("comment-1");
  expect(result.url).toBe("https://linear.app/t3/issue/APP-1#comment-comment-1");
  expect(JSON.stringify(requests[0])).toContain("commentUpdate");
  expect(JSON.stringify(requests[0])).toContain("Updated body");
});

it("lists Linear comments for feedback detection", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              issue: {
                comments: {
                  nodes: [
                    {
                      id: "comment-user",
                      url: "https://linear.app/t3/issue/APP-1#comment-comment-user",
                      body: "Please tighten validation.",
                      createdAt: "2026-05-02T12:40:00.000Z",
                      updatedAt: "2026-05-02T12:40:00.000Z",
                      user: { id: "user-1", name: "Cal", displayName: "Cal" },
                    },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        ),
    ),
  );

  const comments = await Effect.runPromise(
    fetchLinearIssueComments({
      endpoint: "https://linear.example/graphql",
      apiKey: "linear-key",
      issueId: "issue-1",
    }),
  );

  expect(comments).toEqual([
    {
      id: "comment-user",
      url: "https://linear.app/t3/issue/APP-1#comment-comment-user",
      body: "Please tighten validation.",
      createdAt: "2026-05-02T12:40:00.000Z",
      updatedAt: "2026-05-02T12:40:00.000Z",
      userName: "Cal",
    },
  ]);
});
```

- [ ] **Step 2: Run failing Linear tests**

Run:

```bash
cd apps/server
bun run test src/symphony/linear.test.ts
```

Expected: FAIL because `updateLinearComment` and `fetchLinearIssueComments` do not exist.

- [ ] **Step 3: Add Linear comment update/list APIs**

In `apps/server/src/symphony/linear.ts`, add:

```ts
const LINEAR_UPDATE_COMMENT_MUTATION = `
mutation SymphonyUpdateComment($commentId: String!, $body: String!) {
  commentUpdate(id: $commentId, input: { body: $body }) {
    success
    comment {
      id
      url
      updatedAt
    }
  }
}
`;
```

Extend `LINEAR_ISSUE_COMMENTS_QUERY` nodes with `updatedAt` if it is missing.

Add exported interfaces:

```ts
export interface LinearIssueComment {
  readonly id: string;
  readonly url: string | null;
  readonly body: string;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly userName: string | null;
}
```

Add helpers:

```ts
function normalizeLinearIssueComment(value: unknown): LinearIssueComment | null {
  const comment = readRecord(value);
  if (!comment) return null;
  const id = readString(comment.id);
  const body = readString(comment.body);
  if (!id || body === null) return null;
  const user = readRecord(comment.user);
  return {
    id,
    url: readString(comment.url),
    body,
    createdAt: readString(comment.createdAt),
    updatedAt: readString(comment.updatedAt),
    userName: user ? (readString(user.displayName) ?? readString(user.name)) : null,
  };
}

export function updateLinearComment(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly commentId: string;
  readonly body: string;
}): Effect.Effect<LinearCommentResult, SymphonyError> {
  return linearGraphql({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    query: LINEAR_UPDATE_COMMENT_MUTATION,
    variables: {
      commentId: input.commentId,
      body: input.body,
    },
  }).pipe(
    Effect.flatMap((body) =>
      Effect.try({
        try: () => {
          const data = readNestedRecord(body, "data");
          const commentUpdate = data ? readNestedRecord(data, "commentUpdate") : null;
          if (commentUpdate?.success !== true) {
            throw new Error("Linear did not update the Symphony progress comment.");
          }
          const comment = readRecord(commentUpdate.comment);
          const id = comment ? readString(comment.id) : null;
          if (!id) {
            throw new Error("Linear comment update response did not include a comment id.");
          }
          return {
            id,
            url: comment ? readString(comment.url) : null,
          };
        },
        catch: (cause) =>
          new SymphonyError({
            message:
              cause instanceof Error
                ? cause.message
                : "Failed to parse Linear comment update response.",
            cause,
          }),
      }),
    ),
  );
}

export function fetchLinearIssueComments(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly issueId: string;
}): Effect.Effect<readonly LinearIssueComment[], SymphonyError> {
  return linearGraphql({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    query: LINEAR_ISSUE_COMMENTS_QUERY,
    variables: {
      issueId: input.issueId,
    },
  }).pipe(
    Effect.map((body) => {
      const data = readNestedRecord(body, "data");
      const issue = data ? readNestedRecord(data, "issue") : null;
      const comments = issue ? readNestedRecord(issue, "comments") : null;
      const nodes = comments ? readArray(comments.nodes) : [];
      return nodes.flatMap((node) => {
        const normalized = normalizeLinearIssueComment(node);
        return normalized ? [normalized] : [];
      });
    }),
  );
}
```

- [ ] **Step 4: Run Linear tests**

Run:

```bash
cd apps/server
bun run test src/symphony/linear.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing progress comment renderer tests**

Create `apps/server/src/symphony/progressComment.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ProjectId, SymphonyIssueId } from "@t3tools/contracts";

import { makeRun } from "./runModel.ts";
import { renderManagedProgressComment, renderMilestoneComment } from "./progressComment.ts";

const run = makeRun(
  ProjectId.make("project-1"),
  {
    id: SymphonyIssueId.make("issue-1"),
    identifier: "APP-1",
    title: "Fix upload flow",
    description: "Uploads fail.",
    priority: null,
    state: "In Progress",
    branchName: null,
    url: "https://linear.app/t3/issue/APP-1",
    labels: [],
    blockedBy: [],
    createdAt: "2026-05-02T12:00:00.000Z",
    updatedAt: "2026-05-02T12:00:00.000Z",
  },
  "2026-05-02T12:00:00.000Z",
);

describe("progressComment", () => {
  it("renders a managed Symphony progress comment with checklist and PR", () => {
    const body = renderManagedProgressComment({
      run: {
        ...run,
        lifecyclePhase: "implementing",
        executionTarget: "local",
        prUrl: "https://github.com/t3/battlecode/pull/10",
      },
      planMarkdown: "- [x] Inspect code\n- [ ] Implement fix",
      statusLine: "Implementation running",
      lastUpdate: "2026-05-02T12:20:00.000Z",
    });

    expect(body).toContain("<!-- symphony-managed-progress");
    expect(body).toContain("Status: Implementing");
    expect(body).toContain("Execution: Local");
    expect(body).toContain("PR: https://github.com/t3/battlecode/pull/10");
    expect(body).toContain("- [x] Inspect code");
  });

  it("renders short milestone comments", () => {
    expect(
      renderMilestoneComment({
        issueIdentifier: "APP-1",
        milestone: "PR opened",
        detail: "https://github.com/t3/battlecode/pull/10",
      }),
    ).toBe("Symphony milestone for APP-1: PR opened\n\nhttps://github.com/t3/battlecode/pull/10");
  });
});
```

- [ ] **Step 6: Run failing progress comment tests**

Run:

```bash
cd apps/server
bun run test src/symphony/progressComment.test.ts
```

Expected: FAIL because `progressComment.ts` does not exist.

- [ ] **Step 7: Implement progress comment renderer**

Create `apps/server/src/symphony/progressComment.ts`:

```ts
import type {
  SymphonyExecutionTarget,
  SymphonyLifecyclePhase,
  SymphonyRun,
} from "@t3tools/contracts";

const MANAGED_COMMENT_MARKER = "<!-- symphony-managed-progress v1 -->";

const PHASE_LABEL: Record<SymphonyLifecyclePhase, string> = {
  intake: "Intake",
  planning: "Planning",
  implementing: "Implementing",
  "waiting-cloud": "Waiting for cloud signal",
  simplifying: "Simplifying",
  reviewing: "Reviewing",
  fixing: "Fixing",
  "pr-ready": "PR Ready",
  "in-review": "In Review",
  done: "Done",
  canceled: "Canceled",
  failed: "Failed",
};

const TARGET_LABEL: Record<SymphonyExecutionTarget, string> = {
  local: "Local",
  "codex-cloud": "Codex Cloud",
};

export function renderManagedProgressComment(input: {
  readonly run: SymphonyRun;
  readonly planMarkdown: string;
  readonly statusLine: string;
  readonly lastUpdate: string;
}): string {
  const execution = input.run.executionTarget
    ? TARGET_LABEL[input.run.executionTarget]
    : "Not selected";
  const pr = input.run.pullRequest?.url ?? input.run.prUrl ?? "pending";
  const phase = PHASE_LABEL[input.run.lifecyclePhase];
  const currentStep = input.run.currentStep?.label ?? input.statusLine;
  const reviewFindings = input.run.qualityGate.lastReviewFindings;
  const reviewSection =
    reviewFindings.length > 0
      ? ["", "## Review Findings", ...reviewFindings.map((finding) => `- ${finding}`)].join("\n")
      : "";

  return [
    MANAGED_COMMENT_MARKER,
    "# Symphony Progress",
    "",
    `Status: ${phase}`,
    `Last update: ${input.lastUpdate}`,
    `Execution: ${execution}`,
    `Current step: ${currentStep}`,
    `PR: ${pr}`,
    "",
    "## Plan",
    input.planMarkdown.trim() || "- [ ] Plan not captured yet",
    reviewSection,
  ].join("\n");
}

export function renderMilestoneComment(input: {
  readonly issueIdentifier: string;
  readonly milestone: string;
  readonly detail?: string | null;
}): string {
  const header = `Symphony milestone for ${input.issueIdentifier}: ${input.milestone}`;
  const detail = input.detail?.trim();
  return detail ? `${header}\n\n${detail}` : header;
}
```

- [ ] **Step 8: Run progress comment tests**

Run:

```bash
cd apps/server
bun run test src/symphony/progressComment.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 3**

```bash
git add apps/server/src/symphony/linear.ts apps/server/src/symphony/linear.test.ts apps/server/src/symphony/progressComment.ts apps/server/src/symphony/progressComment.test.ts
git commit -m "feat(symphony): manage Linear progress comments" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 4: Add Phase Helpers And Prompts

**Files:**

- Create: `apps/server/src/symphony/lifecyclePhase.ts`
- Create: `apps/server/src/symphony/lifecyclePhase.test.ts`
- Create: `apps/server/src/symphony/phasePrompts.ts`
- Create: `apps/server/src/symphony/phasePrompts.test.ts`
- Create: `apps/server/src/symphony/phaseOutput.ts`
- Create: `apps/server/src/symphony/phaseOutput.test.ts`

- [ ] **Step 1: Write failing lifecycle phase tests**

Create `apps/server/src/symphony/lifecyclePhase.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  lifecyclePhaseIsActive,
  lifecyclePhaseLabel,
  nextPhaseAfterReview,
} from "./lifecyclePhase.ts";

describe("lifecyclePhase", () => {
  it("labels visible phases", () => {
    expect(lifecyclePhaseLabel("planning")).toBe("Planning");
    expect(lifecyclePhaseLabel("waiting-cloud")).toBe("Waiting for cloud signal");
    expect(lifecyclePhaseLabel("in-review")).toBe("In Review");
  });

  it("treats work phases as active", () => {
    expect(lifecyclePhaseIsActive("planning")).toBe(true);
    expect(lifecyclePhaseIsActive("implementing")).toBe(true);
    expect(lifecyclePhaseIsActive("in-review")).toBe(false);
    expect(lifecyclePhaseIsActive("done")).toBe(false);
  });

  it("routes review failures through fixing until the configured loop is exhausted", () => {
    expect(nextPhaseAfterReview({ passed: true, fixLoops: 0, maxFixLoops: 1 })).toBe("pr-ready");
    expect(nextPhaseAfterReview({ passed: false, fixLoops: 0, maxFixLoops: 1 })).toBe("fixing");
    expect(nextPhaseAfterReview({ passed: false, fixLoops: 1, maxFixLoops: 1 })).toBe("failed");
  });
});
```

- [ ] **Step 2: Implement lifecycle phase helpers**

Create `apps/server/src/symphony/lifecyclePhase.ts`:

```ts
import type { SymphonyLifecyclePhase } from "@t3tools/contracts";

const PHASE_LABELS: Record<SymphonyLifecyclePhase, string> = {
  intake: "Intake",
  planning: "Planning",
  implementing: "Implementing",
  "waiting-cloud": "Waiting for cloud signal",
  simplifying: "Simplifying",
  reviewing: "Reviewing",
  fixing: "Fixing",
  "pr-ready": "PR Ready",
  "in-review": "In Review",
  done: "Done",
  canceled: "Canceled",
  failed: "Failed",
};

const ACTIVE_PHASES = new Set<SymphonyLifecyclePhase>([
  "intake",
  "planning",
  "implementing",
  "waiting-cloud",
  "simplifying",
  "reviewing",
  "fixing",
  "pr-ready",
]);

export function lifecyclePhaseLabel(phase: SymphonyLifecyclePhase): string {
  return PHASE_LABELS[phase];
}

export function lifecyclePhaseIsActive(phase: SymphonyLifecyclePhase): boolean {
  return ACTIVE_PHASES.has(phase);
}

export function nextPhaseAfterReview(input: {
  readonly passed: boolean;
  readonly fixLoops: number;
  readonly maxFixLoops: number;
}): SymphonyLifecyclePhase {
  if (input.passed) return "pr-ready";
  return input.fixLoops < input.maxFixLoops ? "fixing" : "failed";
}
```

- [ ] **Step 3: Run lifecycle phase tests**

Run:

```bash
cd apps/server
bun run test src/symphony/lifecyclePhase.test.ts
```

Expected: PASS.

- [ ] **Step 4: Write failing prompt tests**

Create `apps/server/src/symphony/phasePrompts.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildFixPrompt,
  buildImplementationPrompt,
  buildPlanningPrompt,
  buildReviewPrompt,
  buildSimplificationPrompt,
} from "./phasePrompts.ts";

describe("phasePrompts", () => {
  it("builds a planning prompt that asks for a checklist only", () => {
    const prompt = buildPlanningPrompt({
      issueIdentifier: "APP-1",
      issueTitle: "Fix upload flow",
      issueDescription: "Uploads fail.",
      workflowPrompt: "Repo rules.",
    });

    expect(prompt).toContain("Create a comprehensive implementation plan");
    expect(prompt).toContain("- [ ]");
    expect(prompt).toContain("Do not write code in this phase.");
    expect(prompt).toContain("Repo rules.");
  });

  it("builds gate prompts with phase-specific instructions", () => {
    expect(
      buildImplementationPrompt({
        planMarkdown: "- [ ] Fix upload",
        workflowPrompt: "Repo rules.",
      }),
    ).toContain("Implement the approved plan");
    expect(buildSimplificationPrompt({ simplificationPrompt: "Simplify scoped changes." })).toBe(
      "Simplify scoped changes.",
    );
    expect(buildReviewPrompt({ reviewPrompt: "Review scoped changes." })).toContain("REVIEW_PASS");
    expect(buildFixPrompt({ findings: ["Missing test"], workflowPrompt: "Repo rules." })).toContain(
      "Missing test",
    );
  });
});
```

- [ ] **Step 5: Implement phase prompt builders**

Create `apps/server/src/symphony/phasePrompts.ts`:

```ts
export function buildPlanningPrompt(input: {
  readonly issueIdentifier: string;
  readonly issueTitle: string;
  readonly issueDescription: string | null;
  readonly workflowPrompt: string;
}): string {
  return [
    `Create a comprehensive implementation plan for ${input.issueIdentifier}: ${input.issueTitle}.`,
    "",
    "Do not write code in this phase.",
    "Return the plan as Markdown checklist items using '- [ ]'.",
    "Include validation steps and files likely to change.",
    "",
    "Issue description:",
    input.issueDescription?.trim() || "(no Linear description)",
    "",
    "Workflow instructions:",
    input.workflowPrompt.trim(),
  ].join("\n");
}

export function buildImplementationPrompt(input: {
  readonly planMarkdown: string;
  readonly workflowPrompt: string;
}): string {
  return [
    "Implement the approved plan.",
    "Keep Linear updates to Symphony; report implementation completion in this thread.",
    "",
    "Plan:",
    input.planMarkdown.trim(),
    "",
    "Workflow instructions:",
    input.workflowPrompt.trim(),
  ].join("\n");
}

export function buildSimplificationPrompt(input: {
  readonly simplificationPrompt: string;
}): string {
  return input.simplificationPrompt.trim();
}

export function buildReviewPrompt(input: { readonly reviewPrompt: string }): string {
  return [
    input.reviewPrompt.trim(),
    "",
    "End with exactly one marker line:",
    "REVIEW_PASS: <short summary>",
    "or",
    "REVIEW_FAIL: <one or more concrete findings>",
  ].join("\n");
}

export function buildFixPrompt(input: {
  readonly findings: readonly string[];
  readonly workflowPrompt: string;
}): string {
  return [
    "Fix the review findings below, then stop after reporting what changed.",
    "",
    ...input.findings.map((finding) => `- ${finding}`),
    "",
    "Workflow instructions:",
    input.workflowPrompt.trim(),
  ].join("\n");
}
```

- [ ] **Step 6: Run prompt tests**

Run:

```bash
cd apps/server
bun run test src/symphony/phasePrompts.test.ts
```

Expected: PASS.

- [ ] **Step 7: Write failing output extraction tests**

Create `apps/server/src/symphony/phaseOutput.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { OrchestrationThread } from "@t3tools/contracts";

import { extractLatestPlanMarkdown, extractReviewOutcome } from "./phaseOutput.ts";

const baseThread = {
  proposedPlans: [],
  messages: [],
} as unknown as OrchestrationThread;

describe("phaseOutput", () => {
  it("uses the latest proposed plan before assistant text fallback", () => {
    expect(
      extractLatestPlanMarkdown({
        ...baseThread,
        proposedPlans: [
          {
            id: "plan-1",
            turnId: null,
            planMarkdown: "- [ ] Inspect\n- [ ] Fix",
            implementedAt: null,
            implementationThreadId: null,
            createdAt: "2026-05-02T12:00:00.000Z",
            updatedAt: "2026-05-02T12:01:00.000Z",
          },
        ],
      } as OrchestrationThread),
    ).toBe("- [ ] Inspect\n- [ ] Fix");
  });

  it("parses review pass and fail markers", () => {
    expect(extractReviewOutcome("Looks good.\nREVIEW_PASS: validation passes")).toEqual({
      passed: true,
      summary: "validation passes",
      findings: [],
    });
    expect(extractReviewOutcome("Problems.\nREVIEW_FAIL: Missing test\n- Handle cancel")).toEqual({
      passed: false,
      summary: "Missing test",
      findings: ["Missing test", "Handle cancel"],
    });
  });
});
```

- [ ] **Step 8: Implement output extraction**

Create `apps/server/src/symphony/phaseOutput.ts`:

```ts
import type { OrchestrationThread } from "@t3tools/contracts";

export interface ReviewOutcome {
  readonly passed: boolean;
  readonly summary: string;
  readonly findings: readonly string[];
}

export function extractLatestPlanMarkdown(thread: OrchestrationThread): string | null {
  const latestPlan = thread.proposedPlans.toSorted((left, right) => {
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  })[0];
  if (latestPlan?.planMarkdown.trim()) {
    return latestPlan.planMarkdown.trim();
  }

  const assistantMessage = thread.messages
    .filter((message) => message.role === "assistant" && !message.streaming)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  const text = assistantMessage?.text.trim() ?? "";
  return text.includes("- [ ]") || text.includes("- [x]") ? text : null;
}

export function extractReviewOutcome(text: string): ReviewOutcome | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const pass = lines.find((line) => line.startsWith("REVIEW_PASS:"));
  if (pass) {
    return {
      passed: true,
      summary: pass.slice("REVIEW_PASS:".length).trim() || "Review passed",
      findings: [],
    };
  }
  const failIndex = lines.findIndex((line) => line.startsWith("REVIEW_FAIL:"));
  if (failIndex >= 0) {
    const first = lines[failIndex]?.slice("REVIEW_FAIL:".length).trim() || "Review failed";
    const rest = lines
      .slice(failIndex + 1)
      .map((line) => line.replace(/^[-*]\s*/, "").trim())
      .filter((line) => line.length > 0);
    return {
      passed: false,
      summary: first,
      findings: [first, ...rest],
    };
  }
  return null;
}
```

- [ ] **Step 9: Run helper tests**

Run:

```bash
cd apps/server
bun run test src/symphony/lifecyclePhase.test.ts src/symphony/phasePrompts.test.ts src/symphony/phaseOutput.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 4**

```bash
git add apps/server/src/symphony/lifecyclePhase.ts apps/server/src/symphony/lifecyclePhase.test.ts apps/server/src/symphony/phasePrompts.ts apps/server/src/symphony/phasePrompts.test.ts apps/server/src/symphony/phaseOutput.ts apps/server/src/symphony/phaseOutput.test.ts
git commit -m "feat(symphony): add lifecycle phase helpers" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 5: Implement To Do Intake, Planning, And Managed Comment Updates

**Files:**

- Modify: `apps/server/src/symphony/linear.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`
- Modify: `apps/server/src/symphony/runLifecycle.ts`
- Modify: `apps/server/src/symphony/runModel.ts`

- [ ] **Step 1: Write failing service test for To Do intake**

In `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`, extend `linearMocks` with:

```ts
updateLinearComment: vi.fn(),
fetchLinearIssueComments: vi.fn(),
```

Update the `vi.mock("../linear.ts")` return with these mocks.

Add test:

```ts
it.effect("plans To Do issues, posts managed progress, and moves Linear to In Progress", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;
    const plannedThread = makeThread({
      latestTurn: {
        turnId: "turn-plan" as never,
        state: "completed",
        requestedAt: CREATED_AT,
        startedAt: CREATED_AT,
        completedAt: "2026-05-02T12:05:00.000Z",
        assistantMessageId: null,
      },
      proposedPlans: [
        {
          id: "plan-1",
          turnId: "turn-plan" as never,
          planMarkdown: "- [ ] Inspect implementation\n- [ ] Add tests\n- [ ] Implement fix",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: CREATED_AT,
          updatedAt: "2026-05-02T12:05:00.000Z",
        },
      ],
    });
    orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [plannedThread] });
    linearMocks.fetchLinearCandidates.mockReturnValue(
      Effect.succeed([makeIssue({ state: "To Do" })]),
    );
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(
      Effect.succeed([makeLinearContext("To Do", { state: "To Do" })]),
    );
    linearMocks.createLinearComment.mockReturnValue(
      Effect.succeed({
        id: "comment-progress",
        url: "https://linear.app/t3/issue/BC-1#comment-comment-progress",
      }),
    );
    linearMocks.updateLinearIssueState.mockReturnValue(
      Effect.succeed({
        changed: true,
        stateId: "state-in-progress",
        stateName: "In Progress",
      }),
    );

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;

    yield* service.refresh({ projectId: PROJECT_ID });

    const run = yield* repository.getRunByIssue({
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
    });
    assert.strictEqual(run?.lifecyclePhase, "implementing");
    assert.strictEqual(run?.linearProgress.commentId, "comment-progress");
    assert.ok(
      linearMocks.createLinearComment.mock.calls.some((call) =>
        String(call[0].body).includes("Symphony Progress"),
      ),
    );
    assert.ok(linearMocks.updateLinearIssueState.mock.calls.length > 0);
  }),
);
```

- [ ] **Step 2: Run failing service test**

Run:

```bash
cd apps/server
bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Expected: FAIL because intake planning and managed progress comments are not wired.

- [ ] **Step 3: Fetch intake and active states from Linear**

In `apps/server/src/symphony/linear.ts`, update `fetchLinearCandidates` variables:

```ts
const candidateStates = [
  ...new Set([...input.config.tracker.intakeStates, ...input.config.tracker.activeStates]),
];
```

Pass `candidateStates` instead of `input.config.tracker.activeStates`:

```ts
states: candidateStates,
```

- [ ] **Step 4: Add managed comment upsert helper in SymphonyService**

In `apps/server/src/symphony/Layers/SymphonyService.ts`, import:

```ts
import { GitManager } from "../../git/Services/GitManager.ts";
import { updateLinearComment, fetchLinearIssueComments } from "../linear.ts";
import { renderManagedProgressComment, renderMilestoneComment } from "../progressComment.ts";
import { buildPlanningPrompt, buildImplementationPrompt } from "../phasePrompts.ts";
import { extractLatestPlanMarkdown } from "../phaseOutput.ts";
```

Inside `makeSymphonyService`, acquire `GitManager`:

```ts
const gitManager = yield * GitManager;
```

Add helper:

```ts
const updateManagedProgressComment = (input: {
  readonly projectId: ProjectId;
  readonly workflow: { readonly config: SymphonyWorkflowConfig };
  readonly run: SymphonyRun;
  readonly planMarkdown: string;
  readonly statusLine: string;
  readonly milestone?: string | null;
}): Effect.Effect<SymphonyRun, never> =>
  Effect.gen(function* () {
    const apiKey = yield* readLinearApiKey(input.projectId);
    if (!apiKey) return input.run;
    const now = nowIso();
    const body = renderManagedProgressComment({
      run: input.run,
      planMarkdown: input.planMarkdown,
      statusLine: input.statusLine,
      lastUpdate: now,
    });
    const endpoint = input.workflow.config.tracker.endpoint || DEFAULT_LINEAR_ENDPOINT;
    const comment =
      input.run.linearProgress.commentId !== null
        ? yield* updateLinearComment({
            endpoint,
            apiKey,
            commentId: input.run.linearProgress.commentId,
            body,
          })
        : yield* createLinearComment({
            endpoint,
            apiKey,
            issueId: input.run.issue.id,
            body,
          });
    if (input.milestone) {
      yield* createLinearComment({
        endpoint,
        apiKey,
        issueId: input.run.issue.id,
        body: renderMilestoneComment({
          issueIdentifier: input.run.issue.identifier,
          milestone: input.milestone,
        }),
      });
    }
    const nextRun: SymphonyRun = {
      ...input.run,
      linearProgress: {
        ...input.run.linearProgress,
        commentId: comment.id,
        commentUrl: comment.url,
        lastRenderedHash: hashWorkflow(body),
        lastUpdatedAt: now,
        lastMilestoneAt: input.milestone ? now : input.run.linearProgress.lastMilestoneAt,
      },
      updatedAt: now,
    };
    yield* repository
      .upsertRun(nextRun)
      .pipe(Effect.mapError(toSymphonyError("Failed to persist Symphony progress comment.")));
    return nextRun;
  }).pipe(
    Effect.catchAll((error) =>
      emitProjectEvent({
        projectId: input.projectId,
        issueId: input.run.issue.id,
        runId: input.run.runId,
        type: "linear.progress-warning",
        message: `Linear progress comment update failed: ${error.message}`,
      }).pipe(Effect.as(input.run), Effect.ignoreCause({ log: true })),
    ),
  );
```

- [ ] **Step 5: Add planning launch helper**

In `apps/server/src/symphony/Layers/SymphonyService.ts`, add:

```ts
const startPlanningTurn = (input: {
  readonly projectId: ProjectId;
  readonly workflow: { readonly config: SymphonyWorkflowConfig; readonly promptTemplate: string };
  readonly run: SymphonyRun;
  readonly workspacePath: string;
  readonly branchName: string;
}): Effect.Effect<SymphonyRun, SymphonyError> =>
  Effect.gen(function* () {
    const startedAt = nowIso();
    const runThreadId = input.run.threadId ?? threadId(input.projectId, input.run.issue.id);
    const nextRun: SymphonyRun = {
      ...input.run,
      lifecyclePhase: "planning",
      status: "running",
      executionTarget: "local",
      workspacePath: input.workspacePath,
      branchName: input.branchName,
      threadId: runThreadId,
      updatedAt: startedAt,
    };
    yield* repository
      .upsertRun(nextRun)
      .pipe(Effect.mapError(toSymphonyError("Failed to mark Symphony run as planning.")));
    yield* ensureLocalSymphonyThreadFullAccess({
      projectId: input.projectId,
      run: nextRun,
      threadId: runThreadId,
      branchName: input.branchName,
      workspacePath: input.workspacePath,
    });
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: commandId("planning-turn-start"),
        threadId: runThreadId,
        message: {
          messageId: messageId(),
          role: "user",
          text: buildPlanningPrompt({
            issueIdentifier: input.run.issue.identifier,
            issueTitle: input.run.issue.title,
            issueDescription: input.run.issue.description,
            workflowPrompt: input.workflow.promptTemplate,
          }),
          attachments: [],
        },
        modelSelection: defaultSymphonyLocalModelSelection(),
        titleSeed: `Symphony ${input.run.issue.identifier} plan`,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: startedAt,
      })
      .pipe(Effect.mapError(toSymphonyError("Failed to launch Symphony planning turn.")));
    return nextRun;
  });
```

- [ ] **Step 6: Complete planning before implementation**

In `reconcileRunWithThread`, before the existing completed local-turn continuation branch, add a phase-specific completed planning branch:

```ts
if (run.lifecyclePhase === "planning" && latestTurn.state === "completed") {
  const planMarkdown = extractLatestPlanMarkdown(thread);
  if (!planMarkdown) {
    const failedRun: SymphonyRun = {
      ...run,
      lifecyclePhase: "failed",
      status: "failed",
      lastError: "Planning completed without a checklist plan.",
      updatedAt: completedAt,
    };
    yield *
      repository
        .upsertRun(failedRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to mark planning as failed.")));
    return;
  }

  const plannedRun: SymphonyRun = {
    ...run,
    lifecyclePhase: "implementing",
    currentStep: {
      source: "symphony",
      label: "Planning complete",
      detail: planMarkdown,
      updatedAt: completedAt,
    },
    updatedAt: completedAt,
  };
  const withProgress =
    yield *
    updateManagedProgressComment({
      projectId: run.projectId,
      workflow: input.workflow,
      run: plannedRun,
      planMarkdown,
      statusLine: "Planning complete; implementation starting",
      milestone: "Plan posted; moving to In Progress",
    });
  yield *
    transitionLinearRunState({
      projectId: run.projectId,
      workflow: input.workflow,
      run: withProgress,
      stateName: input.workflow.config.tracker.transitionStates.started,
      reason: "plan-posted",
    });
  yield *
    startLocalContinuationTurn({
      projectId: run.projectId,
      workflow: input.workflow,
      run: withProgress,
      prompt: buildImplementationPrompt({
        planMarkdown,
        workflowPrompt: input.workflow.promptTemplate,
      }),
    });
  return;
}
```

Update `startLocalContinuationTurn` to accept an optional prompt:

```ts
readonly prompt?: string;
```

Use:

```ts
text: input.prompt ?? buildContinuationPrompt({
  turnNumber: attemptNumber,
  maxTurns: input.workflow.config.agent.maxTurns,
}),
```

- [ ] **Step 7: Start planning for To Do candidates**

In `launchQueuedRuns`, candidates should include local runs where `lifecyclePhase === "intake"` and `issue.state` matches `tracker.intakeStates`. For those candidates, call `prepareRunWorkspace`, then `startPlanningTurn` instead of `launchLocalRun`.

Add a helper in `SymphonyService.ts`:

```ts
function stateMatches(states: readonly string[], stateName: string): boolean {
  return states.some(
    (state) => state.trim().toLocaleLowerCase() === stateName.trim().toLocaleLowerCase(),
  );
}
```

Inside the `Effect.forEach(candidates, ...)` callback:

```ts
if (
  run.lifecyclePhase === "intake" &&
  stateMatches(workflow.config.tracker.intakeStates, run.issue.state)
) {
  const prepared =
    yield *
    prepareRunWorkspace({
      projectRoot: project.workspaceRoot,
      workflow,
      run,
    });
  yield *
    startPlanningTurn({
      projectId,
      workflow,
      run,
      workspacePath: prepared.workspacePath,
      branchName: prepared.branchName,
    });
  return;
}
```

- [ ] **Step 8: Run service lifecycle tests**

Run:

```bash
cd apps/server
bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add apps/server/src/symphony/linear.ts apps/server/src/symphony/Layers/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts apps/server/src/symphony/runLifecycle.ts apps/server/src/symphony/runModel.ts
git commit -m "feat(symphony): plan To Do issues through Linear" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 6: Add Simplification, Review, And Fix Phase Loop

**Files:**

- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`
- Modify: `apps/server/src/symphony/phaseOutput.ts`
- Modify: `apps/server/src/symphony/phaseOutput.test.ts`

- [ ] **Step 1: Add failing service tests for gate sequence**

In `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`, add a test that seeds a run in `implementing` with a completed thread turn and expects the next dispatched turn to contain the simplification prompt:

```ts
it.effect("runs simplification after implementation completes", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;
    const thread = makeThread({
      worktreePath: projectRoot,
      latestTurn: {
        turnId: "turn-impl" as never,
        state: "completed",
        requestedAt: CREATED_AT,
        startedAt: CREATED_AT,
        completedAt: "2026-05-02T12:10:00.000Z",
        assistantMessageId: null,
      },
    });
    orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(
      Effect.succeed([makeLinearContext("In Progress")]),
    );

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;
    yield* repository.upsertRun(
      makeServiceRun({
        status: "running",
        lifecyclePhase: "implementing",
        executionTarget: "local",
        workspacePath: projectRoot,
        branchName: "symphony/bc-1",
        threadId: thread.id,
      }),
    );

    yield* service.refresh({ projectId: PROJECT_ID });

    const nextTurn = orchestrationState.dispatchedCommands.findLast(
      (command) => command.type === "thread.turn.start",
    );
    assert.ok(nextTurn);
    if (nextTurn.type !== "thread.turn.start") throw new Error("Expected thread.turn.start");
    assert.match(nextTurn.message.text, /Simplify only the code changed/);
    const run = yield* repository.getRunByIssue({ projectId: PROJECT_ID, issueId: ISSUE_ID });
    assert.strictEqual(run?.lifecyclePhase, "simplifying");
  }),
);
```

Add tests for review pass and review fail:

```ts
it.effect("moves to PR ready when review passes", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;
    const thread = makeThread({
      worktreePath: projectRoot,
      latestTurn: {
        turnId: "turn-review" as never,
        state: "completed",
        requestedAt: CREATED_AT,
        startedAt: CREATED_AT,
        completedAt: "2026-05-02T12:20:00.000Z",
        assistantMessageId: "message-review" as never,
      },
      messages: [
        {
          id: "message-review" as never,
          role: "assistant",
          text: "Looks correct.\nREVIEW_PASS: tests cover the workflow",
          turnId: "turn-review" as never,
          streaming: false,
          createdAt: "2026-05-02T12:20:00.000Z",
          updatedAt: "2026-05-02T12:20:00.000Z",
        },
      ],
    });
    orchestrationState.currentReadModel = makeReadModel(projectRoot, { threads: [thread] });
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(
      Effect.succeed([makeLinearContext("In Progress")]),
    );

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;
    yield* repository.upsertRun(
      makeServiceRun({
        status: "running",
        lifecyclePhase: "reviewing",
        executionTarget: "local",
        workspacePath: projectRoot,
        branchName: "symphony/bc-1",
        threadId: thread.id,
      }),
    );

    yield* service.refresh({ projectId: PROJECT_ID });

    const run = yield* repository.getRunByIssue({ projectId: PROJECT_ID, issueId: ISSUE_ID });
    assert.strictEqual(run?.lifecyclePhase, "pr-ready");
    assert.strictEqual(run?.qualityGate.lastReviewSummary, "tests cover the workflow");
  }),
);
```

- [ ] **Step 2: Run failing gate tests**

Run:

```bash
cd apps/server
bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Expected: FAIL until phase handling exists.

- [ ] **Step 3: Add helper to get latest assistant text**

In `apps/server/src/symphony/phaseOutput.ts`, add:

```ts
export function extractLatestAssistantText(thread: OrchestrationThread): string | null {
  const assistantMessage = thread.messages
    .filter((message) => message.role === "assistant" && !message.streaming)
    .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  return assistantMessage?.text.trim() || null;
}
```

Add a unit test in `phaseOutput.test.ts` that asserts it returns the newest assistant message.

- [ ] **Step 4: Add phase turn launcher**

In `apps/server/src/symphony/Layers/SymphonyService.ts`, add:

```ts
const startPhaseTurn = (input: {
  readonly projectId: ProjectId;
  readonly workflow: { readonly config: SymphonyWorkflowConfig; readonly promptTemplate: string };
  readonly run: SymphonyRun;
  readonly phase: SymphonyRun["lifecyclePhase"];
  readonly prompt: string;
}): Effect.Effect<void, SymphonyError> =>
  Effect.gen(function* () {
    if (!input.run.threadId) {
      return yield* new SymphonyError({ message: "Symphony phase turn requires a linked thread." });
    }
    const startedAt = nowIso();
    const nextRun: SymphonyRun = {
      ...input.run,
      lifecyclePhase: input.phase,
      status: "running",
      updatedAt: startedAt,
    };
    yield* repository
      .upsertRun(nextRun)
      .pipe(Effect.mapError(toSymphonyError("Failed to update Symphony phase.")));
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: commandId(`${input.phase}-turn-start`),
        threadId: input.run.threadId,
        message: {
          messageId: messageId(),
          role: "user",
          text: input.prompt,
          attachments: [],
        },
        modelSelection: defaultSymphonyLocalModelSelection(),
        titleSeed: `Symphony ${input.run.issue.identifier} ${input.phase}`,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: startedAt,
      })
      .pipe(Effect.mapError(toSymphonyError("Failed to launch Symphony phase turn.")));
  });
```

- [ ] **Step 5: Route completed implementation to simplification**

In `reconcileRunWithThread`, before generic continuation logic:

```ts
if (run.lifecyclePhase === "implementing" && latestTurn.state === "completed") {
  yield *
    startPhaseTurn({
      projectId: run.projectId,
      workflow: input.workflow,
      run,
      phase: "simplifying",
      prompt: buildSimplificationPrompt({
        simplificationPrompt: input.workflow.config.quality.simplificationPrompt,
      }),
    });
  return;
}
```

- [ ] **Step 6: Route simplification completion to review**

Add:

```ts
if (run.lifecyclePhase === "simplifying" && latestTurn.state === "completed") {
  yield *
    startPhaseTurn({
      projectId: run.projectId,
      workflow: input.workflow,
      run,
      phase: "reviewing",
      prompt: buildReviewPrompt({
        reviewPrompt: input.workflow.config.quality.reviewPrompt,
      }),
    });
  return;
}
```

- [ ] **Step 7: Route review completion to PR ready or fixing**

Add:

```ts
if (run.lifecyclePhase === "reviewing" && latestTurn.state === "completed") {
  const reviewText = extractLatestAssistantText(thread);
  const outcome = reviewText ? extractReviewOutcome(reviewText) : null;
  if (!outcome) {
    const failedRun: SymphonyRun = {
      ...run,
      lifecyclePhase: "failed",
      status: "failed",
      lastError: "Review completed without REVIEW_PASS or REVIEW_FAIL marker.",
      updatedAt: completedAt,
    };
    yield *
      repository
        .upsertRun(failedRun)
        .pipe(Effect.mapError(toSymphonyError("Failed to mark review as failed.")));
    return;
  }
  const nextPhase = nextPhaseAfterReview({
    passed: outcome.passed,
    fixLoops: run.qualityGate.reviewFixLoops,
    maxFixLoops: input.workflow.config.quality.maxReviewFixLoops,
  });
  const nextRun: SymphonyRun = {
    ...run,
    lifecyclePhase: nextPhase,
    qualityGate: {
      ...run.qualityGate,
      reviewFixLoops: outcome.passed
        ? run.qualityGate.reviewFixLoops
        : run.qualityGate.reviewFixLoops + 1,
      lastReviewPassedAt: outcome.passed ? completedAt : run.qualityGate.lastReviewPassedAt,
      lastReviewSummary: outcome.summary,
      lastReviewFindings: [...outcome.findings],
    },
    lastError: nextPhase === "failed" ? outcome.summary : null,
    updatedAt: completedAt,
  };
  yield *
    repository
      .upsertRun(nextRun)
      .pipe(Effect.mapError(toSymphonyError("Failed to persist review outcome.")));
  if (nextPhase === "fixing") {
    yield *
      startPhaseTurn({
        projectId: run.projectId,
        workflow: input.workflow,
        run: nextRun,
        phase: "fixing",
        prompt: buildFixPrompt({
          findings: outcome.findings,
          workflowPrompt: input.workflow.promptTemplate,
        }),
      });
  }
  return;
}
```

Import `nextPhaseAfterReview`, `buildSimplificationPrompt`, `buildReviewPrompt`, `buildFixPrompt`, `extractLatestAssistantText`, and `extractReviewOutcome`.

- [ ] **Step 8: Route fixing completion back to simplification**

Add:

```ts
if (run.lifecyclePhase === "fixing" && latestTurn.state === "completed") {
  yield *
    startPhaseTurn({
      projectId: run.projectId,
      workflow: input.workflow,
      run,
      phase: "simplifying",
      prompt: buildSimplificationPrompt({
        simplificationPrompt: input.workflow.config.quality.simplificationPrompt,
      }),
    });
  return;
}
```

- [ ] **Step 9: Run gate tests**

Run:

```bash
cd apps/server
bun run test src/symphony/phaseOutput.test.ts src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 6**

```bash
git add apps/server/src/symphony/Layers/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts apps/server/src/symphony/phaseOutput.ts apps/server/src/symphony/phaseOutput.test.ts
git commit -m "feat(symphony): sequence quality gate phases" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 7: Add Symphony-Owned PR Creation And Linear Review Transition

**Files:**

- Modify: `packages/contracts/src/git.ts`
- Modify: `packages/contracts/src/git.test.ts`
- Modify: `apps/server/src/git/Layers/GitManager.ts`
- Modify: `apps/server/src/git/Layers/GitManager.test.ts`
- Modify: `apps/server/src/server.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`
- Modify: `apps/server/src/symphony/runLifecycle.ts`
- Modify: `apps/server/src/symphony/runLifecycle.test.ts`

- [ ] **Step 1: Provide GitManager to Symphony**

In `apps/server/src/server.ts`, modify `SymphonyLayerLive`:

```ts
const SymphonyLayerLive = SymphonyServiceLive.pipe(
  Layer.provideMerge(SymphonyRepositoryLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(ServerSecretStoreLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(OrchestrationLayerLive),
);
```

- [ ] **Step 2: Add Git stacked-action PR base branch override**

In `packages/contracts/src/git.test.ts`, add a failing decode assertion:

```ts
expect(
  decodeRunStackedActionInput({
    actionId: "action-1",
    cwd: "/repo",
    action: "commit_push_pr",
    baseBranch: "development",
  }).baseBranch,
).toBe("development");
```

In `packages/contracts/src/git.ts`, extend `GitRunStackedActionInput`:

```ts
baseBranch: Schema.optional(TrimmedNonEmptyStringSchema),
```

In `apps/server/src/git/Layers/GitManager.ts`, update `runPrStep` to accept a base branch override:

```ts
const runPrStep = Effect.fn("runPrStep")(function* (
  modelSelection: ModelSelection,
  cwd: string,
  fallbackBranch: string | null,
  baseBranchOverride: string | undefined,
  emit: GitActionProgressEmitter,
) {
```

Use the override where PR creation currently resolves base:

```ts
const baseBranch =
  baseBranchOverride ?? yield * resolveBaseBranch(cwd, branch, details.upstreamRef, headContext);
```

Pass it from `runStackedAction`:

```ts
runPrStep(modelSelection, input.cwd, currentBranch, input.baseBranch, progress.emit);
```

In `apps/server/src/git/Layers/GitManager.test.ts`, add a focused test that calls `runStackedAction` with `baseBranch: "development"` and asserts `GitHubCli.createPullRequest` receives `baseBranch: "development"`.

- [ ] **Step 3: Add failing PR-ready service test**

In `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`, add a mock `GitManager` service to the test layer with `runStackedAction`. Then add:

```ts
it.effect("creates a PR when review passes and moves Linear to review", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;
    gitManagerMocks.runStackedAction.mockReturnValue(
      Effect.succeed({
        action: "commit_push_pr",
        branch: { status: "skipped_not_requested" },
        commit: { status: "skipped_no_changes" },
        push: { status: "skipped_up_to_date" },
        pr: {
          status: "created",
          url: "https://github.com/t3/battlecode/pull/31",
          number: 31,
          baseBranch: "development",
          headBranch: "symphony/bc-1",
          title: "Fix cloud lifecycle",
        },
        toast: {
          title: "Pull request created",
          cta: {
            kind: "open_pr",
            label: "Open PR",
            url: "https://github.com/t3/battlecode/pull/31",
          },
        },
      }),
    );
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(
      Effect.succeed([makeLinearContext("In Progress")]),
    );
    linearMocks.updateLinearIssueState.mockReturnValue(
      Effect.succeed({
        changed: true,
        stateId: "state-review",
        stateName: "In Review",
      }),
    );

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;
    yield* repository.upsertRun(
      makeServiceRun({
        lifecyclePhase: "pr-ready",
        status: "running",
        executionTarget: "local",
        workspacePath: projectRoot,
        branchName: "symphony/bc-1",
      }),
    );

    yield* service.refresh({ projectId: PROJECT_ID });

    const run = yield* repository.getRunByIssue({ projectId: PROJECT_ID, issueId: ISSUE_ID });
    assert.strictEqual(run?.lifecyclePhase, "in-review");
    assert.strictEqual(run?.status, "review-ready");
    assert.strictEqual(run?.prUrl, "https://github.com/t3/battlecode/pull/31");
    assert.ok(linearMocks.updateLinearIssueState.mock.calls.length > 0);
  }),
);
```

- [ ] **Step 4: Run failing PR service test**

Run:

```bash
cd apps/server
bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Expected: FAIL until `pr-ready` reconciliation creates PRs.

- [ ] **Step 5: Add PR creation helper**

In `apps/server/src/symphony/Layers/SymphonyService.ts`, add:

```ts
const createPullRequestForRun = (input: {
  readonly projectId: ProjectId;
  readonly workflow: { readonly config: SymphonyWorkflowConfig };
  readonly run: SymphonyRun;
}): Effect.Effect<SymphonyRun, SymphonyError> =>
  Effect.gen(function* () {
    const cwd = input.run.workspacePath;
    if (!cwd) {
      return yield* new SymphonyError({
        message: "Cannot create PR without a Symphony workspace.",
      });
    }
    const result = yield* gitManager
      .runStackedAction({
        actionId: commandId("symphony-create-pr"),
        cwd,
        action: "commit_push_pr",
        commitMessage: `${input.run.issue.identifier}: ${input.run.issue.title}`,
        ...(input.workflow.config.pullRequest.baseBranch
          ? { baseBranch: input.workflow.config.pullRequest.baseBranch }
          : {}),
      })
      .pipe(Effect.mapError(toSymphonyError("Failed to create Symphony pull request.")));
    const prUrl =
      result.pr.status === "created" || result.pr.status === "opened_existing"
        ? (result.pr.url ?? null)
        : null;
    const nextRun: SymphonyRun = {
      ...input.run,
      lifecyclePhase: "in-review",
      status: "review-ready",
      prUrl,
      updatedAt: nowIso(),
    };
    yield* repository
      .upsertRun(nextRun)
      .pipe(Effect.mapError(toSymphonyError("Failed to persist Symphony PR state.")));
    yield* transitionLinearRunState({
      projectId: input.projectId,
      workflow: input.workflow,
      run: nextRun,
      stateName: input.workflow.config.tracker.transitionStates.review,
      reason: "pr-opened",
    });
    yield* updateManagedProgressComment({
      projectId: input.projectId,
      workflow: input.workflow,
      run: nextRun,
      planMarkdown: input.run.currentStep?.detail ?? "- [x] Review passed",
      statusLine: "PR opened; waiting for human review",
      milestone: prUrl ? `PR opened: ${prUrl}` : "PR opened",
    });
    return nextRun;
  });
```

- [ ] **Step 6: Trigger PR creation in scheduler reconciliation**

In `reconcileProjectRuns`, after each run is reconciled, if the latest run has `lifecyclePhase === "pr-ready"`, call `createPullRequestForRun`.

Add helper:

```ts
const maybeCreatePullRequest = (input: {
  readonly projectId: ProjectId;
  readonly workflow: { readonly config: SymphonyWorkflowConfig };
  readonly run: SymphonyRun;
}): Effect.Effect<void, SymphonyError> =>
  input.run.lifecyclePhase === "pr-ready"
    ? createPullRequestForRun(input).pipe(Effect.asVoid)
    : Effect.void;
```

Use it in both local and cloud reconciliation after `reconcileRunSignals` or `reconcileRunWithThread` returns a current run. If the current helper returns `void`, load the run again with `repository.getRunByIssue`.

- [ ] **Step 7: Make PR open map to in-review phase**

In `runLifecycle.ts`, keep `status: "review-ready"` for open PRs, but add a helper in `lifecyclePhase.ts` or `runLifecycle.ts` that maps PR state to lifecycle phase:

```ts
function phaseFromPullRequestState(
  pullRequest: SymphonyRun["pullRequest"],
  fallback: SymphonyRun["lifecyclePhase"],
): SymphonyRun["lifecyclePhase"] {
  if (pullRequest?.state === "open") return "in-review";
  if (pullRequest?.state === "merged") return "done";
  if (pullRequest?.state === "closed") return "canceled";
  return fallback;
}
```

Use it in `reconcileRunSignals` and persist the phase when it changes.

- [ ] **Step 8: Map closed PRs to canceled and merged PRs to done**

In `apps/server/src/symphony/runLifecycle.test.ts`, add:

```ts
it("marks a run canceled when its PR is closed without merge", () => {
  const result = resolveRunLifecycle({
    run: makeLifecycleRun(),
    config: CONFIG,
    thread: makeCompletedThread(),
    pullRequest: makePullRequest("closed"),
  });

  expect(result.status).toBe("canceled");
  expect(result.currentStep.label).toBe("Pull request closed");
});
```

In `apps/server/src/symphony/runLifecycle.ts`, update `deriveRunProgress` before the Linear state checks:

```ts
if (prClassification === "closed" && pullRequest) {
  return progress({
    source: "github",
    label: "Pull request closed",
    detail: `#${pullRequest.number} ${pullRequest.title}`,
    updatedAt: pullRequest.updatedAt,
  });
}
```

Update `resolveRunLifecycle` status mapping so `prClassification === "closed"` returns `"canceled"`:

```ts
const status: SymphonyRunStatus =
  prClassification === "done" || linearClassification === "done"
    ? "completed"
    : prClassification === "closed" || linearClassification === "canceled"
      ? "canceled"
      : prClassification === "review" || linearClassification === "review"
        ? "review-ready"
        : cloudClassification === "failed"
          ? "failed"
          : input.run.executionTarget === "codex-cloud" && cloudClassification === "running"
            ? "cloud-running"
            : input.run.executionTarget === "codex-cloud" && cloudClassification === "submitted"
              ? "cloud-submitted"
              : threadClassification === "failed"
                ? "failed"
                : input.run.status;
```

This uses the existing `statusChanged` transitions in `SymphonyService.ts`: completed PRs move Linear to `Done`, and closed PRs move Linear to `Canceled`.

- [ ] **Step 9: Run PR tests**

Run:

```bash
cd apps/server
bun run test src/git/Layers/GitManager.test.ts src/symphony/runLifecycle.test.ts src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 7**

```bash
git add packages/contracts/src/git.ts packages/contracts/src/git.test.ts apps/server/src/git/Layers/GitManager.ts apps/server/src/git/Layers/GitManager.test.ts apps/server/src/server.ts apps/server/src/symphony/Layers/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts apps/server/src/symphony/runLifecycle.ts apps/server/src/symphony/runLifecycle.test.ts
git commit -m "feat(symphony): create PRs from clean review gates" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 8: Detect Rework From Linear And GitHub Signals

**Files:**

- Modify: `apps/server/src/git/Services/GitHubCli.ts`
- Modify: `apps/server/src/git/Layers/GitHubCli.ts`
- Modify: `apps/server/src/git/Layers/GitHubCli.test.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`
- Modify: `apps/server/src/symphony/linear.ts`
- Modify: `apps/server/src/symphony/linear.test.ts`

- [ ] **Step 1: Write failing rework test for Linear moved back to In Progress**

In `apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts`, add:

```ts
it.effect("moves in-review runs back to fixing when Linear returns to In Progress", () =>
  Effect.gen(function* () {
    const projectRoot = yield* writeWorkflow;
    projectRootRef.current = projectRoot;
    const repository = yield* SymphonyRepository;
    const service = yield* SymphonyService;
    linearMocks.fetchLinearIssuesByIds.mockReturnValue(
      Effect.succeed([makeLinearContext("In Progress")]),
    );

    yield* runMigrations();
    yield* insertProjectionProject(projectRoot);
    yield* configureWorkflowSettings;
    yield* repository.upsertRun(
      makeServiceRun({
        status: "review-ready",
        lifecyclePhase: "in-review",
        executionTarget: "local",
        workspacePath: projectRoot,
        branchName: "symphony/bc-1",
        threadId: ThreadId.make("symphony-thread-project-symphony-service-issue-bc-1"),
        prUrl: "https://github.com/t3/battlecode/pull/31",
      }),
    );

    yield* service.refresh({ projectId: PROJECT_ID });

    const run = yield* repository.getRunByIssue({ projectId: PROJECT_ID, issueId: ISSUE_ID });
    assert.strictEqual(run?.lifecyclePhase, "fixing");
  }),
);
```

- [ ] **Step 2: Run failing rework test**

Run:

```bash
cd apps/server
bun run test src/symphony/Layers/SymphonyService.lifecycle.test.ts
```

Expected: FAIL until rework signals are handled.

- [ ] **Step 3: Add failing GitHub PR feedback signal tests**

In `apps/server/src/git/Layers/GitHubCli.test.ts`, add tests for requested-changes reviews, PR issue comments, and inline review comments:

```ts
it.effect("lists pull request feedback signals from reviews and comments", () =>
  Effect.gen(function* () {
    mockedRunProcess
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 31,
          title: "Fix workflow",
          url: "https://github.com/t3/battlecode/pull/31",
          baseRefName: "development",
          headRefName: "symphony/bc-1",
          state: "OPEN",
          mergedAt: null,
          updatedAt: "2026-05-02T12:30:00.000Z",
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 1001,
            state: "CHANGES_REQUESTED",
            body: "Please add the missing validation.",
            submitted_at: "2026-05-02T12:40:00.000Z",
            html_url: "https://github.com/t3/battlecode/pull/31#pullrequestreview-1001",
            user: { login: "reviewer" },
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 2001,
            body: "Can you simplify this branch?",
            created_at: "2026-05-02T12:41:00.000Z",
            updated_at: "2026-05-02T12:41:00.000Z",
            html_url: "https://github.com/t3/battlecode/pull/31#issuecomment-2001",
            user: { login: "cal" },
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 3001,
            body: "This branch needs the failed-state test.",
            created_at: "2026-05-02T12:42:00.000Z",
            updated_at: "2026-05-02T12:42:00.000Z",
            html_url: "https://github.com/t3/battlecode/pull/31#discussion_r3001",
            user: { login: "reviewer" },
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

    const result = yield* Effect.gen(function* () {
      const gh = yield* GitHubCli;
      return yield* gh.listPullRequestFeedbackSignals({
        cwd: "/repo",
        reference: "https://github.com/t3/battlecode/pull/31",
      });
    });

    assert.deepStrictEqual(
      result.map((signal) => ({
        kind: signal.kind,
        id: signal.id,
        state: signal.state,
        body: signal.body,
      })),
      [
        {
          kind: "review",
          id: "review-1001",
          state: "CHANGES_REQUESTED",
          body: "Please add the missing validation.",
        },
        {
          kind: "issue-comment",
          id: "issue-comment-2001",
          state: null,
          body: "Can you simplify this branch?",
        },
        {
          kind: "review-comment",
          id: "review-comment-3001",
          state: null,
          body: "This branch needs the failed-state test.",
        },
      ],
    );
    expect(mockedRunProcess).toHaveBeenNthCalledWith(
      2,
      "gh",
      ["api", "repos/t3/battlecode/pulls/31/reviews", "--paginate"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mockedRunProcess).toHaveBeenNthCalledWith(
      3,
      "gh",
      ["api", "repos/t3/battlecode/issues/31/comments", "--paginate"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(mockedRunProcess).toHaveBeenNthCalledWith(
      4,
      "gh",
      ["api", "repos/t3/battlecode/pulls/31/comments", "--paginate"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  }),
);
```

- [ ] **Step 4: Run failing GitHub CLI tests**

Run:

```bash
cd apps/server
bun run test src/git/Layers/GitHubCli.test.ts
```

Expected: FAIL because `listPullRequestFeedbackSignals` does not exist.

- [ ] **Step 5: Extend the GitHub CLI service contract**

In `apps/server/src/git/Services/GitHubCli.ts`, add:

```ts
export interface GitHubPullRequestFeedbackSignal {
  readonly kind: "review" | "issue-comment" | "review-comment";
  readonly id: string;
  readonly state: string | null;
  readonly body: string;
  readonly authorLogin: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly url: string | null;
}
```

Extend `GitHubCliShape`:

```ts
readonly listPullRequestFeedbackSignals: (input: {
  readonly cwd: string;
  readonly reference: string;
}) => Effect.Effect<readonly GitHubPullRequestFeedbackSignal[], GitHubCliError>;
```

- [ ] **Step 6: Implement GitHub PR feedback signal listing**

In `apps/server/src/git/Layers/GitHubCli.ts`, import `type GitHubPullRequestFeedbackSignal`.

Add helpers:

```ts
function parseRepositoryAndNumber(url: string): {
  readonly repository: string;
  readonly number: number;
} {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url.trim());
  if (!match) {
    throw new Error(`Cannot parse GitHub pull request URL: ${url}`);
  }
  return {
    repository: match[1],
    number: Number(match[2]),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseJsonArray(raw: string): readonly unknown[] {
  const parsed = raw.trim().length === 0 ? [] : JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeFeedbackSignal(
  kind: GitHubPullRequestFeedbackSignal["kind"],
  raw: unknown,
): GitHubPullRequestFeedbackSignal | null {
  const record = readRecord(raw);
  if (!record) return null;
  const numericId = readNumber(record.id);
  const id = numericId ? `${kind}-${numericId}` : readString(record.id);
  const body = readString(record.body) ?? "";
  if (!id || body.length === 0) return null;
  const user = readRecord(record.user);
  const submittedAt = readString(record.submitted_at);
  const createdAt = readString(record.created_at) ?? submittedAt;
  const updatedAt = readString(record.updated_at) ?? submittedAt ?? createdAt;
  return {
    kind,
    id,
    state: readString(record.state),
    body,
    authorLogin: user ? readString(user.login) : null,
    createdAt,
    updatedAt,
    url: readString(record.html_url),
  };
}
```

Add implementation to the service object:

```ts
listPullRequestFeedbackSignals: (input) =>
  service.getPullRequest({ cwd: input.cwd, reference: input.reference }).pipe(
    Effect.flatMap((summary) =>
      Effect.try({
        try: () => parseRepositoryAndNumber(summary.url),
        catch: (cause) =>
          new GitHubCliError({
            operation: "listPullRequestFeedbackSignals",
            detail: "Failed to parse GitHub pull request URL.",
            cause,
          }),
      }),
    ),
    Effect.flatMap(({ repository, number }) =>
      Effect.all({
        reviews: execute({
          cwd: input.cwd,
          args: ["api", `repos/${repository}/pulls/${number}/reviews`, "--paginate"],
        }),
        issueComments: execute({
          cwd: input.cwd,
          args: ["api", `repos/${repository}/issues/${number}/comments`, "--paginate"],
        }),
        reviewComments: execute({
          cwd: input.cwd,
          args: ["api", `repos/${repository}/pulls/${number}/comments`, "--paginate"],
        }),
      }),
    ),
    Effect.flatMap((responses) =>
      Effect.try({
        try: () => [
          ...parseJsonArray(responses.reviews.stdout).flatMap((item) => {
            const signal = normalizeFeedbackSignal("review", item);
            return signal ? [signal] : [];
          }),
          ...parseJsonArray(responses.issueComments.stdout).flatMap((item) => {
            const signal = normalizeFeedbackSignal("issue-comment", item);
            return signal ? [signal] : [];
          }),
          ...parseJsonArray(responses.reviewComments.stdout).flatMap((item) => {
            const signal = normalizeFeedbackSignal("review-comment", item);
            return signal ? [signal] : [];
          }),
        ].toSorted((left, right) => {
          const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? "");
          const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? "");
          return leftTime - rightTime;
        }),
        catch: (cause) =>
          new GitHubCliError({
            operation: "listPullRequestFeedbackSignals",
            detail: "GitHub CLI returned invalid pull request feedback JSON.",
            cause,
          }),
      }),
    ),
  ),
```

If TypeScript complains about referencing `service` while creating the object, define `getPullRequest` as a local const before `const service = { ... }`, then assign it in the object and reuse it in `listPullRequestFeedbackSignals`.

- [ ] **Step 7: Run GitHub CLI tests**

Run:

```bash
cd apps/server
bun run test src/git/Layers/GitHubCli.test.ts
```

Expected: PASS.

- [ ] **Step 8: Add rework signal helper**

In `apps/server/src/symphony/Layers/SymphonyService.ts`, add:

```ts
const detectLinearReworkSignal = (input: {
  readonly workflow: { readonly config: SymphonyWorkflowConfig };
  readonly run: SymphonyRun;
  readonly linearIssue: LinearIssueWorkflowContext | null;
}): string | null => {
  if (input.run.lifecyclePhase !== "in-review") return null;
  if (!input.linearIssue) return null;
  const stateName = input.linearIssue.state.name;
  if (stateMatches(input.workflow.config.tracker.activeStates, stateName)) {
    return `Linear moved back to ${stateName}`;
  }
  return null;
};
```

In reconciliation, before treating review-ready as stable, if this helper returns a reason, update the run:

```ts
const reworkReason = detectLinearReworkSignal({
  workflow: input.workflow,
  run: persistedRun,
  linearIssue: input.linearIssue ?? null,
});
if (reworkReason && persistedRun.threadId) {
  const reworkRun: SymphonyRun = {
    ...persistedRun,
    lifecyclePhase: "fixing",
    status: "running",
    currentStep: {
      source: "linear",
      label: "Rework requested",
      detail: reworkReason,
      updatedAt: nowIso(),
    },
    updatedAt: nowIso(),
  };
  yield *
    repository
      .upsertRun(reworkRun)
      .pipe(Effect.mapError(toSymphonyError("Failed to mark Symphony run for rework.")));
  yield *
    startPhaseTurn({
      projectId: reworkRun.projectId,
      workflow: input.workflow,
      run: reworkRun,
      phase: "fixing",
      prompt: buildFixPrompt({
        findings: [reworkReason],
        workflowPrompt: input.workflow.promptTemplate,
      }),
    });
  return { run: reworkRun };
}
```

- [ ] **Step 9: Add Linear comment rework detection**

Use `fetchLinearIssueComments` from Task 3. In `detectLinearFeedbackRework`, compare comment timestamps to `run.linearProgress.lastMilestoneAt` and ignore `run.linearProgress.commentId`.

```ts
const detectLinearFeedbackRework = (input: {
  readonly comments: readonly LinearIssueComment[];
  readonly run: SymphonyRun;
}): string | null => {
  const since = input.run.linearProgress.lastMilestoneAt
    ? Date.parse(input.run.linearProgress.lastMilestoneAt)
    : 0;
  const feedback = input.comments.find((comment) => {
    if (comment.id === input.run.linearProgress.commentId) return false;
    const updatedAt = comment.updatedAt ?? comment.createdAt;
    return updatedAt ? Date.parse(updatedAt) > since : false;
  });
  return feedback ? `Linear feedback: ${feedback.body}` : null;
};
```

Call it for `in-review` runs and route to the same fix path.

- [ ] **Step 10: Add GitHub review and comment rework detection**

Use `github.listPullRequestFeedbackSignals` for in-review runs with a PR URL. Compare feedback timestamps to `run.linearProgress.lastMilestoneAt`, and ignore anything already captured by `run.linearProgress.lastFeedbackAt`.

```ts
const detectGitHubReworkSignal = (input: {
  readonly run: SymphonyRun;
  readonly signals: readonly GitHubPullRequestFeedbackSignal[];
}): string | null => {
  const lastMilestone = input.run.linearProgress.lastMilestoneAt
    ? Date.parse(input.run.linearProgress.lastMilestoneAt)
    : 0;
  const lastFeedback = input.run.linearProgress.lastFeedbackAt
    ? Date.parse(input.run.linearProgress.lastFeedbackAt)
    : 0;
  const since = Math.max(lastMilestone, lastFeedback);
  const signal = input.signals.find((candidate) => {
    const updatedAt = candidate.updatedAt ?? candidate.createdAt;
    if (!updatedAt || Date.parse(updatedAt) <= since) return false;
    if (candidate.kind === "review") {
      return candidate.state?.toUpperCase() === "CHANGES_REQUESTED";
    }
    return candidate.body.trim().length > 0;
  });
  if (!signal) return null;
  const prefix =
    signal.kind === "review"
      ? "GitHub review requested changes"
      : signal.kind === "review-comment"
        ? "GitHub review comment"
        : "GitHub PR comment";
  return `${prefix}: ${signal.body}`;
};
```

Add a service test that seeds an in-review run with `prUrl`, mocks `githubMocks.listPullRequestFeedbackSignals` with a `CHANGES_REQUESTED` review after `lastMilestoneAt`, runs `service.refresh`, and asserts the run moves to `fixing`.

When any rework signal is accepted, update the managed Linear comment, set `linearProgress.lastFeedbackAt` to the feedback timestamp if available or `nowIso()`, and start a fix turn with all collected feedback lines.

- [ ] **Step 11: Run rework tests**

Run:

```bash
cd apps/server
bun run test src/git/Layers/GitHubCli.test.ts src/symphony/Layers/SymphonyService.lifecycle.test.ts src/symphony/linear.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit Task 8**

```bash
git add apps/server/src/git/Services/GitHubCli.ts apps/server/src/git/Layers/GitHubCli.ts apps/server/src/git/Layers/GitHubCli.test.ts apps/server/src/symphony/Layers/SymphonyService.ts apps/server/src/symphony/Layers/SymphonyService.lifecycle.test.ts apps/server/src/symphony/linear.ts apps/server/src/symphony/linear.test.ts
git commit -m "feat(symphony): detect review rework signals" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 9: Unify Symphony Tab And Sidebar Phase Display

**Files:**

- Modify: `apps/web/src/components/symphony/symphonyDisplay.ts`
- Modify: `apps/web/src/components/symphony/IssueQueueTable.tsx`
- Modify: `apps/web/src/components/symphony/RunDetailsDrawer.tsx`
- Modify: `apps/web/src/components/symphony/IssueQueueTable.browser.tsx`
- Modify: `apps/web/src/components/symphony/SymphonyPanel.browser.tsx`
- Modify: `apps/web/src/components/Sidebar.logic.ts`
- Modify: `apps/web/src/components/Sidebar.logic.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Write failing sidebar active phase test**

In `apps/web/src/components/Sidebar.logic.test.ts`, update the Symphony active test:

```ts
expect(
  symphonyRunIsSidebarActive({
    status: "review-ready",
    lifecyclePhase: "in-review",
    archivedAt: null,
  }),
).toBe(false);
expect(
  symphonyRunIsSidebarActive({
    status: "running",
    lifecyclePhase: "simplifying",
    archivedAt: null,
  }),
).toBe(true);
expect(
  symphonyRunIsSidebarActive({
    status: "failed",
    lifecyclePhase: "failed",
    archivedAt: null,
  }),
).toBe(false);
```

- [ ] **Step 2: Update sidebar logic signature**

In `apps/web/src/components/Sidebar.logic.ts`, change:

```ts
run: Pick<SymphonyRun, "status" | "archivedAt">,
```

to:

```ts
run: Pick<SymphonyRun, "status" | "lifecyclePhase" | "archivedAt">,
```

Implement:

```ts
if (run.archivedAt !== null) return false;
return (
  run.lifecyclePhase === "planning" ||
  run.lifecyclePhase === "implementing" ||
  run.lifecyclePhase === "waiting-cloud" ||
  run.lifecyclePhase === "simplifying" ||
  run.lifecyclePhase === "reviewing" ||
  run.lifecyclePhase === "fixing" ||
  run.lifecyclePhase === "pr-ready" ||
  run.status === "running" ||
  run.status === "cloud-submitted" ||
  run.status === "cloud-running" ||
  run.status === "retry-queued"
);
```

- [ ] **Step 3: Run sidebar logic tests**

Run:

```bash
cd apps/web
bun run test src/components/Sidebar.logic.test.ts
```

Expected: PASS.

- [ ] **Step 4: Add phase display helper**

In `apps/web/src/components/symphony/symphonyDisplay.ts`, import `type SymphonyLifecyclePhase` and add:

```ts
export const PHASE_BADGE_CLASSNAME: Record<SymphonyLifecyclePhase, string> = {
  intake: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  planning: "border-primary/50 bg-primary/10 text-primary",
  implementing: "border-success/50 bg-success/10 text-success",
  "waiting-cloud": "border-info/50 bg-info/10 text-info",
  simplifying: "border-warning/50 bg-warning/10 text-warning",
  reviewing: "border-warning/50 bg-warning/10 text-warning",
  fixing: "border-warning/50 bg-warning/10 text-warning",
  "pr-ready": "border-primary/50 bg-primary/10 text-primary",
  "in-review": "border-info/50 bg-info/10 text-info",
  done: "border-success/50 bg-success/10 text-success",
  canceled: "border-muted-foreground/30 bg-muted/40 text-muted-foreground",
  failed: "border-destructive/50 bg-destructive/10 text-destructive",
};

export function formatLifecyclePhase(value: SymphonyLifecyclePhase): string {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
```

- [ ] **Step 5: Update issue table phase column**

In `IssueQueueTable.tsx`, change the `Status` column to show lifecycle phase first:

```tsx
<Badge
  variant="outline"
  className={cn("whitespace-nowrap", PHASE_BADGE_CLASSNAME[run.lifecyclePhase])}
>
  {formatLifecyclePhase(run.lifecyclePhase)}
</Badge>
<div className="mt-1 font-mono text-[10px] uppercase text-muted-foreground/70">
  {formatStatus(run.status)}
</div>
```

Import `PHASE_BADGE_CLASSNAME` and `formatLifecyclePhase`.

- [ ] **Step 6: Update details drawer**

In `RunDetailsDrawer.tsx`, show phase badge in the header and add detail rows:

```tsx
<DetailRow label="Lifecycle phase" value={formatLifecyclePhase(run.lifecyclePhase)} />
<DetailRow label="Progress comment" value={run.linearProgress.commentUrl} />
<DetailRow label="Review summary" value={run.qualityGate.lastReviewSummary} />
<DetailRow label="Review fixes" value={String(run.qualityGate.reviewFixLoops)} />
```

- [ ] **Step 7: Update sidebar row text**

In `Sidebar.tsx`, replace the current `run.currentStep?.label ?? target` text with:

```tsx
{
  run.currentStep?.label ?? formatLifecyclePhase(run.lifecyclePhase);
}
```

Replace the right status pill text with the phase label and class:

```tsx
className={`inline-flex h-4 shrink-0 items-center border px-1 font-mono text-[9px] uppercase ${
  PHASE_BADGE_CLASSNAME[run.lifecyclePhase]
}`}
```

```tsx
{
  formatLifecyclePhase(run.lifecyclePhase);
}
```

- [ ] **Step 8: Run web tests**

Run:

```bash
cd apps/web
bun run test src/components/Sidebar.logic.test.ts
bun run test:browser src/components/symphony/IssueQueueTable.browser.tsx src/components/symphony/SymphonyPanel.browser.tsx
```

Expected: PASS.

- [ ] **Step 9: Commit Task 9**

```bash
git add apps/web/src/components/symphony/symphonyDisplay.ts apps/web/src/components/symphony/IssueQueueTable.tsx apps/web/src/components/symphony/RunDetailsDrawer.tsx apps/web/src/components/symphony/IssueQueueTable.browser.tsx apps/web/src/components/symphony/SymphonyPanel.browser.tsx apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): show Symphony lifecycle phases" -m "Co-Authored-By: Paperclip <noreply@paperclip.ing>"
```

## Task 10: Final Validation And Documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-05-02-symphony-linear-workflow-control-plane-design.md` only if implementation discoveries require a design correction.
- Modify: `docs/superpowers/plans/2026-05-02-symphony-linear-workflow-control-plane.md` to check off completed tasks if execution is done from this plan.

- [ ] **Step 1: Run focused Symphony server tests**

Run:

```bash
cd apps/server
bun run test src/git/Layers/GitHubCli.test.ts src/git/Layers/GitManager.test.ts src/symphony/workflow.test.ts src/symphony/linear.test.ts src/symphony/runModel.test.ts src/symphony/runLifecycle.test.ts src/symphony/lifecyclePhase.test.ts src/symphony/phasePrompts.test.ts src/symphony/phaseOutput.test.ts src/symphony/progressComment.test.ts src/symphony/Layers/SymphonyRepository.test.ts src/symphony/Layers/SymphonyService.lifecycle.test.ts src/persistence/Migrations/031_SymphonyLifecycleControlPlane.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused web tests**

Run:

```bash
cd apps/web
bun run test src/components/Sidebar.logic.test.ts
bun run test:browser src/components/symphony/IssueQueueTable.browser.tsx src/components/symphony/SymphonyPanel.browser.tsx
```

Expected: PASS.

- [ ] **Step 3: Run repo formatting**

Run:

```bash
bun fmt
```

Expected: exits 0 and formats files.

- [ ] **Step 4: Run repo lint**

Run:

```bash
bun lint
```

Expected: exits 0.

- [ ] **Step 5: Run repo typecheck**

Run:

```bash
bun typecheck
```

Expected: exits 0.

- [ ] **Step 6: Run repo test suite**

Run:

```bash
bun run test
```

Expected: exits 0. Use `bun run test`, not `bun test`.

- [ ] **Step 7: Resolve AGENTS.md validation conflict explicitly**

This checkout is T3 Code with Bun/Turbo scripts. If `npm run typecheck` or `npm run lint` is requested by inherited BattleTCG instructions, record in the final implementation summary that this repo's root `package.json` defines `bun typecheck` and `bun lint`, and those were the validation commands used.

- [ ] **Step 8: Final status check**

Run:

```bash
git status --short --branch
```

Expected: only intentional plan checklist edits if this plan was checked off during execution, or a clean tree after all implementation commits.
