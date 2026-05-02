import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

function hasColumn(columns: readonly { readonly name: string }[], columnName: string): boolean {
  return columns.some((column) => column.name === columnName);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const settingsColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(symphony_settings)
  `;

  if (!hasColumn(settingsColumns, "execution_default_target")) {
    yield* sql`
      ALTER TABLE symphony_settings
      ADD COLUMN execution_default_target TEXT NOT NULL DEFAULT 'local'
    `;
  }

  const runColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(symphony_runs)
  `;

  if (!hasColumn(runColumns, "execution_target")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN execution_target TEXT
    `;
  }

  if (!hasColumn(runColumns, "cloud_task_json")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN cloud_task_json TEXT
    `;
  }

  yield* sql`
    UPDATE symphony_runs
    SET execution_target = 'local'
    WHERE thread_id IS NOT NULL
      AND execution_target IS NULL
  `;

  yield* sql`
    UPDATE symphony_runs
    SET status = 'target-pending'
    WHERE thread_id IS NULL
      AND execution_target IS NULL
      AND status IN ('eligible', 'retry-queued')
  `;
});
