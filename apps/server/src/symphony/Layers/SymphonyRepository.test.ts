import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  SymphonyIssueId,
  ThreadId,
  type SymphonyIssue,
  type SymphonyRun,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as NodeSqliteClient from "../../persistence/NodeSqliteClient.ts";
import { SymphonyRepository } from "../Services/SymphonyRepository.ts";
import { LINEAR_INELIGIBLE_LEGACY_ERROR } from "../lifecyclePolicy.ts";
import { makeRun } from "../runModel.ts";
import { SymphonyRepositoryLive } from "./SymphonyRepository.ts";

const CREATED_AT = "2026-05-02T12:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-symphony");
const OTHER_PROJECT_ID = ProjectId.make("project-other");

const layer = it.layer(
  SymphonyRepositoryLive.pipe(Layer.provideMerge(NodeSqliteClient.layerMemory())),
);

function makeIssue(id: string, identifier: string): SymphonyIssue {
  return {
    id: SymphonyIssueId.make(id),
    identifier,
    title: `Issue ${identifier}`,
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

function makeRepositoryRun(
  projectId: ProjectId,
  issue: SymphonyIssue,
  overrides: Partial<SymphonyRun> = {},
): SymphonyRun {
  return {
    ...makeRun(projectId, issue, CREATED_AT),
    ...overrides,
    issue: {
      ...issue,
      ...overrides.issue,
    },
    updatedAt: overrides.updatedAt ?? CREATED_AT,
  };
}

layer("SymphonyRepositoryLive", (it) => {
  it.effect("persists archivedAt on Symphony runs", () =>
    Effect.gen(function* () {
      const repository = yield* SymphonyRepository;
      yield* runMigrations();

      const run = makeRepositoryRun(PROJECT_ID, makeIssue("issue-1", "BC-1"), {
        status: "completed",
        executionTarget: "codex-cloud",
        branchName: "symphony/bc-1",
        archivedAt: "2026-05-02T12:05:00.000Z",
      });

      yield* repository.upsertRun(run);

      const runs = yield* repository.listRuns(PROJECT_ID);
      assert.strictEqual(runs[0]?.archivedAt, "2026-05-02T12:05:00.000Z");
      assert.strictEqual(runs[0]?.status, "completed");
    }),
  );

  it.effect("lists only non-archived active lifecycle runs for monitoring", () =>
    Effect.gen(function* () {
      const repository = yield* SymphonyRepository;
      yield* runMigrations();

      yield* repository.upsertRun(
        makeRepositoryRun(PROJECT_ID, makeIssue("issue-running", "BC-2"), {
          status: "running",
          executionTarget: "local",
          threadId: ThreadId.make("symphony-thread-project-symphony-issue-running"),
        }),
      );
      yield* repository.upsertRun(
        makeRepositoryRun(PROJECT_ID, makeIssue("issue-cloud", "BC-3"), {
          status: "cloud-running",
          executionTarget: "codex-cloud",
        }),
      );
      yield* repository.upsertRun(
        makeRepositoryRun(PROJECT_ID, makeIssue("issue-completed-open", "BC-4"), {
          status: "completed",
          executionTarget: "codex-cloud",
        }),
      );
      yield* repository.upsertRun(
        makeRepositoryRun(PROJECT_ID, makeIssue("issue-archived", "BC-5"), {
          status: "completed",
          executionTarget: "codex-cloud",
          archivedAt: "2026-05-02T12:10:00.000Z",
        }),
      );
      yield* repository.upsertRun(
        makeRepositoryRun(PROJECT_ID, makeIssue("issue-eligible", "BC-6"), {
          status: "eligible",
          executionTarget: "local",
        }),
      );
      yield* repository.upsertRun(
        makeRepositoryRun(PROJECT_ID, makeIssue("issue-recoverable-canceled", "BC-7"), {
          status: "canceled",
          executionTarget: "local",
          lastError: LINEAR_INELIGIBLE_LEGACY_ERROR,
        }),
      );
      yield* repository.upsertRun(
        makeRepositoryRun(PROJECT_ID, makeIssue("issue-user-canceled", "BC-8"), {
          status: "canceled",
          executionTarget: "local",
          lastError: "Canceled from the Symphony dashboard.",
        }),
      );

      const monitoredRuns = yield* repository.listRunsForMonitoring(PROJECT_ID);
      assert.deepStrictEqual(monitoredRuns.map((run) => run.status).toSorted(), [
        "canceled",
        "cloud-running",
        "completed",
        "running",
      ]);
      assert.deepStrictEqual(monitoredRuns.map((run) => run.issue.identifier).toSorted(), [
        "BC-2",
        "BC-3",
        "BC-4",
        "BC-7",
      ]);
    }),
  );

  it.effect("lists distinct project ids with matching active run statuses", () =>
    Effect.gen(function* () {
      const repository = yield* SymphonyRepository;
      yield* runMigrations();

      yield* repository.upsertRun(
        makeRepositoryRun(PROJECT_ID, makeIssue("issue-review", "BC-6"), {
          status: "review-ready",
          executionTarget: "codex-cloud",
        }),
      );
      yield* repository.upsertRun(
        makeRepositoryRun(OTHER_PROJECT_ID, makeIssue("issue-archived-other", "BC-7"), {
          status: "review-ready",
          executionTarget: "codex-cloud",
          archivedAt: "2026-05-02T12:20:00.000Z",
        }),
      );

      const activeProjectIds = yield* repository.listProjectIdsWithRunsInStatuses({
        statuses: ["review-ready"],
      });
      assert.deepStrictEqual(activeProjectIds, [PROJECT_ID]);

      const allProjectIds = yield* repository.listProjectIdsWithRunsInStatuses({
        statuses: ["review-ready"],
        includeArchived: true,
      });
      assert.deepStrictEqual(allProjectIds, [OTHER_PROJECT_ID, PROJECT_ID].toSorted());
    }),
  );
});
