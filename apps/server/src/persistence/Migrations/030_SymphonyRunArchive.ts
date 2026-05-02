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

  if (!hasColumn(runColumns, "archived_at")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN archived_at TEXT
    `;
  }

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_runs_status_target_archive
    ON symphony_runs(status, execution_target, archived_at, project_id)
  `;
});
