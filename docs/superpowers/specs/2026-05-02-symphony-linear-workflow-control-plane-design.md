# Symphony Linear Workflow Control Plane Design

> **SUPERSEDED** by `docs/superpowers/specs/2026-05-03-symphony-local-only-redesign-design.md`.
> The cloud/local hybrid lifecycle model described here was replaced by the local-only redesign.
> This document is kept as a historical record only — do not implement it.

## Goal

Make Symphony the normal control plane for future work. Linear remains the human-visible tracker, but Symphony owns the workflow truth for each ticket across local and cloud execution.

The target Linear workflow is:

- `Backlog`: not initiated
- `To Do`: Symphony intake state
- `In Progress`: active agent work, including implementation, simplification, review, and rework
- `In Review`: PR is open and waiting for human review or merge
- `Done`: PR merged
- `Canceled`: issue or PR closed without continuing work

When Symphony sees an issue in `To Do`, it should immediately plan the work, make that plan visible in Linear, move the issue to `In Progress`, and start the configured execution target.

## Approved Direction

Use a Symphony-owned workflow state machine. Do not rely on the agent prompt alone to remember lifecycle steps.

Symphony app code owns:

- Linear status transitions
- One managed progress comment per issue
- Short milestone comments for major state changes
- Agent phase sequencing
- PR creation and PR status reconciliation
- Rework detection and reruns
- Unified local/cloud status in the Symphony tab and sidebar

`WORKFLOW.md` remains required. It becomes declarative repo configuration and prompt guidance rather than the lifecycle executor.

## WORKFLOW.md Role

`WORKFLOW.md` should continue to define repository-specific workflow settings:

- Linear state names for intake, active, review, done, and canceled
- PR base branch
- Validation commands
- Agent instructions and repo rules
- Local and cloud execution defaults
- Quality gate behavior, retry limits, and optional hooks

The important boundary is:

- Symphony enforces the lifecycle.
- `WORKFLOW.md` configures how the lifecycle should run for a repo.
- Agents perform code work inside the phase Symphony assigns.

## Architecture

Symphony becomes a first-class workflow controller, not just a launcher or status display.

The canonical lifecycle is:

`To Do -> Planning -> In Progress -> Implementing -> Simplifying -> Reviewing -> PR Ready -> In Review -> Done/Canceled`

Linear, GitHub, local provider threads, and Codex Cloud all become signal sources into this lifecycle. Symphony translates those signals into one canonical run state and publishes that state to the UI and Linear.

Local and cloud should share the same lifecycle. The only difference is the execution adapter used for code work:

- Local: T3 Code creates or resumes a local Symphony thread.
- Cloud: Symphony delegates code work to Codex Cloud through Linear while Symphony still owns comments, state transitions, PR reconciliation, and dashboard state.

## Components

### Workflow Config

Extend the parsed `WORKFLOW.md` config with explicit lifecycle settings:

- Intake state, default `To Do`
- Active state, default `In Progress`
- Review state, default `In Review`
- Done states, default `Done`
- Canceled states, default `Canceled` and `Cancelled`
- PR base branch, default from repo config when not set
- Validation commands
- Simplification phase prompt or skill
- Review phase prompt or skill
- Rework triggers and retry limits

### Symphony Lifecycle Controller

Add a server-side coordinator that chooses the next action for each run.

It should handle transitions such as:

- Issue enters `To Do`
- Planning starts
- Plan is posted to Linear
- Issue moves to `In Progress`
- Implementation starts
- Simplification starts
- Review starts
- Review fails and fix work is queued
- Review passes and PR creation starts
- PR opens
- PR merges
- PR closes without merge
- Linear issue moves back to `In Progress`
- New Linear or GitHub feedback appears
- Issue is canceled

### Linear Progress Comment Manager

Create and update one clearly marked managed comment on the Linear issue. This comment is the current source of truth for humans.

It should include:

- Current Symphony status
- Last update
- Execution target, local or cloud
- Active phase
- Checklist plan
- Current phase result
- Review findings
- PR link and state
- Rework feedback summary when applicable

Symphony should also write short milestone comments for major events:

- Plan posted
- Implementation started
- PR opened
- Rework requested
- Merged
- Closed or canceled

### Agent Phase Runner

Split work into separate phases:

- Planning
- Implementation
- Simplification
- Review
- Fix or rework

The planning phase produces the checklist that Symphony writes into the managed Linear comment. The simplification and review phases must be separate follow-up agent turns before PR creation.

If review finds issues, Symphony should keep the Linear issue in `In Progress`, update the managed comment, run one fix turn, then rerun simplification and review. PR creation should happen only after review passes.

