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

  if (!hasColumn(runColumns, "pull_request_json")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN pull_request_json TEXT
    `;
  }

  if (!hasColumn(runColumns, "current_step_json")) {
    yield* sql`
      ALTER TABLE symphony_runs
      ADD COLUMN current_step_json TEXT
    `;
  }
});
