# Symphony Local-Only Redesign Design

## Goal

Make Symphony a local-execution-only workflow controller for battlecode that polls Linear for issues in the configured intake state, dispatches each issue to a T3 chat thread running Codex locally in an isolated worktree, owns Linear writes (managed progress comment, state transitions, PR link posting), stops at PR creation, and auto-archives runs when humans move issues to terminal states.

The redesign stays close to the original Symphony spec (`/Users/caladyne/symphony/SPEC.md`) while leveraging battlecode's existing T3 thread and worktree infrastructure.

## Background

The current Symphony implementation in battlecode goes meaningfully beyond the Elixir reference: it adds Codex Cloud delegation as the primary execution path and adds GitHub PR lookup at the orchestrator layer. Both extensions have proven fragile in practice. The user has been hitting three recurring symptoms:

1. **Linear lookup fail with HTTP 400.** Configuration errors (project slug vs slugId, case-sensitive state names, possibly auth scheme) surface as opaque 400s with truncated error bodies that make root-cause attribution slow.
2. **GitHub PR lookup failed warnings.** The `gh` CLI is the single point of failure for PR status and PR feedback signals; rate limits, authentication state, and remote repository assumptions all surface as repeated warnings with limited diagnostic detail.
3. **Issues moved into Todo state are not picked up.** This cascades from symptom 1: a single Linear 400 in the candidate-fetch query fails the entire scheduler tick, which blocks new-issue intake until the next tick (which fails again).

Rather than continue layering complexity onto the cloud-and-PR-aware orchestrator, this redesign deletes both extensions and rebuilds Symphony as a local-only workflow controller modeled on the Elixir reference, with an additional setup wizard UI to make configuration physically correct by construction.

## Approved Direction

| Decision | Choice |
|---|---|
| Execution model | Local only. No Codex Cloud. No orchestrator-level GitHub PR lookup. |
| Phase structure | Two phases: Planning (turn 1) → Doing (turn 2, continuation in the same T3 thread) |
| Agent ↔ Symphony interface | Symphony parses structured markers in thread output (`SYMPHONY_PLAN_BEGIN/END`, `SYMPHONY_PR_URL`) |
| Linear writes | Symphony-owned: managed progress comment + state transitions |
| End of run | Stop at PR creation. Reconcile Linear terminal states (`Done`, `Canceled`) for auto-archive. |
| Worktree management | Reuse `apps/server/src/git/`. Branch `symphony/<sanitized-issue-id>`. Concurrency cap default 3, configurable. |
| Failure handling | Hybrid retry: auto-retry transient infra; human-gate output failures; stall detection; per-run + per-symptom isolation |
| Configuration UX | Guided UI wizard fetches teams, projects, and workflow states from Linear. `WORKFLOW.md` remains the hand-editable artifact. |

## Non-Goals

- No automatic rework after PR creation. Humans move issues back to Todo to re-engage Symphony, which then creates a fresh run.
- No GitHub PR state polling at the orchestrator level. The agent creates the PR via `gh pr create` inside its worktree and reports the URL; Symphony does not query GitHub.
- No orchestrator-enforced multi-phase quality gates. Simplification, review, and fix loops become agent-internal concerns inside Phase 2 (the agent runs `bun fmt`, `bun lint`, `bun typecheck`, `bun run test` and any review skills before creating the PR).
- No Codex Cloud delegation.
- No new Linear states beyond the user's existing columns (`Backlog`, `To Do`, `In Progress`, `In Review`, `Done`, `Canceled`).
- No removal of `WORKFLOW.md`. The file stays, gets cleaner, and remains hand-editable.

## Architecture

### Three Independent Runtime Concerns

Symphony decomposes into three loops that run on independent error boundaries. A failure in one cannot cascade into another. This is the structural fix for the cascade the user has been hitting.

1. **Scheduler.** Periodic Linear poll for issues in *intake* states. Allocates capacity. Creates new run records. Dispatches Phase 1.
2. **Run Orchestrator.** For each in-flight run, drives Phase 1 → Phase 2 transitions. Parses thread markers. Calls into the Linear writer.
3. **Reconciler.** Independently polls Linear for issues in *terminal* states (Done, Canceled). Archives matching local runs.

In the current implementation, all three are entangled in a single `runSchedulerTick` Effect — any failure (especially a Linear 400 in candidate fetch) propagates up and kills the whole tick. In the new design, each runs as its own Effect with its own catch boundary; failures are logged and surfaced as PubSub events but never propagate to a sibling concern.

### Component Map

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/web (React)                                                │
│   Symphony Settings Wizard ◄──────────► Symphony Run Tab        │
└─────────────┬───────────────────────────────────┬───────────────┘
              │ RPC                               │ snapshots