### PR Reconciler

Detect and reconcile GitHub PR state:

- Open PR: move Linear to `In Review`
- Merged PR: move Linear to `Done`
- Closed PR without merge: move Linear to `Canceled`, unless the issue has already been pushed back to `In Progress`

PR creation should target the configured base branch. For this user's recurring BattleTCG workflow, that is usually `development`, but the design should keep the value repo-configurable.

### Symphony UI

The Symphony tab and sidebar should display canonical lifecycle phases, not only low-level execution states.

Expected visible statuses include:

- Planning
- Implementing
- Simplifying
- Reviewing
- Fixing
- In Review
- Done
- Canceled
- Waiting for cloud signal
- Blocked or failed

Click behavior remains target-aware:

- Local runs with linked threads open the local chat thread.
- Cloud runs open Symphony run details and cloud/Linear/PR links.

## Data Flow

1. Symphony polls Linear for issues in the configured intake state, `To Do`.
2. Symphony creates or refreshes the run record.
3. Symphony starts a planning phase.
4. The planning phase produces a comprehensive checklist.
5. Symphony writes or updates the managed Linear progress comment.
6. Symphony writes a short milestone comment that the plan was posted.
7. Symphony moves the Linear issue to `In Progress`.
8. Symphony starts implementation using the configured target, local or cloud.
9. After implementation completes, Symphony runs a separate simplification phase.
10. After simplification completes, Symphony runs a separate review phase.
11. If review finds issues, Symphony updates the managed comment, runs one fix phase, and repeats simplification and review.
12. Once review is clean, Symphony creates or updates a PR.
13. PR open moves Linear to `In Review`.
14. New Linear feedback, GitHub review comments, or Linear moving back to `In Progress` triggers rework.
15. PR merged moves Linear to `Done`.
16. PR closed without merge moves Linear to `Canceled`.

The invariant is: agents do code work; Symphony owns lifecycle truth.

## Rework Handling

After a PR is in `In Review`, any of these should push the ticket back into rework:

- Linear issue is moved back to `In Progress`
- New Linear comment appears after the last known review milestone
- GitHub PR review requests changes
- GitHub PR comments indicate requested changes

Symphony should gather the feedback, summarize it in the managed comment, run a fix phase, rerun simplification and review, then update the PR branch.

## Error Handling

Failures should become visible workflow states, not silent dead ends.

Planning failure keeps the issue in `To Do` unless a future configured blocked/error state is added. The managed comment records the error and retry option.

Implementation, simplification, review, and fix failures keep the issue in `In Progress`. Symphony updates the managed comment with the failed phase, error summary, and retry state.

Review findings are not failures. They are normal workflow feedback and should trigger the fix loop.

PR creation failure keeps the issue in `In Progress`, records the failure in the managed comment, and exposes retry from the Symphony tab.

Linear cancellation stops local work when possible, marks the run canceled, updates the managed comment, and writes a cancellation milestone.

Cloud ambiguity should stay visible as a waiting state. If Codex Cloud has not produced a clear task or PR signal, Symphony should show `Waiting for cloud signal` rather than assuming completion.

## Testing Strategy

Config and schema tests should verify the new lifecycle config parses from `WORKFLOW.md`, defaults are correct, and the user's Linear states map cleanly.

State-machine tests should cover:

- `To Do` intake to plan posting
- Plan posting to `In Progress`
- Implementation completion
- Simplification phase
- Review clean
- Review failed then fix
- PR open to `In Review`
- PR merged to `Done`
- PR closed to `Canceled`
- Linear moved back to `In Progress`
- New Linear comment rework
- GitHub review feedback rework

Service tests should mock Linear, GitHub, local provider threads, and cloud delegation. They should verify managed comments, milestone comments, Linear state transitions, PR creation, and local/cloud parity.

UI/browser tests should verify the Symphony tab and sidebar show canonical phase/status labels and route local/cloud runs to the expected destinations.

Before implementation is considered complete, use the repo's required gates:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `bun run test`

If implementation touches only documentation, record why code validation was skipped.

## Non-Goals

This design does not remove `WORKFLOW.md`.

This design does not make Codex Cloud own Linear workflow updates. Symphony owns those updates for both cloud and local execution.

This design does not require a new Linear state beyond the user's current states. Future blocked/error states can be added later, but the first version should work with `To Do`, `In Progress`, `In Review`, `Done`, and `Canceled`.

This design does not require agents to update Linear directly. Agents can report outcomes through their phase output; Symphony should translate that into Linear comments and state transitions.
