import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

function hasColumn(columns: readonly { readonly name: string }[], columnName: string): boolean {
  return columns.some((column) => column.name === columnName);
}

layer("031_SymphonyLifecycleControlPlane", (it) => {
  it.effect("adds lifecycle metadata columns and lookup index after migration 30", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 30 });

      const columnsAfter30 = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(symphony_runs)
      `;
      assert.equal(hasColumn(columnsAfter30, "lifecycle_phase"), false);
      assert.equal(hasColumn(columnsAfter30, "linear_progress_json"), false);
      assert.equal(hasColumn(columnsAfter30, "quality_gate_json"), false);

      yield* runMigrations({ toMigrationInclusive: 31 });

      const columnsAfter31 = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(symphony_runs)
      `;
      assert.equal(hasColumn(columnsAfter31, "lifecycle_phase"), true);
      assert.equal(hasColumn(columnsAfter31, "linear_progress_json"), true);
      assert.equal(hasColumn(columnsAfter31, "quality_gate_json"), true);

      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(symphony_runs)
      `;
      assert.equal(
        indexes.some((index) => index.name === "idx_symphony_runs_lifecycle_phase"),
        true,
      );
    }),
  );
});