┌─────────────▼───────────────────────────────────▼───────────────┐
│ apps/server/src/symphony/                                       │
│                                                                 │
│   ┌──────────────┐   ┌────────────────┐   ┌──────────────────┐  │
│   │ Scheduler    │   │ Run            │   │ Reconciler       │  │
│   │ (poll intake)│   │ Orchestrator   │   │ (poll terminals, │  │
│   │              │   │ (Phase 1 → 2)  │   │  archive)        │  │
│   └──────┬───────┘   └────┬───────────┘   └─────┬────────────┘  │
│          │                │                     │               │
│          └────────┬───────┴─────────┬───────────┘               │
│                   │                 │                           │
│            ┌──────▼──────┐   ┌──────▼─────────┐                 │
│            │ LinearWriter│   │ ThreadOutput   │                 │
│            │ (comment +  │   │ Parser         │                 │
│            │  state)     │   │ (markers)      │                 │
│            └──────┬──────┘   └──────┬─────────┘                 │
│                   │                 │                           │
│            ┌──────▼─────────────────▼──────────────────┐        │
│            │ SymphonyRepository (SQLite)               │        │
│            │  runs / runtime state / settings / cursor │        │
│            └────────────────────────────────────────────┘        │
└──────┬──────────────────────────────────────┬──────┬────────────┘
       │                                      │      │
       ▼                                      ▼      ▼
  Linear GraphQL                        Worktree     Codex App
  (linear.ts)                           Manager      Server Manager
                                        (existing)   (existing)
                                            │             │
                                            └──────┬──────┘
                                                   ▼
                                         Local T3 Chat Thread
                                         (per-run, isolated worktree,
                                          visible in chat UI,
                                          parsed for SYMPHONY_PLAN /
                                          SYMPHONY_PR_URL markers)
```

### Architectural Commitments

**Symphony runs are T3 threads.** Not parallel infrastructure. A Symphony run shows up in the existing chat UI as a thread the user can watch live, scroll through, and intervene in if needed. Phase 1 and Phase 2 are turn 1 and turn 2 of that thread. Every Symphony run is observable for free.

**The orchestrator never talks to GitHub.** The agent does, via `gh` inside the worktree, the same way humans do. Symphony only learns about the PR through the `SYMPHONY_PR_URL` marker in thread output. This kills an entire class of failures (gh rate limits, gh auth state, REST fallback complexity).

**Linear writes are centralized in one module.** `linearWriter.ts` owns `commentCreate`, `commentUpdate` (for the managed comment), and `issueUpdate` (state transitions). Scheduler, orchestrator, and reconciler all call into it. This makes Linear-write retry/error-handling consistent and testable, and it is the only place that knows the managed-comment marker convention (`<!-- symphony-managed-progress v1 -->`).

## Run Lifecycle and Data Flow

### Status Enum

Seven statuses, down from the current ~12:

| Status | Meaning |
|---|---|
| `intake` | Run created from Linear intake; awaiting capacity slot |
| `planning` | Phase 1 turn in flight (Codex turn 1) |
| `implementing` | Phase 2 turn in flight (Codex turn 2 continuation) |
| `in-review` | PR created; Linear at "In Review"; Symphony idle |
| `completed` | Reconciler observed Linear "Done" |
| `canceled` | Reconciler observed Linear "Canceled" |
| `failed` | Terminal failure; manual Retry needed |

Plus a separate `archivedAt: Date | null` field. Deleted statuses include `target-pending`, `released`, `eligible`, `retry-queued`, `waiting-cloud-signal`, and all cloud-specific lifecycle phases.

### Happy Path Lifecycle

```
   Linear: To Do
        │
        │  Scheduler tick: poll, capacity available, no active run
        ▼
   ┌─────────────────────────┐
   │ status: intake          │   (run row created in SQLite)
   └────────────┬────────────┘
                │  Worktree created on branch symphony/<id>
                │  T3 thread created
                │  LinearWriter: managed comment posted
                │  LinearWriter: To Do → In Progress
                ▼
   ┌─────────────────────────┐
   │ status: planning        │   (Codex turn 1 streaming)
   └────────────┬────────────┘
                │  Turn 1 ends
                │  Parser scans for SYMPHONY_PLAN_BEGIN/END
                │
       ┌────────┴────────┐
       │                 │
   markers found     markers missing
       │                 │
       ▼                 ▼
LinearWriter:       status: failed
managed comment     (manual Retry)
updated with plan
       │
       ▼
   ┌─────────────────────────┐
   │ status: implementing    │   (Codex turn 2, same thread, continuation)
   └────────────┬────────────┘
                │  Turn 2 ends
                │  Parser scans for SYMPHONY_PR_URL
                │
       ┌────────┴────────┐
       │                 │
   marker found     marker missing
       │                 │
       ▼                 ▼
LinearWriter:       status: failed
comment +PR link    (manual Retry)
LinearWriter:
In Progress → In Review
       │
       ▼
   ┌─────────────────────────┐
   │ status: in-review       │   (Symphony idle on this run)
   └────────────┬────────────┘
                │  Reconciler tick later observes Linear terminal state
                │
       ┌────────┴────────┐
       │                 │
  Linear: Done     Linear: Canceled
       │                 │
       ▼                 ▼
