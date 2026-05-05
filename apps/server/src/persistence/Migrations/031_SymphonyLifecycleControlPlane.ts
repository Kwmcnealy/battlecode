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
