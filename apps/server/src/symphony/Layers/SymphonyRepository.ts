import {
  ProjectId,
  type ProjectId as ProjectIdType,
  SymphonyCloudTask,
  SymphonyEvent,
  SymphonyExecutionTarget,
  SymphonyIssue,
  SymphonyIssueId,
  SymphonyPullRequestSummary,
  SymphonyRun,
  SymphonyRunAttempt,
  SymphonyRunProgress,
  SymphonyRunId,
  SymphonySecretStatus,
  SymphonySettings,
  SymphonyWorkflowValidation,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  toPersistenceDecodeCauseError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
} from "../../persistence/Errors.ts";
import {
  SymphonyRepository,
  type SymphonyRepositoryShape,
  type SymphonyRuntimeStateRow,
} from "../Services/SymphonyRepository.ts";

interface SettingsRow {
  readonly projectId: string;
  readonly workflowPath: string;
  readonly workflowStatus: string;
  readonly linearSecretStatus: string;
  readonly executionDefaultTarget: string;
  readonly updatedAt: string;
}

interface RunRow {
  readonly runId: string;
  readonly projectId: string;
  readonly issue: string;
  readonly status: string;
  readonly workspacePath: string | null;
  readonly branchName: string | null;
  readonly threadId: string | null;
  readonly prUrl: string | null;
  readonly executionTarget: string | null;
  readonly cloudTask: string | null;
  readonly pullRequest: string | null;
  readonly currentStep: string | null;
  readonly attempts: string;
  readonly nextRetryAt: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface EventRow {
  readonly eventId: string;
  readonly projectId: string;
  readonly runId: string | null;
  readonly issueId: string | null;
  readonly type: string;
  readonly message: string;
  readonly payload: string;
  readonly createdAt: string;
}

interface RuntimeStateDbRow {
  readonly projectId: string;
  readonly status: string;
  readonly lastPollAt: string | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

interface ProjectWorkspaceRootRow {
  readonly workspaceRoot: string;
}

const decodeWorkflowValidation = Schema.decodeUnknownSync(SymphonyWorkflowValidation);
const decodeSecretStatus = Schema.decodeUnknownSync(SymphonySecretStatus);
const decodeExecutionTarget = Schema.decodeUnknownSync(SymphonyExecutionTarget);
const decodeCloudTask = Schema.decodeUnknownSync(SymphonyCloudTask);
const decodePullRequest = Schema.decodeUnknownSync(SymphonyPullRequestSummary);
const decodeRunProgress = Schema.decodeUnknownSync(SymphonyRunProgress);
const decodeIssue = Schema.decodeUnknownSync(SymphonyIssue);
const decodeRunAttemptArray = Schema.decodeUnknownSync(Schema.Array(SymphonyRunAttempt));
const decodeRun = Schema.decodeUnknownSync(SymphonyRun);
const decodeEvent = Schema.decodeUnknownSync(SymphonyEvent);

function decodeJson(
  operation: string,
  value: string,
): Effect.Effect<unknown, PersistenceDecodeError> {
  return Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => toPersistenceDecodeCauseError(operation)(cause),
  });
}

function decodeWith<T>(
  operation: string,
  decode: (value: unknown) => T,
  value: unknown,
): Effect.Effect<T, PersistenceDecodeError> {
  return Effect.try({
    try: () => decode(value),
    catch: (cause) => toPersistenceDecodeCauseError(operation)(cause),
  });
}

function decodeProjectId(value: string): Effect.Effect<ProjectIdType, PersistenceDecodeError> {
  return Effect.try({
    try: () => ProjectId.make(value),
    catch: (cause) => toPersistenceDecodeCauseError("SymphonyRepository.decodeProjectId")(cause),
  });
}

function decodeIssueId(value: string): Effect.Effect<SymphonyIssueId, PersistenceDecodeError> {
  return Effect.try({
    try: () => SymphonyIssueId.make(value),
    catch: (cause) => toPersistenceDecodeCauseError("SymphonyRepository.decodeIssueId")(cause),
  });
}

function decodeRunId(value: string): Effect.Effect<SymphonyRunId, PersistenceDecodeError> {
  return Effect.try({
    try: () => SymphonyRunId.make(value),
    catch: (cause) => toPersistenceDecodeCauseError("SymphonyRepository.decodeRunId")(cause),
  });
}