status: completed   status: canceled
archivedAt: now     archivedAt: now
```

### Re-engagement Policy

Each run tracks a `lastSeenLinearState: string` field, updated each scheduler tick from the issue's current Linear state. The scheduler creates a fresh run only when Symphony observes a transition into an intake state, not when an issue has been continuously in intake. This bounds retry behavior so failed runs do not loop forever.

| Existing run for issue | Issue currently in intake? | Was last-seen state intake? | Action |
|---|---|---|---|
| None | yes | — | Create fresh run |
| Active (intake / planning / implementing / in-review) | yes | yes | No-op (update last-seen) |
| Failed (not archived) | yes | yes | No-op — user has not re-engaged |
| Failed (not archived) | yes | no (transitioned in) | Archive failed run, create fresh |
| Archived completed/canceled | yes | no (transitioned in) | Create fresh run, leave archived |
| In-review (not archived) | yes | no (PR was abandoned, user moved back) | Archive in-review run, create fresh |

The key invariant: a Linear state transition into an intake state creates a fresh run. A run that has been sitting in intake does not keep re-firing. This requires storing `last_seen_linear_state` on the run record (one new column).

This policy also fixes the `shouldQueueIntakeRun` regression in the current code, where failed runs incorrectly stayed failed when the issue moved back to Todo.

### Polling Cadence

Two independent loops, each with its own error boundary:

| Loop | Default interval | Linear filter scope |
|---|---|---|
| Scheduler | 30 seconds | issues in any of the configured intake, active, or review state names |
| Reconciler | 60 seconds | issues in terminal states (done + canceled) |

Both intervals are configurable in `WORKFLOW.md`. Both apply ±10% jitter to prevent thundering-herd on reconnect. Both honor Linear's `Retry-After` header on 429 responses. The scheduler runs more often because intake responsiveness matters; the reconciler less often because terminal states change rarely.

### Capacity Model

A single counter per project: `concurrent_runs ≤ max_concurrent_agents` (default 3, configurable in `WORKFLOW.md`). Only `planning` and `implementing` statuses count. `intake` and `in-review` do not (they are not consuming a Codex turn).

If capacity is full when the scheduler finds a candidate, no run row is created. The candidate stays in Linear's intake state and gets picked up next tick. **Linear is the queue.** No local "queued" status. This mirrors the Elixir reference and avoids local queue state that can drift from Linear truth.

### Configuration Wizard Data Flow

```
[Paste API key]
     │
     ▼
viewer { id name }
     │
  ┌──┴──────────────────────────────────────────────┐
  │ 200 ok                                          │
  │ 400 + body "AUTHENTICATION_FAILED"              │ → "Key rejected; check the value"
  │ 400 + body suggesting Bearer/OAuth confusion    │ → "Looks like an OAuth token; paste a personal API key (lin_api_…)"
  │ network                                         │ → "Couldn't reach Linear; retry"
  └─────────────────────────────────────────────────┘
     │
     ▼
teams { nodes { id name projects { nodes { id name slugId } } } }
     │
[User picks project from dropdown — slugId captured automatically, never typed]
     │
     ▼
team(id: …) { states { nodes { id name type position } } }
     │
[User maps each lifecycle slot to one or more state names from checkboxes]
   intake     → ["To Do", "Todo"]
   active     → ["In Progress"]
   review     → ["In Review"]
   done       → ["Done"]
   canceled   → ["Canceled", "Cancelled"]
     │
     ▼
