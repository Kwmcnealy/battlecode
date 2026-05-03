import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

function hasColumn(columns: readonly { readonly name: string }[], columnName: string): boolean {
  return columns.some((column) => column.name === columnName);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // 1. Auto-archive existing cloud runs (execution_target = 'cloud' or cloud-specific statuses).
  const runColumnsForCheck = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(symphony_runs)
  `;

  if (hasColumn(runColumnsForCheck, "execution_target")) {
    yield* sql`
      UPDATE symphony_runs
      SET status = 'canceled',
          archived_at = COALESCE(archived_at, datetime('now')),
          last_error = COALESCE(last_error, 'Auto-archived during local-only migration; cloud execution is no longer supported')
      WHERE execution_target = 'cloud'
    `;
  }

  // Also archive any runs still in cloud-specific statuses from the old schema.
  yield* sql`
    UPDATE symphony_runs
    SET status = 'canceled',
        archived_at = COALESCE(archived_at, datetime('now')),
        last_error = COALESCE(last_error, 'Auto-archived during local-only migration; cloud execution is no longer supported')
    WHERE status IN ('cloud-submitted', 'cloud-running', 'waiting-cloud-signal')
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
  yield* sql`
    UPDATE symphony_runs
    SET last_seen_linear_state = json_extract(issue_json, '$.state')
    WHERE last_seen_linear_state IS NULL
      AND json_extract(issue_json, '$.state') IS NOT NULL
  `;

  // 4. Drop lifecycle_phase column if present (collapsed into status in Task 4.6).
  // Must drop the index created by migration 031 first, or SQLite will refuse the column drop.
  if (hasColumn(runColumns, "lifecycle_phase")) {
    yield* sql`
      DROP INDEX IF EXISTS idx_symphony_runs_lifecycle_phase
    `;
    yield* sql`
      ALTER TABLE symphony_runs
      DROP COLUMN lifecycle_phase
    `;
  }

  // 5. Drop cloud columns (SQLite supports DROP COLUMN since 3.35).
  // Must drop the index created by migration 030 that references execution_target.
  if (hasColumn(runColumns, "execution_target")) {
    yield* sql`
      DROP INDEX IF EXISTS idx_symphony_runs_status_target_archive
    `;
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

  // 6. Drop execution_default_target from settings if present.
  const settingsColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(symphony_settings)
  `;

  if (hasColumn(settingsColumns, "execution_default_target")) {
    yield* sql`
      ALTER TABLE symphony_settings
      DROP COLUMN execution_default_target
    `;
  }

  // 7. Drop quality_gate columns added in migration 031 (linear_progress_json,
  //    quality_gate_json are still used but lifecycle_phase was already dropped above).
  // Note: linear_progress_json and quality_gate_json are kept.

  // 8. Index on last_seen_linear_state for the scheduler query.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_runs_last_seen_state
    ON symphony_runs(project_id, last_seen_linear_state)
  `;
});
