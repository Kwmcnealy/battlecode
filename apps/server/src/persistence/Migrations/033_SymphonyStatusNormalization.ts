import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Normalize legacy SymphonyRunStatus values to the 7-value enum from
 * Phase 4 Task 4.6. Migration 032 dropped cloud columns and archived
 * cloud runs, but did not normalize statuses like `running`, `eligible`,
 * `released`, `retry-queued`, `target-pending`, or `review-ready`.
 *
 * Without this normalization, listRuns() fails to decode legacy rows
 * (the SymphonyRunStatus schema rejects them), which surfaces as
 * "Failed to load Symphony runs" in the dashboard.
 *
 * Mapping:
 *   running         -> implementing
 *   eligible        -> intake
 *   target-pending  -> intake
 *   retry-queued    -> failed
 *   released        -> canceled
 *   review-ready    -> in-review
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`UPDATE symphony_runs SET status = 'implementing' WHERE status = 'running'`;
  yield* sql`UPDATE symphony_runs SET status = 'intake' WHERE status IN ('eligible', 'target-pending')`;
  yield* sql`UPDATE symphony_runs SET status = 'failed' WHERE status = 'retry-queued'`;
  yield* sql`UPDATE symphony_runs SET status = 'canceled' WHERE status = 'released'`;
  yield* sql`UPDATE symphony_runs SET status = 'in-review' WHERE status = 'review-ready'`;
});