[Server writes WORKFLOW.md and reloads]
[Scheduler can immediately tick]
```

The wizard's structural value: every value that today causes 400s or empty results is now physically picked from a Linear-validated list. The user can no longer type a wrong slug or misspell a state name.

## Components in Detail

### apps/server/src/symphony/

#### Files to delete entirely
- `codexCloud.ts` — Codex Cloud delegation
- `codexCloud.test.ts`
- `lifecyclePhase.ts` — only two phases now, expressed as inline union type

#### Files to replace (logic substantially different)
- `phasePrompts.ts` → renamed to `prompts.ts`. Two exports: `planningPrompt(issue, workflow)` and `doingPrompt(issue, plan, workflow)`. Drop `simplifyPrompt`, `reviewPrompt`, `fixPrompt`.
- `phaseOutput.ts` → renamed to `threadOutputParser.ts`. Two exports: `parsePlanFromOutput(text)` and `parsePRUrlFromOutput(text)`. Drop the `REVIEW_PASS`/`REVIEW_FAIL` parser.
- `phasePrompts.test.ts` and `phaseOutput.test.ts` rewritten.

#### Files to keep with edits
- `linear.ts` — bug fixes:
  - Inline comment documenting auth scheme: personal API keys (starting with `lin_api_`) sent raw; `Bearer ` prefix is for OAuth only.
  - Detect Bearer-prefixed keys at validation time, surface a helpful error.
  - Log the full HTTP response body on non-2xx (currently truncated at 1000 bytes).
  - Rename `tracker.projectSlug` config key to `tracker.projectSlugId`. Hard rename, no back-compat alias.
  - Surface Linear schema-deprecation hints when fields like `branchName` or `inverseRelations` fail validation.
- `linear.test.ts` — expand to cover validation paths and full-body logging.
- `workflow.ts` — strip cloud-specific config keys; add `concurrency` and explicit polling intervals.
- `runModel.ts` — strip cloud fields (`executionTarget`, `cloudTaskId`); add `lastSeenLinearState`; collapse status enum to 7 values.
- `runLifecycle.ts` — strip cloud branches; resolver shrinks to roughly 300 lines (from ~700).
- `lifecyclePolicy.ts` — strip cloud-specific eligibility helpers.
- `progressComment.ts` — simplify rendering: drop cloud-specific fields, simplify phase label set.
- `settingsModel.ts` — strip cloud fields.
- `identity.ts` — no changes.

#### Files to add (logic extracted from `Layers/SymphonyService.ts`)
- `scheduler.ts` — pure logic: given current state and Linear poll result, what runs to create or update.
- `orchestrator.ts` — pure logic: given a run and a thread event, what is the next action.
- `reconciler.ts` — pure logic: given Linear terminal-state poll and active runs, which to archive.
- `linearWriter.ts` — Linear-write helpers (`upsertManagedComment`, `transitionState`); the only place that knows the managed-comment marker convention.

These are not Effect Layers. They are pure(ish) modules that the existing `Layers/SymphonyService.ts` Layer composes. This keeps the Layer surface area small while making logic unit-testable in isolation. It matches how the codebase already structures `linear.ts`, `runModel.ts`, etc. as pure modules.

#### The big refactor: `Layers/SymphonyService.ts`

The 4,375-line file is decomposed into the four modules above plus a slim composition shell of ~500 to 800 lines. The shell:

- Reads runtime state from `SymphonyRepository`.
- Calls `linear.ts` for fetches.
- Delegates decisions to `scheduler.ts`, `orchestrator.ts`, `reconciler.ts`.
- Calls `linearWriter.ts` for Linear writes.
- Calls `codexAppServerManager` (existing) to drive Codex turns.
- Emits PubSub events.

#### Test file restructure
`Layers/SymphonyService.lifecycle.test.ts` splits into `scheduler.test.ts`, `orchestrator.test.ts`, `reconciler.test.ts`, `linearWriter.test.ts`. Each tests its module in isolation. A new `Layers/SymphonyService.test.ts` covers composition only.

### apps/server/src/git/

#### Remove from `Layers/GitHubCli.ts`
- `getPullRequest`
- `listOpenPullRequests`
- `listPullRequestFeedbackSignals`
- `withRestFallback`
- All accompanying tests
- `normalizeGitHubCliError` if no callers remain after PR helpers go (audit during implementation)

#### Audit during implementation
If `Layers/GitHubCli.ts` has zero remaining callers after the PR helpers are gone, delete the whole file plus its `Services/GitHubCli.ts` interface. The implementation plan verifies this in a dedicated step.

### packages/contracts/src/

- `symphony.ts` — strip `executionTarget` (or collapse to a `"local"` constant), remove cloud states, remove cloud RPC method names. Add new wizard RPCs: `fetchLinearProjects`, `fetchLinearWorkflowStates`, `applyConfiguration`. Add `lastSeenLinearState` to the run schema.
- `symphony.test.ts` — updated.
- `rpc.ts`, `ipc.ts`, `index.ts` — wire the new RPCs.

### packages/shared/src/

- `symphony.ts` — archive eligibility helper updated to drop cloud-specific phases. Source of truth for both server and web.
- `symphony.test.ts` — updated.

### apps/web/src/components/symphony/

#### Delete entirely
- `LinearAuthSettings.tsx` — folded into the wizard; the standalone goes away.
- Any component or branch that is purely cloud-specific (audit each file in `components/symphony/`).

#### Replace
- `SymphonySettingsPanel.tsx` and `.browser.tsx` → become the wizard host with three steps: API key → project picker → state mapper.
- `WorkflowSettingsSection.tsx` → becomes a "review your configuration" surface inside the wizard.

#### New components
- `LinearKeyInput.tsx` — pastes the key, calls `viewer { id name }` on blur, shows specific error messages.
- `LinearProjectPicker.tsx` — dropdown populated from `fetchLinearProjects`; emits `slugId` (never raw text).
- `LinearStateMapper.tsx` — checkbox grid mapping each lifecycle slot (intake/active/review/done/canceled) to one or more Linear state names from `fetchLinearWorkflowStates`.
- `WizardProgress.tsx` — stepper.

#### Keep with edits (strip cloud branches)
- `SymphonyPanel.tsx`, `SymphonyPanel.browser.tsx`
- `SymphonyEventTimeline.tsx` (drop cloud event types)
- `IssueQueueTable.tsx`, `IssueQueueTable.browser.tsx` (drop "Target" column)
- `RunDetailsDrawer.tsx` (drop cloud detail rows)
- `WorkflowStatus.tsx`, `SymphonyToolbar.tsx`, `symphonyDisplay.ts`, `symphonySettingsDisplay.ts`
- `SymphonyProjectSelector.tsx`
- `SymphonyEmptyState.tsx`

### apps/web/src/ (other web files)

- `routes/settings.symphony.tsx` — wizard route shell.
- `routes/_chat.$environmentId.project.$projectId.symphony.tsx` — strip cloud branches.
- `uiStateStore.ts`, `uiStateStore.test.ts` — strip cloud-specific UI state.
- `environmentApi.ts` — add wizard RPC client methods.
- `rpc/wsRpcClient.ts` — wire new RPCs.
- `routeTree.gen.ts` — auto-regenerated.

### Database Migration

One new SQL migration in `apps/server/migrations/`:

- Drop columns from `symphony_runs`: `execution_target`, `cloud_task_id`, and any other cloud-specific columns.
- Drop the `lifecycle_phase` column (collapsed into status).
- Add column `last_seen_linear_state TEXT NULL`.
- Backfill: existing runs with cloud target receive `status = 'canceled'`, `archived_at = NOW()` since their codepath is gone. The migration logs the archived runs for audit; nothing is deleted.

### Server WS / IPC

- `apps/server/src/ws.ts`, `wsServer.ts` — wire the new wizard RPCs (`fetchLinearProjects`, `fetchLinearWorkflowStates`, `applyConfiguration`).
- `apps/server/src/providerManager.ts` — verify Symphony's thread-spawning path uses the same provider dispatch as the chat UI (should already work; verify with a touch test).

## Configuration and WORKFLOW.md Schema

### File shape

`WORKFLOW.md` at repo root has two parts:

1. **YAML frontmatter** — machine-readable; written by the wizard, read by Symphony.
2. **Markdown body** — human + agent instructions; never touched by the wizard.

Symphony injects the body content into the agent's system prompt as repo-specific guidance. This matches both the Elixir reference and the existing battlecode convention.

### Full frontmatter schema (with defaults)

```yaml
---
tracker:
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug_id: a1b2c3d4e5f6
  project_name: BattleTCG

