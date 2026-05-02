import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("030_SymphonyRunArchive", (it) => {
  it.effect("adds archive metadata and monitor index to Symphony runs", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 29 });

      const issueJson = JSON.stringify({
        id: "issue-1",
        identifier: "BC-1",
        title: "Issue one",
        description: null,
        priority: null,
        state: "Done",
        branchName: null,
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      });

      yield* sql`
        INSERT INTO symphony_runs (
          run_id,
          project_id,
          issue_id,
          issue_identifier,
          issue_json,
          status,
          workspace_path,
          branch_name,
          thread_id,
          pr_url,
          execution_target,
          cloud_task_json,
          pull_request_json,
          current_step_json,
          attempts_json,
          next_retry_at,
          last_error,
          created_at,
          updated_at
        )
        VALUES (
          'run-completed',
          'project-1',
          'issue-1',
          'BC-1',
          ${issueJson},
          'completed',
          NULL,
          'symphony/bc-1',
          NULL,
          NULL,
          'codex-cloud',
          NULL,
          NULL,
          NULL,
          '[]',
          NULL,
          NULL,
          '2026-05-02T12:00:00.000Z',
          '2026-05-02T12:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 30 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(symphony_runs)
      `;
      assert.equal(
        columns.some((column) => column.name === "archived_at"),
        true,
      );

      const rows = yield* sql<{ readonly archivedAt: string | null }>`
        SELECT archived_at AS "archivedAt"
        FROM symphony_runs
        WHERE run_id = 'run-completed'
      `;
      assert.strictEqual(rows[0]?.archivedAt, null);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(symphony_runs)
      `;
      assert.equal(
        indexes.some((index) => index.name === "idx_symphony_runs_status_target_archive"),
        true,
      );
    }),
  );
});
