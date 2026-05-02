import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("028_SymphonyExecutionTargets", (it) => {
  it.effect("adds execution target columns and backfills existing Symphony rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const issueJson = JSON.stringify({
        id: "issue-1",
        identifier: "BC-1",
        title: "Issue one",
        description: null,
        priority: null,
        state: "Todo",
        branchName: null,
        url: null,
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      });

      yield* runMigrations({ toMigrationInclusive: 27 });
      yield* sql`
        INSERT INTO symphony_settings (
          project_id,
          workflow_path,
          workflow_status_json,
          linear_secret_status_json,
          updated_at
        )
        VALUES (
          'project-1',
          '/tmp/project/WORKFLOW.md',
          '{"status":"valid","message":null,"validatedAt":null,"configHash":null}',
          '{"source":"missing","configured":false,"lastTestedAt":null,"lastError":null}',
          '2026-04-30T12:00:00.000Z'
        )
      `;
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
          attempts_json,
          next_retry_at,
          last_error,
          created_at,
          updated_at
        )
        VALUES
          (
            'run-local',
            'project-1',
            'issue-local',
            'BC-1',
            ${issueJson},
            'running',
            '/tmp/worktree',
            'bc-1',
            'symphony-thread-project-1-issue-local',
            NULL,
            '[]',
            NULL,
            NULL,
            '2026-04-30T12:00:00.000Z',
            '2026-04-30T12:00:00.000Z'
          ),
          (
            'run-pending',
            'project-1',
            'issue-pending',
            'BC-2',
            ${issueJson},
            'eligible',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]',
            NULL,
            NULL,
            '2026-04-30T12:00:00.000Z',
            '2026-04-30T12:00:00.000Z'
          ),
          (
            'run-retry',
            'project-1',
            'issue-retry',
            'BC-3',
            ${issueJson},
            'retry-queued',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]',
            NULL,
            'try again',
            '2026-04-30T12:00:00.000Z',
            '2026-04-30T12:00:00.000Z'
          )
      `;

      yield* runMigrations({ toMigrationInclusive: 28 });

      const settingsRows = yield* sql<{ readonly executionDefaultTarget: string }>`
        SELECT execution_default_target AS "executionDefaultTarget"
        FROM symphony_settings
        WHERE project_id = 'project-1'
      `;
      assert.strictEqual(settingsRows[0]?.executionDefaultTarget, "local");

      const runs = yield* sql<{
        readonly runId: string;
        readonly status: string;
        readonly executionTarget: string | null;
        readonly cloudTask: string | null;
      }>`
        SELECT
          run_id AS "runId",
          status,
          execution_target AS "executionTarget",
          cloud_task_json AS "cloudTask"
        FROM symphony_runs
        ORDER BY run_id
      `;
      assert.deepStrictEqual(runs, [
        {
          runId: "run-local",
          status: "running",
          executionTarget: "local",
          cloudTask: null,
        },
        {
          runId: "run-pending",
          status: "target-pending",
          executionTarget: null,
          cloudTask: null,
        },
        {
          runId: "run-retry",
          status: "target-pending",
          executionTarget: null,
          cloudTask: null,
        },
      ]);
    }),
  );
});
