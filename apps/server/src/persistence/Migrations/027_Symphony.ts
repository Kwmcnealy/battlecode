import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_settings (
      project_id TEXT PRIMARY KEY,
      workflow_path TEXT NOT NULL,
      workflow_status_json TEXT NOT NULL,
      linear_secret_status_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_runs (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      issue_identifier TEXT NOT NULL,
      issue_json TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_path TEXT,
      branch_name TEXT,
      thread_id TEXT,
      pr_url TEXT,
      attempts_json TEXT NOT NULL,
      next_retry_at TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, issue_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_events (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      run_id TEXT,
      issue_id TEXT,
      event_type TEXT NOT NULL,
      message TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS symphony_runtime_state (
      project_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      last_poll_at TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_runs_project_status
    ON symphony_runs(project_id, status, updated_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_symphony_events_project_created
    ON symphony_events(project_id, created_at)
  `;
});