states:
  intake: ["To Do", "Todo"]
  active: ["In Progress"]
  review: ["In Review"]
  done: ["Done"]
  canceled: ["Canceled", "Cancelled"]

git:
  pr_base_branch: development

agent:
  max_turns: 20
  validation:
    - bun fmt
    - bun lint
    - bun typecheck
    - bun run test

concurrency:
  max: 3

polling:
  scheduler_interval_ms: 30000
  reconciler_interval_ms: 60000
  jitter: 0.1

stall:
  timeout_ms: 300000
---

# Repo-specific agent guidance lives here as Markdown.
# This body becomes part of the agent's system prompt.
```

### Field reference

#### tracker
- `endpoint` — Linear GraphQL URL. Almost always the default.
- `api_key` — environment variable name (e.g., `$LINEAR_API_KEY`) or omitted. The actual secret value lives in the OS secret store, written by the wizard. The wizard never writes a literal key into YAML; hand-editing a literal key inline is technically possible but discouraged because the file is committed to git.
- `project_slug_id` — random hash from the Linear project URL. Written by the wizard; never typed by hand. This single rule eliminates the slug-vs-slugId 400 class.
- `project_name` — human-readable; advisory only.

#### states
Five lists of Linear state names. Case-exact strings. Selected via wizard checkboxes from Linear's actual workflow states for the project. Eliminates "ToDo" vs "To Do" mismatches.

#### git
- `pr_base_branch` — base branch for `gh pr create`. Default inferred from `git remote show origin | grep "HEAD branch"`; wizard offers it as an editable suggestion.

#### agent
- `max_turns` — Codex safety cap. Defensive only; agents should not need this many.
- `validation` — shell commands the agent runs in Phase 2 before `gh pr create`. The agent's Phase 2 prompt explicitly instructs: "run each of these; if any fails, fix and rerun until they pass, then create the PR." This makes validation gates agent-internal, matching the no-orchestrator-enforced-quality-gates decision.

#### concurrency
- `max` — only `planning` and `implementing` statuses count. `intake` and `in-review` do not consume a Codex slot.

#### polling
Two intervals, both jittered. Both honor Linear's `Retry-After` on 429.

#### stall
- `timeout_ms` — wallclock from the last thread event. Kills the turn (Codex session disposed) and marks the run failed for manual Retry.

### Removed from the schema

| Old key | Disposition |
|---|---|
| `tracker.projectSlug` | Renamed to `tracker.project_slug_id`. Hard rename, no alias. |
| `cloud.*` (entire subtree) | Deleted. |
| `executionTarget` (anywhere) | Deleted. |
| Cloud-specific phase configs | Deleted. |

### Wizard write semantics

The wizard:
- Validates each step against Linear's live API before advancing.
- Writes the entire frontmatter atomically (parse existing → merge → write back).
- Preserves the Markdown body unchanged.
- Hot-reloads `WORKFLOW.md` in the running server (no restart).
- If the user has hand-edited the frontmatter recently, surfaces a diff and asks before overwriting.
- Auto-populates `agent.validation` from `AGENTS.md` "Task Completion Requirements" section if present, otherwise from `package.json` scripts. User can edit before saving.

### Minimal valid WORKFLOW.md

Almost every field has a default. The smallest acceptable file:

```yaml
---
tracker:
  project_slug_id: a1b2c3d4e5f6

states:
  intake: ["To Do"]
  active: ["In Progress"]
  review: ["In Review"]
  done: ["Done"]
  canceled: ["Canceled"]
