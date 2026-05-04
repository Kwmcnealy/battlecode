# Symphony Archive Run Cleanup Design

> **Note:** The archive-on-terminal-state behavior described here is preserved in the local-only
> redesign (`docs/superpowers/specs/2026-05-03-symphony-local-only-redesign-design.md`). References
> to "cloud execution" in this document are historical; Symphony is now local-only.

## Goal

Give users a reliable way to clear stale Symphony issues without changing Linear state, while also making terminal Linear and GitHub signals automatically move finished or canceled runs into the local Archive bucket.

The Archive bucket is a Symphony UI and persistence concern. It removes runs from active Symphony views and the sidebar, but it does not delete run history or hide details from the Archived tab.

## Problem

Symphony already has archive storage and an Archived view, but stale runs can remain visible in active queues and the sidebar when their Linear or GitHub truth is already terminal. Users also need an explicit cleanup action for issues that are no longer useful to keep in active intake, failed, canceled, released, or review-ready lanes.

The current behavior is not enough because:

- Users need a manual "Archive" action for inactive runs.
- Manual archive must be local-only and must not mutate Linear.
- Automatically reconciled terminal states should archive both completed and canceled runs.
- Archived runs must disappear from the sidebar and active Symphony queues.
- Archived details should still be available in the Archived tab.

## Approved Direction

Use archive action plus reconciliation hardening.

This keeps the existing Symphony Archive bucket and adds the missing user control and terminal-state cleanup. It is intentionally smaller than a broad cleanup sweep and safer than trying to infer archive intent from every non-active status.

The approved behavior is:

- Manual archive is local-only.
- Manual archive never moves the Linear issue.
- Manual archive never stops agents, closes PRs, or edits the managed Linear progress comment.
- Terminal Linear and GitHub reconciliation can archive automatically.
- Retry reopens the local Symphony run by clearing `archivedAt`.
- Symphony remains the owner of workflow state and comments for both local and cloud execution.

## Non-Goals

This design does not delete runs or issue history.

This design does not add a Linear "Archived" state.

This design does not make manual archive a replacement for Stop. If Symphony is actively working on a run, the user must stop it first.

This design does not require changes to the Linear managed progress comment when the user only archives locally.

This design does not change the existing local/cloud execution model. Archive applies to Symphony's run record regardless of execution target.

## Lifecycle Rules

Archive is represented by `archivedAt`.

The run remains inspectable after archive. The archived timestamp only changes which bucket and sidebar projections include the run.

Automatic archive should happen when external truth is terminal:

- Linear `done_states` maps to completed and archives the run.
- Linear `canceled_states` maps to canceled and archives the run.
- GitHub PR merged maps to completed, moves Linear to Done when configured, and archives the run.
- GitHub PR closed without merge maps to canceled, moves Linear to Canceled when configured, and archives the run.

Manual archive should be allowed only when Symphony is not actively working on the run.

Allowed manual archive statuses or phases:

- Intake or target-pending
- Eligible
- Failed
- Canceled
- Done or completed
- Released
- Review-ready when no active execution is in flight
- Other inactive stale states that have no running provider thread or cloud execution

Disallowed manual archive statuses or phases:

- Planning
- Implementing
- Simplifying
- Reviewing
- Fixing
- Waiting for cloud execution
- Any status that means Symphony is currently executing or waiting on an active run turn

The server is the authority for archive eligibility. The UI can hide the button for convenience, but the server must reject active archive attempts.

## UI Behavior

Keep the existing Active and Archived segmented control in the Symphony tab.

Add an Archive action to inactive rows in the active queue. The action should appear near existing row actions such as Details, Retry, Stop, PR, and Refresh Cloud. Use an icon button with an accessible label and tooltip consistent with the existing Symphony row action style.

When the user archives a run:

1. The row disappears from Active.
2. The row appears in Archived.
3. The row disappears from the sidebar projection.
4. The current Symphony snapshot updates without a full sidebar refresh.
5. The Archived tab continues to allow Details inspection.

The Archive button should not be shown for active execution phases. If the UI is stale and the user still triggers archive while a run is active, the server should reject the request with a clear error:

`Cannot archive a run while Symphony is actively working on it. Stop it first.`

Archived rows should not need a separate unarchive action in the first version. Retry is the reactivation path and should clear `archivedAt` as part of the existing retry reset.

## Sidebar Behavior

The sidebar should continue to project only unarchived Symphony runs.

The expected invariant is:

- `archivedAt === null` can appear in Active and sidebar projections.
- `archivedAt !== null` appears only in Archived and detail surfaces.

No new sidebar control is required. The implementation should make sure archive updates are emitted through the same snapshot path as other Symphony updates so the sidebar changes smoothly and does not flicker.

## Backend and Contracts

Add a new Symphony RPC:

- `symphony.archiveIssue`

Request shape:

- `projectId`
- `issueId`

Response:

- Fresh Symphony snapshot for the project, matching the existing service pattern used by run actions.

Server flow:

