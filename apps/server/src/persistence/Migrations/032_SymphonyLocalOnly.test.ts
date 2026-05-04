import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

// Each "layer" call creates a fresh in-memory DB for its test group.

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "column presence after migration 32",
  (it) => {
    it.effect("adds last_seen_linear_state and drops cloud/lifecycle columns", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 32 });

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(symphony_runs)
        `;
        const names = columns.map((c) => c.name);

        assert.equal(
          names.includes("last_seen_linear_state"),
          true,
          "last_seen_linear_state present",
        );
        assert.equal(names.includes("execution_target"), false, "execution_target dropped");
        assert.equal(names.includes("cloud_task_json"), false, "cloud_task_json dropped");
        assert.equal(names.includes("lifecycle_phase"), false, "lifecycle_phase dropped");
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))("auto-archive cloud runs", (it) => {
  it.effect("auto-archives existing cloud runs on migration 32", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Run 1-31 so execution_target column exists.
      yield* runMigrations({ toMigrationInclusive: 31 });

      yield* sql`
          INSERT INTO symphony_runs (
            run_id, project_id, issue_id, issue_identifier, issue_json,
            status, execution_target, archived_at, attempts_json,
            created_at, updated_at
          )
          VALUES (
            'r1', 'p1', 'i1', 'ENG-1', '{"id":"i1","state":"In Progress"}',
            'running', 'cloud', NULL, '[]',
            '2026-05-03T10:00:00Z', '2026-05-03T10:00:00Z'
          )
        `;

      // Now apply migration 32.
      yield* runMigrations({ toMigrationInclusive: 32 });

      const rows = yield* sql<{ readonly status: string; readonly archived_at: string | null }>`
          SELECT status, archived_at FROM symphony_runs WHERE run_id = 'r1'
        `;
      assert.equal(rows[0]?.status, "canceled");
      assert.notEqual(rows[0]?.archived_at, null);
    }),
  );
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "backfill last_seen_linear_state",
  (it) => {
    it.effect("backfills last_seen_linear_state from issue_json", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // Run 1-31 so the table exists but no last_seen_linear_state yet.
        yield* runMigrations({ toMigrationInclusive: 31 });

        yield* sql`
          INSERT INTO symphony_runs (
            run_id, project_id, issue_id, issue_identifier, issue_json,
            status, archived_at, attempts_json,
            created_at, updated_at
          )
          VALUES (
            'r2', 'p1', 'i2', 'ENG-2', '{"id":"i2","identifier":"ENG-2","title":"T","state":"In Progress","labels":[],"blockedBy":[]}',
            'running', NULL, '[]',
            '2026-05-03T10:00:00Z', '2026-05-03T10:00:00Z'
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 32 });

        const rows = yield* sql<{ readonly last_seen_linear_state: string | null }>`
          SELECT last_seen_linear_state FROM symphony_runs WHERE run_id = 'r2'
        `;
        assert.equal(rows[0]?.last_seen_linear_state, "In Progress");
      }),
    );
  },
);