---
```

Everything else (PR base branch, validation commands, concurrency, polling, stall, max_turns) takes the values shown in the full schema.

## Error Handling

### Failure Catalog

| Failure | Class | Symphony action | User-visible |
|---|---|---|---|
| Linear poll: network / 5xx / 429 | transient | exp. backoff (1s → 5min, max 5 attempts), honor `Retry-After`; in-flight runs unaffected | toast; persistent banner after 3 consecutive |
| Linear poll: 400 | persistent (config) | log full body; flag config invalid; do not auto-retry; in-flight runs unaffected | error banner with full body + "open wizard" link |
| Linear write: network / 5xx / 429 | transient | exp. backoff; run continues | inline warning on run |
| Linear write: 400 | persistent | log + `lastError`; run continues | inline error; manual write-retry button |
| Worktree create: transient race | transient | retry once | none if recovered |
| Worktree create: persistent | output | mark `failed` | run failed |
| Codex session start: transient | transient | retry with backoff | none if recovered |
| Codex session start: auth/permission | output | mark `failed` | run failed |
| Phase 1 turn crash mid-stream | transient (Codex error code) | retry once | (retrying) |
| Phase 1 no parseable plan | output | mark `failed` | run failed |
| Phase 1 stall | output | kill turn + mark `failed` | run failed; reason "stalled" |
| Phase 2 turn crash mid-stream | transient | retry once | (retrying) |
| Phase 2 no PR URL marker | output | mark `failed` | run failed |
| Phase 2 stall | output | kill turn + mark `failed` | run failed; reason "stalled" |
| Server crash mid-run | output | on restart: orphaned `planning`/`implementing` → `failed`; mid-Codex-turn is not reliably resumable. Worktree is preserved (not pruned) so the user can inspect partial work or run Retry to start a fresh thread on the same branch. | run failed; reason "server restart" |

### Retry Classification

**Auto-retry (transient infrastructure)** — exponential backoff with cap (initial 1s, max 5 min, max 5 attempts):
- Network errors (DNS, refused, timeout)
- HTTP 5xx
- HTTP 429 (honor `Retry-After`)
- Codex session-start hiccups with recoverable error codes
- Worktree race conditions

**No auto-retry (output / config failures)** — user clicks Retry:
- HTTP 400 (almost always config, not transient)
- Phase 1: no parseable plan
- Phase 2: no PR URL marker
- Auth / permission errors
- Stall detection trigger

### Isolation Guarantees

Two structural rules eliminate the cascade the user has been hitting:

**Per-run isolation.** Each in-flight run reconciles in its own Effect with its own catch boundary. A failure in run A's Phase 1 has zero effect on run B. A Linear write failure for run A has zero effect on run B's writes.

**Per-symptom isolation in the poll loops.** The scheduler tick (intake poll) and the reconciler tick (terminal poll) are independent Effects on independent schedules with independent catch boundaries. A 400 in the scheduler does not stop the reconciler. A 400 in the reconciler does not stop the scheduler. Both keep ticking; failures surface as warnings only.

Implementation pattern: each top-level concern is its own Effect daemon. Failures are caught at the daemon boundary, logged with structured detail, surfaced as PubSub events, and never propagated up to a sibling daemon.

### Stall Detection

Per-run wallclock:
- Reset on every Codex thread event (token usage update, tool call, message delta — any signal of agent progress).
- If `now - last_event > stall_timeout_ms` (default 5 min), kill the Codex turn, mark the run `failed` with reason "stalled".

Identical heuristic to the Elixir reference's `reconcile_stalled_running_issues`.

### Bug Fixes for Current Symptoms

#### Linear 400 — full diagnostic visibility
- Log the full HTTP response body on any non-2xx (currently truncated at 1000 bytes).
- Log the GraphQL operation name and variable types alongside the body.
- Surface the body in the UI banner (collapsed by default; expand to view).
- Banner includes a one-click "open setup wizard" to fix configuration.

#### Linear 400 — auth scheme robustness
The wizard validates on paste, and the runtime client enforces:
- `lin_api_*` → personal key, sent raw.
- `Bearer ...` prefix → strip and warn ("OAuth tokens not supported here").
- JWT-shaped → "this looks like an OAuth token; paste a personal API key (lin_api_*)".
- Empty → fail-fast; never call Linear.

#### Linear 400 — schema field deprecation hint
If Linear returns `GRAPHQL_VALIDATION_FAILED` referencing a known field name (`branchName`, `inverseRelations`, etc.), the error message includes a hint: "Linear's GraphQL schema may have changed; this Symphony build may be incompatible." Surfaces clearly; not auto-retried; user knows to update Symphony.

#### Cascade kill (the symptom 3 fix)
- Scheduler and reconciler are independent Effect daemons.
- A persistent Linear poll 400 leaves: in-flight runs running, the reconciler archiving terminal issues, the UI showing "Linear poll unhealthy" — but does not freeze new-issue intake.

#### Failed-run runaway prevention
- The `lastSeenLinearState` policy in Section "Re-engagement Policy" means a failed run sitting in intake does not auto-recreate.
- User has clear paths: click Retry (in-place fresh attempt), or move the issue out and back into intake (creates a new run record).

### Logging Tiers

| Tier | Audience | Content |
|---|---|---|
| Server log (file/stdout) | Developer / debugging | Full structured: op name, status, body, headers, classification, stack |
| UI dashboard event log | Normal user | Human-readable summary; click to expand to server-log entry |
| Linear comment (optional, default off) | Very loud surface | Major failures only; per-project toggle |

### What we explicitly do not do

- No "Linear is down, run dry" mode. If Linear is unreachable, Symphony shows that loudly.
- No auto-disable of polling on repeated 400s. Surface the error; let the user fix it.
- No global per-project retry budget. Per-attempt caps on transient retries are enough; output failures are human-gated.

## Testing Strategy

### Unit tests (pure modules, no Linear, no Codex, no SQLite)

| Test file | Covers |
|---|---|
| `linear.test.ts` | GraphQL request shape, response parsing, full-body error capture, auth scheme detection, 400/429/5xx classification |
| `scheduler.test.ts` | new-run creation, capacity gating, `lastSeenLinearState` re-engagement edge cases |
| `orchestrator.test.ts` | Phase 1 → Phase 2 transition, marker-found / marker-missing branches, failure classification |
| `reconciler.test.ts` | terminal-state poll → archive decisions |
| `linearWriter.test.ts` | managed comment upsert (idempotent), state transition with version conflicts |
| `threadOutputParser.test.ts` | `parsePlanFromOutput` (found/missing/partial/multiple/nested), `parsePRUrlFromOutput` (found/missing/multiple/malformed/non-GitHub) |
| `prompts.test.ts` | planning + doing prompts produce expected substrings |
| `runModel.test.ts` | status transitions, archive eligibility, `lastSeenLinearState` updates |
| `runLifecycle.test.ts` | status resolution from inputs |
| `workflow.test.ts` | schema parse, defaults, error messages |

### Service-level tests (composition with mocks)

`SymphonyService.test.ts` — mocked Linear, mocked Codex, in-memory repository:

- Happy path: poll → run → Phase 1 → plan posted → Phase 2 → PR posted → in-review.
- Per-run isolation: run A fails, run B unaffected.
- Per-symptom isolation: scheduler poll 400, reconciler keeps working.
- Stall detection: Codex events stop, run failed after timeout.
- Re-engagement: failed run + Linear move-to-todo (state actually changes) → fresh run.
- No re-engagement: failed run + issue still in todo (no transition) → no-op.
- Concurrency: 4 candidates + cap 3 → only 3 dispatched.
- Server restart: orphaned `planning`/`implementing` runs → marked `failed`.

### Contract tests
- `packages/contracts/src/symphony.test.ts` — schema validation for new wizard RPCs; lint-grep verifies deleted RPC method names are not exported anywhere.

### Repository tests
- `SymphonyRepository.test.ts` — SQLite persistence with new `last_seen_linear_state` column; migration applies cleanly; cloud runs auto-archived.

### Browser tests
- Wizard flow: invalid key → error → valid key → project populates → state mapper populates → save → WORKFLOW.md updated.
- Run details drawer: cloud rows absent.
- Issue queue table: "Target" column gone, row actions intact.
- Archive view: sidebar projection unchanged from May 3 design.
- Dashboard event log: Linear 400 banner expands to full body, "open wizard" link works.

### End-to-end (scripted manual, before merge)
1. Wizard configure for a test Linear project.
2. Create a test issue in "To Do" → watch full lifecycle: managed comment → thread starts → Phase 1 plan markers → comment updates → Phase 2 → PR created → comment updates with link → Linear → In Review.
3. Move issue to Done → run archives.
4. Move issue back to Todo → fresh run starts.
5. Break WORKFLOW.md (wrong slugId) → clear error banner with full body.
6. Kill Codex mid-turn → stall detection after 5 min.

### Validation gates (per AGENTS.md, every phase)
`bun fmt && bun lint && bun typecheck && bun run test`

## Deletion Roadmap

Six phases. Each phase passes all gates before proceeding to the next. Each phase is independently revertable.

### Phase 1 — Safe parallel deletes
Files with no incoming references after their direct callers are stripped:
- `apps/server/src/symphony/codexCloud.ts` and `.test.ts`
- `apps/server/src/symphony/lifecyclePhase.ts` (after status-enum collapse)
- Cloud-specific UI components (file-by-file audit in `components/symphony/`)
- `apps/web/src/components/symphony/LinearAuthSettings.tsx` (after merge into wizard)

### Phase 2 — Decompose Layers/SymphonyService.ts
Extract pure modules:
- `scheduler.ts`, `orchestrator.ts`, `reconciler.ts`, `linearWriter.ts`
- `Layers/SymphonyService.ts` becomes the slim composition shell
- Split `Layers/SymphonyService.lifecycle.test.ts` into per-module tests
- Behavioral equivalence: pre/post diffs of test outputs should match

### Phase 3 — Strip cloud branches from kept files
File-by-file:
- `runModel.ts`, `runLifecycle.ts`, `lifecyclePolicy.ts`
- `workflow.ts`, `settingsModel.ts`, `progressComment.ts`
- `packages/contracts/src/symphony.ts`, `packages/shared/src/symphony.ts`
- `apps/web/src/components/symphony/*` (everything not deleted in Phase 1)
- `apps/server/src/git/Layers/GitHubCli.ts` (delete PR helpers)

### Phase 4 — New code
- Wizard components and RPCs
- `prompts.ts` (replacement for `phasePrompts.ts`)
- `threadOutputParser.ts` (replacement for `phaseOutput.ts`)
- Database migration
- Linear client bug fixes (full body logging, auth scheme detection, schema-deprecation hints)
- `lastSeenLinearState` policy implementation

### Phase 5 — Audit and cleanup (the dead-code pass)
- Audit `Layers/GitHubCli.ts` — if zero callers, delete the whole file plus Service interface.
- `fallow` (gstack dead-code analyzer) against the codebase; investigate every reported unused export.
- `bun lint` with strict unused-import rules.
- Manual greps: `grep -ri "cloud" apps/server/src/symphony/ apps/web/src/components/symphony/ packages/`.
- Manual grep: `grep -ri "executionTarget" --exclude-dir=node_modules`.
- `.plans/` audit — flag or remove cloud-related entries.
- `docs/superpowers/specs/` — keep prior cloud-related specs as historical record.
- README and AGENTS.md updates if Symphony is mentioned.

### Phase 6 — Migration and verification
- Apply SQLite migration.
- Verify: cloud runs auto-archived, `last_seen_linear_state` populated from current Linear state, no schema drift.
- Upgrade path: user with old `tracker.projectSlug` sees a clear error directing them to the wizard.
- Manual end-to-end (scripted list above).

### Ordering rationale

Phase 1 first (smallest blast radius, easy revert). Phase 2 is the biggest refactor but is meant to be behavior-preserving (tests verify equivalence). Phases 3 and 4 interleave per file. Phase 5 catches leftovers explicitly — this is the dead-code sweep. Phase 6 is the last step before merge.

## Open Questions

1. **YAML frontmatter format in WORKFLOW.md** — `---`-fenced YAML at the top vs an HTML comment fence. Default: `---` at the top (Hugo/Jekyll convention).

2. **Agent prompt iteration** — planning and doing prompts are stubbed; implementation will iterate based on observed agent marker-emission reliability. Expect 2-3 revisions.

3. **PR-impossible cases** — when the agent legitimately cannot ship a PR (architectural blocker, duplicate issue, no actionable work). Today's design treats it as a Phase 2 failure (no PR URL marker). Future enhancement: a `SYMPHONY_BLOCKED:<reason>` marker → distinct status. Out of scope for v1.

4. **Wizard re-config of an already-configured project** — load existing → allow edit → write back atomically. Edge: project_slug_id changed (Linear project recreated) — surface as warning since in-flight runs reference the old slugId.

5. **Stale managed comment cleanup on cancel/fail** — Default: linearWriter appends a final `(canceled)` or `(failed)` footer; minimal extra logic.

## Risks

| Risk | Mitigation |
|---|---|
| Marker fragility — agents may not emit markers exactly as instructed across model versions | Strong system prompt with examples; fallback parsers (e.g., extract plan from any `## Plan` heading if marker missing); telemetry on parse-success rate. |
| Linear schema drift | Schema-deprecation hints surfaced in 400 errors; explicit field-existence test on first poll after Linear API version changes. |
| Phase 2 refactor risk — decomposing the 4,375-line file could introduce subtle regressions | Behavior-preserving refactor; per-module tests written before extraction; pre/post test snapshots; phase-by-phase merge with revertability. |
| No PR-merge visibility — Symphony loses signal on when work ships | By design; Linear "Done" is the merge signal. Acceptable per the original Symphony spec. |
| Token costs at scale — 2+ Codex turns per run | Concurrency cap (default 3); stall detection; manual stop. Future: per-project budget limits. |
| Wizard requires Linear access at config time | Offline path: hand-edit `WORKFLOW.md` still supported; wizard error surfaces Linear status clearly. |
| Migration auto-archives in-flight cloud runs | Confirmed acceptable. Migration logs the archived runs for audit; nothing is deleted. |

## Acceptance Criteria

### Cleanup
- All files in Phase 1's deletion list are removed.
- All cloud-specific branches in kept files are removed.
- `fallow` reports zero unused exports related to Symphony, Linear, cloud, or GitHub-CLI-PR helpers.
- `grep -ri "cloud" apps/server/src/symphony/ apps/web/src/components/symphony/ packages/` returns no Symphony-related hits.
- `grep -ri "executionTarget" --exclude-dir=node_modules` returns zero hits.

### Bug fixes (the symptoms reported)
- Linear 400 surfaces with full response body in UI banner; banner offers "open wizard" link.
- Linear poll failure does not block the reconciler or in-flight runs (verified by test).
- Issues moved into intake state are picked up reliably on next scheduler tick.
- Failed run sitting in intake does not auto-recreate on every poll.
- `lastSeenLinearState` correctly tracks Linear transitions.

### New behavior
- Wizard validates each step against Linear's API before advancing.
- Wizard never accepts a free-text slugId (always picker).
- Wizard never accepts a free-text state name (always checkbox).
- Phase 1 → Phase 2 → PR creation flow works end-to-end (manual scripted test).
- Linear terminal-state reconciliation archives runs correctly.
- Stall detection fires after `stall_timeout_ms` of no agent progress.
- Concurrency cap is enforced.

### Validation gates
- `bun fmt` clean.
- `bun lint` clean.
- `bun typecheck` clean.
- `bun run test` all pass.