1. Web calls `archiveIssue({ projectId, issueId })`.
2. The server loads the current run for the issue.
3. The server checks centralized archive eligibility.
4. If already archived, return the current fresh snapshot without error.
5. If active, reject with the explicit active-run error.
6. If inactive, set `archivedAt` to the current time.
7. Preserve status, lifecycle, metadata, attempts, current step, PR links, Linear links, and execution target history.
8. Emit a domain event such as `run.archived` or `issue.archived`.
9. Return a fresh snapshot.

The contract updates should include:

- Shared schema method constant for `archiveIssue`.
- IPC request/response definitions.
- Native API client method.
- WebSocket/server handler wiring.
- Web service wrapper consumed by the Symphony UI.

## Shared Archive Eligibility

Archive eligibility should live in one shared Symphony policy helper instead of being duplicated in UI and server code.

The helper should answer two questions:

- Can this run be archived now?
- Why not, when archive is blocked?

The UI can use the helper to decide whether to render the Archive action. The server must also use the helper before mutating persistence.

Implementation should prefer the existing lifecycle/status helpers if they already describe active phases. If a new helper is needed, keep it close to the existing Symphony run lifecycle policy code so reconciliation, service actions, and UI projections all use the same semantics.

## Reconciliation Changes

Terminal reconciliation should archive both completed and canceled runs.

The existing reconciliation rule should become:

- Archive when the resolved status is completed.
- Archive when the resolved status is canceled.
- Do not archive active, failed, eligible, intake, review-ready, or released states unless the user manually archives them.

Linear terminal state should win even when the local run is stale, intake-only, failed, eligible, released, or has no linked thread. If Linear says the issue is Done, the local run should become completed and archived. If Linear says the issue is Canceled or Cancelled, the local run should become canceled and archived.

GitHub PR reconciliation remains authoritative for PR lifecycle:

- Merged PR archives as completed.
- Closed unmerged PR archives as canceled.
- Open PR keeps the run visible in active review/in-review views.

If Linear or GitHub lookup fails, Symphony should not guess terminal state. It should keep the existing run state and surface the refresh failure through the current error/reporting path.

## Edge Cases

Already archived:

- Return the current snapshot without error.

Active run:

- Reject archive with `Cannot archive a run while Symphony is actively working on it. Stop it first.`

Archived issue moved back to In Progress in Linear:

- Do not automatically unarchive. Manual archive is a user cleanup choice. The user can Retry when they want Symphony to work on it again.

Retry archived run:

- Clear `archivedAt`.
- Reset the run through the existing retry semantics.
- Return the run to active projections.

Stop active run:

- Stop remains the action that cancels active work and owns Linear cancellation behavior. Archive remains local-only.

Terminal Linear state with no thread or PR:

- Archive according to Linear state.

Terminal Linear state after failed run:

- Archive according to Linear state.

Review-ready stale run:

- Allow manual archive if no active execution is in flight.

Cloud run waiting for signal:

- Do not allow manual archive while Symphony considers it active or waiting on cloud execution. The user should Stop first.

## Testing Strategy

Contract tests should verify:

- The new `archiveIssue` RPC method is part of the Symphony IPC/native API contract.
- Request validation requires `projectId` and `issueId`.
- Response validation matches the normal Symphony snapshot shape.

Server tests should verify:

- Manual archive succeeds for an inactive run.
- Manual archive preserves status, lifecycle, PR metadata, Linear metadata, attempt history, and current step.
- Manual archive is idempotent for already archived runs.
- Manual archive rejects active planning, implementation, simplification, review, fix, and waiting-cloud phases.
- Linear Done reconciliation archives stale, intake, eligible, failed, released, and no-thread runs.
- Linear Canceled or Cancelled reconciliation archives stale, intake, eligible, failed, released, and no-thread runs.
- Merged PR reconciliation archives as completed.
- Closed unmerged PR reconciliation archives as canceled.
- Retry clears `archivedAt`.

Web tests should verify:

- Archive button appears only on inactive active rows.
- Archive button does not appear on active execution rows.
- Clicking Archive moves the row from Active to Archived.
- Archived runs are still inspectable from the Archived tab.
- Archived runs are absent from sidebar projection.
- Sidebar smoothness behavior remains intact when snapshots update quickly.

Validation for implementation should use the repo's required gates:

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `bun run test`

If implementation touches only documentation in a separate step, record why code validation was skipped.

## Implementation Boundaries

Keep the first implementation focused on archive correctness:

- Add the RPC.
- Add the centralized eligibility helper.
- Add the row action.
- Fix completed/canceled auto-archive reconciliation.
- Preserve the existing Archived tab and sidebar projection model.
- Add focused tests.

Avoid unrelated Symphony UI redesign, cleanup sweeps, or changes to how planning, implementation, review, PR creation, or Linear comments work.

## Acceptance Criteria

The design is complete when:

- Inactive rows can be archived manually from Symphony.
- Active execution rows cannot be archived manually.
- Manual archive is local-only and does not mutate Linear.
- Done and canceled terminal reconciliation archives automatically.
- Archived rows are removed from Active queues and the sidebar.
- Archived rows remain visible and inspectable from the Archived tab.
- Retry clears archive state.
- Tests cover the archive action, terminal reconciliation, and sidebar filtering.