function decodeSettingsRow(
  row: SettingsRow,
): Effect.Effect<SymphonySettings, PersistenceDecodeError> {
  return Effect.gen(function* () {
    const workflowStatusJson = yield* decodeJson(
      "SymphonyRepository.settings.workflowStatus",
      row.workflowStatus,
    );
    const linearSecretJson = yield* decodeJson(
      "SymphonyRepository.settings.linearSecret",
      row.linearSecretStatus,
    );
    const workflowStatus = yield* decodeWith(
      "SymphonyRepository.settings.workflowStatus.decode",
      decodeWorkflowValidation,
      workflowStatusJson,
    );
    const linearSecret = yield* decodeWith(
      "SymphonyRepository.settings.linearSecret.decode",
      decodeSecretStatus,
      linearSecretJson,
    );
    const executionDefaultTarget = yield* decodeWith(
      "SymphonyRepository.settings.executionDefaultTarget.decode",
      decodeExecutionTarget,
      row.executionDefaultTarget,
    );
    return {
      projectId: yield* decodeProjectId(row.projectId),
      workflowPath: row.workflowPath,
      workflowStatus,
      linearSecret,
      executionDefaultTarget,
      updatedAt: row.updatedAt,
    };
  });
}

function decodeRunRow(row: RunRow): Effect.Effect<SymphonyRun, PersistenceDecodeError> {
  return Effect.gen(function* () {
    const issueJson = yield* decodeJson("SymphonyRepository.run.issue", row.issue);
    const attemptsJson = yield* decodeJson("SymphonyRepository.run.attempts", row.attempts);
    const cloudTaskJson =
      row.cloudTask === null
        ? null
        : yield* decodeJson("SymphonyRepository.run.cloudTask", row.cloudTask);
    const pullRequestJson =
      row.pullRequest === null
        ? null
        : yield* decodeJson("SymphonyRepository.run.pullRequest", row.pullRequest);
    const currentStepJson =
      row.currentStep === null
        ? null
        : yield* decodeJson("SymphonyRepository.run.currentStep", row.currentStep);
    const issue = yield* decodeWith("SymphonyRepository.run.issue.decode", decodeIssue, issueJson);
    const attempts = yield* decodeWith(
      "SymphonyRepository.run.attempts.decode",
      decodeRunAttemptArray,
      attemptsJson,
    );
    const executionTarget =
      row.executionTarget === null
        ? null
        : yield* decodeWith(
            "SymphonyRepository.run.executionTarget.decode",
            decodeExecutionTarget,
            row.executionTarget,
          );
    const cloudTask =
      cloudTaskJson === null
        ? null
        : yield* decodeWith(
            "SymphonyRepository.run.cloudTask.decode",
            decodeCloudTask,
            cloudTaskJson,
          );
    const pullRequest =
      pullRequestJson === null
        ? null
        : yield* decodeWith(
            "SymphonyRepository.run.pullRequest.decode",
            decodePullRequest,
            pullRequestJson,
          );
    const currentStep =
      currentStepJson === null
        ? null
        : yield* decodeWith(
            "SymphonyRepository.run.currentStep.decode",
            decodeRunProgress,
            currentStepJson,
          );
    return yield* decodeWith("SymphonyRepository.decodeRunRow", decodeRun, {
      runId: yield* decodeRunId(row.runId),
      projectId: yield* decodeProjectId(row.projectId),
      issue,
      status: row.status,
      workspacePath: row.workspacePath,
      branchName: row.branchName,
      threadId: row.threadId,
      prUrl: row.prUrl,
      executionTarget,
      cloudTask,
      pullRequest,
      currentStep,
      attempts,
      nextRetryAt: row.nextRetryAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  });
}

function decodeEventRow(row: EventRow): Effect.Effect<SymphonyEvent, PersistenceDecodeError> {
  return Effect.gen(function* () {
    const projectId = yield* decodeProjectId(row.projectId);
    const runId = row.runId === null ? null : yield* decodeRunId(row.runId);
    const issueId = row.issueId === null ? null : yield* decodeIssueId(row.issueId);
    const payload = yield* decodeJson("SymphonyRepository.event.payload", row.payload);
    return yield* decodeWith("SymphonyRepository.decodeEventRow", decodeEvent, {
      eventId: row.eventId,
      projectId,
      runId,
      issueId,
      type: row.type,
      message: row.message,
      payload,
      createdAt: row.createdAt,
    });
  });
}

function decodeRuntimeState(
  row: RuntimeStateDbRow,
): Effect.Effect<SymphonyRuntimeStateRow, PersistenceDecodeError> {
  if (
    row.status !== "idle" &&
    row.status !== "running" &&
    row.status !== "paused" &&
    row.status !== "error"
  ) {
    return Effect.fail(
      toPersistenceDecodeCauseError("SymphonyRepository.decodeRuntimeState")(
        new Error(`Invalid runtime state ${row.status}`),
      ),
    );
  }
  const status = row.status;
  return Effect.gen(function* () {
    const projectId = yield* decodeProjectId(row.projectId);
    return {
      projectId,
      status,
      lastPollAt: row.lastPollAt,
      lastError: row.lastError,
      updatedAt: row.updatedAt,
    };
  });
}

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getProjectWorkspaceRoot: SymphonyRepositoryShape["getProjectWorkspaceRoot"] = (projectId) =>
    sql<ProjectWorkspaceRootRow>`
      SELECT workspace_root AS "workspaceRoot"
      FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.getProjectWorkspaceRoot")),
      Effect.map((rows) => rows[0]?.workspaceRoot ?? null),
    );

  const getSettings: SymphonyRepositoryShape["getSettings"] = (projectId) =>
    sql<SettingsRow>`
      SELECT
        project_id AS "projectId",
        workflow_path AS "workflowPath",
        workflow_status_json AS "workflowStatus",
        linear_secret_status_json AS "linearSecretStatus",
        execution_default_target AS "executionDefaultTarget",
        updated_at AS "updatedAt"
      FROM symphony_settings
      WHERE project_id = ${projectId}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.getSettings")),
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row ? decodeSettingsRow(row) : Effect.succeed(null);
      }),
    );

  const upsertSettings: SymphonyRepositoryShape["upsertSettings"] = (settings) =>
    sql`
      INSERT INTO symphony_settings (
        project_id,
        workflow_path,
        workflow_status_json,
        linear_secret_status_json,
        execution_default_target,
        updated_at
      )
      VALUES (
        ${settings.projectId},
        ${settings.workflowPath},
        ${JSON.stringify(settings.workflowStatus)},
        ${JSON.stringify(settings.linearSecret)},
        ${settings.executionDefaultTarget},
        ${settings.updatedAt}
      )
      ON CONFLICT(project_id) DO UPDATE SET
        workflow_path = excluded.workflow_path,
        workflow_status_json = excluded.workflow_status_json,
        linear_secret_status_json = excluded.linear_secret_status_json,
        execution_default_target = excluded.execution_default_target,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.upsertSettings")),
      Effect.as(settings),
    );

  const listRuns: SymphonyRepositoryShape["listRuns"] = (projectId) =>
    sql<RunRow>`
      SELECT
        run_id AS "runId",
        project_id AS "projectId",
        issue_json AS "issue",
        status,
        workspace_path AS "workspacePath",
        branch_name AS "branchName",
        thread_id AS "threadId",
        pr_url AS "prUrl",
        execution_target AS "executionTarget",
        cloud_task_json AS "cloudTask",
        pull_request_json AS "pullRequest",
        current_step_json AS "currentStep",
        attempts_json AS "attempts",
        next_retry_at AS "nextRetryAt",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM symphony_runs
      WHERE project_id = ${projectId}
      ORDER BY updated_at DESC, issue_identifier ASC
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.listRuns")),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRunRow, { concurrency: 8 })),
    );

  const getRunByIssue: SymphonyRepositoryShape["getRunByIssue"] = ({ projectId, issueId }) =>
    sql<RunRow>`
      SELECT
        run_id AS "runId",
        project_id AS "projectId",
        issue_json AS "issue",
        status,
        workspace_path AS "workspacePath",
        branch_name AS "branchName",
        thread_id AS "threadId",
        pr_url AS "prUrl",
        execution_target AS "executionTarget",
        cloud_task_json AS "cloudTask",
        pull_request_json AS "pullRequest",
        current_step_json AS "currentStep",
        attempts_json AS "attempts",
        next_retry_at AS "nextRetryAt",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM symphony_runs
      WHERE project_id = ${projectId} AND issue_id = ${issueId}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.getRunByIssue")),
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row ? decodeRunRow(row) : Effect.succeed(null);
      }),
    );

  const getRunByThreadId: SymphonyRepositoryShape["getRunByThreadId"] = (threadId) =>
    sql<RunRow>`
      SELECT
        run_id AS "runId",
        project_id AS "projectId",
        issue_json AS "issue",
        status,
        workspace_path AS "workspacePath",
        branch_name AS "branchName",
        thread_id AS "threadId",
        pr_url AS "prUrl",
        execution_target AS "executionTarget",
        cloud_task_json AS "cloudTask",
        pull_request_json AS "pullRequest",
        current_step_json AS "currentStep",
        attempts_json AS "attempts",
        next_retry_at AS "nextRetryAt",
        last_error AS "lastError",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM symphony_runs
      WHERE thread_id = ${threadId}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.getRunByThreadId")),
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row ? decodeRunRow(row) : Effect.succeed(null);
      }),
    );

  const upsertRun: SymphonyRepositoryShape["upsertRun"] = (run) =>
    sql`
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
        ${run.runId},
        ${run.projectId},
        ${run.issue.id},
        ${run.issue.identifier},
        ${JSON.stringify(run.issue)},
        ${run.status},
        ${run.workspacePath},
        ${run.branchName},
        ${run.threadId},
        ${run.prUrl},
        ${run.executionTarget},
        ${run.cloudTask ? JSON.stringify(run.cloudTask) : null},
        ${run.pullRequest ? JSON.stringify(run.pullRequest) : null},
        ${run.currentStep ? JSON.stringify(run.currentStep) : null},
        ${JSON.stringify(run.attempts)},
        ${run.nextRetryAt},
        ${run.lastError},
        ${run.createdAt},
        ${run.updatedAt}
      )
      ON CONFLICT(project_id, issue_id) DO UPDATE SET
        issue_identifier = excluded.issue_identifier,
        issue_json = excluded.issue_json,
        status = excluded.status,
        workspace_path = excluded.workspace_path,
        branch_name = excluded.branch_name,
        thread_id = excluded.thread_id,
        pr_url = excluded.pr_url,
        execution_target = excluded.execution_target,
        cloud_task_json = excluded.cloud_task_json,
        pull_request_json = excluded.pull_request_json,
        current_step_json = excluded.current_step_json,
        attempts_json = excluded.attempts_json,
        next_retry_at = excluded.next_retry_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(toPersistenceSqlError("SymphonyRepository.upsertRun")), Effect.as(run));

  const appendEvent: SymphonyRepositoryShape["appendEvent"] = (event) =>
    sql`
      INSERT INTO symphony_events (
        event_id,
        project_id,
        run_id,
        issue_id,
        event_type,
        message,
        payload_json,
        created_at
      )
      VALUES (
        ${event.eventId},
        ${event.projectId},
        ${event.runId},
        ${event.issueId},
        ${event.type},
        ${event.message},
        ${JSON.stringify(event.payload)},
        ${event.createdAt}
      )
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.appendEvent")),
      Effect.as(event),
    );

  const listEvents: SymphonyRepositoryShape["listEvents"] = ({ projectId, limit }) =>
    sql<EventRow>`
      SELECT
        event_id AS "eventId",
        project_id AS "projectId",
        run_id AS "runId",
        issue_id AS "issueId",
        event_type AS "type",
        message,
        payload_json AS "payload",
        created_at AS "createdAt"
      FROM symphony_events
      WHERE project_id = ${projectId}
      ORDER BY created_at DESC, row_id DESC
      LIMIT ${Math.max(1, Math.min(200, Math.floor(limit)))}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.listEvents")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, decodeEventRow, { concurrency: 8 }).pipe(
          Effect.map((events) => events.toReversed()),
        ),
      ),
    );

  const getRuntimeState: SymphonyRepositoryShape["getRuntimeState"] = (projectId) =>
    sql<RuntimeStateDbRow>`
      SELECT
        project_id AS "projectId",
        status,
        last_poll_at AS "lastPollAt",
        last_error AS "lastError",
        updated_at AS "updatedAt"
      FROM symphony_runtime_state
      WHERE project_id = ${projectId}
      LIMIT 1
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.getRuntimeState")),
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row ? decodeRuntimeState(row) : Effect.succeed(null);
      }),
    );

  const listRuntimeStates: SymphonyRepositoryShape["listRuntimeStates"] = () =>
    sql<RuntimeStateDbRow>`
      SELECT
        project_id AS "projectId",
        status,
        last_poll_at AS "lastPollAt",
        last_error AS "lastError",
        updated_at AS "updatedAt"
      FROM symphony_runtime_state
      ORDER BY updated_at DESC
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.listRuntimeStates")),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRuntimeState, { concurrency: 8 })),
    );

  const setRuntimeState: SymphonyRepositoryShape["setRuntimeState"] = (state) =>
    sql`
      INSERT INTO symphony_runtime_state (
        project_id,
        status,
        last_poll_at,
        last_error,
        updated_at
      )
      VALUES (
        ${state.projectId},
        ${state.status},
        ${state.lastPollAt},
        ${state.lastError},
        ${state.updatedAt}
      )
      ON CONFLICT(project_id) DO UPDATE SET
        status = excluded.status,
        last_poll_at = excluded.last_poll_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.mapError(toPersistenceSqlError("SymphonyRepository.setRuntimeState")),
      Effect.as(state),
    );

  return {
    getProjectWorkspaceRoot,
    getSettings,
    upsertSettings,
    listRuns,
    getRunByIssue,
    getRunByThreadId,
    upsertRun,
    appendEvent,
    listEvents,
    getRuntimeState,
    listRuntimeStates,
    setRuntimeState,
  } satisfies SymphonyRepositoryShape;
});

export const SymphonyRepositoryLive = Layer.effect(SymphonyRepository, makeRepository);
