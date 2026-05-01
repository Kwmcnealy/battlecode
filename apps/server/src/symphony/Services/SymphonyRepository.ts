import type {
  ProjectId,
  SymphonyEvent,
  SymphonyIssueId,
  SymphonyLinearMutation,
  SymphonyRun,
  SymphonyRunStatus,
  SymphonySettings,
  ThreadId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export interface SymphonyRuntimeStateRow {
  readonly projectId: ProjectId;
  readonly status: "idle" | "running" | "paused" | "error";
  readonly lastPollAt: string | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export type SymphonyRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface SymphonyRepositoryShape {
  readonly getProjectWorkspaceRoot: (
    projectId: ProjectId,
  ) => Effect.Effect<string | null, SymphonyRepositoryError>;
  readonly getSettings: (
    projectId: ProjectId,
  ) => Effect.Effect<SymphonySettings | null, SymphonyRepositoryError>;
  readonly upsertSettings: (
    settings: SymphonySettings,
  ) => Effect.Effect<SymphonySettings, SymphonyRepositoryError>;
  readonly listRuns: (
    projectId: ProjectId,
  ) => Effect.Effect<readonly SymphonyRun[], SymphonyRepositoryError>;
  readonly getRunByIssue: (input: {
    readonly projectId: ProjectId;
    readonly issueId: SymphonyIssueId;
  }) => Effect.Effect<SymphonyRun | null, SymphonyRepositoryError>;
  readonly getRunByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<SymphonyRun | null, SymphonyRepositoryError>;
  readonly upsertRun: (run: SymphonyRun) => Effect.Effect<SymphonyRun, SymphonyRepositoryError>;
  readonly updateRunStatus: (input: {
    readonly projectId: ProjectId;
    readonly issueId: SymphonyIssueId;
    readonly status: SymphonyRunStatus;
    readonly lastError?: string | null;
    readonly updatedAt: string;
  }) => Effect.Effect<void, SymphonyRepositoryError>;
  readonly appendEvent: (
    event: SymphonyEvent,
  ) => Effect.Effect<SymphonyEvent, SymphonyRepositoryError>;
  readonly listEvents: (input: {
    readonly projectId: ProjectId;
    readonly limit: number;
  }) => Effect.Effect<readonly SymphonyEvent[], SymphonyRepositoryError>;
  readonly getRuntimeState: (
    projectId: ProjectId,
  ) => Effect.Effect<SymphonyRuntimeStateRow | null, SymphonyRepositoryError>;
  readonly listRuntimeStates: () => Effect.Effect<
    readonly SymphonyRuntimeStateRow[],
    SymphonyRepositoryError
  >;
  readonly setRuntimeState: (
    state: SymphonyRuntimeStateRow,
  ) => Effect.Effect<SymphonyRuntimeStateRow, SymphonyRepositoryError>;
  readonly recordLinearMutation: (input: {
    readonly projectId: ProjectId;
    readonly runId: string | null;
    readonly issueId: SymphonyIssueId;
    readonly mutation: SymphonyLinearMutation;
    readonly result: unknown;
    readonly actor: "user" | "symphony" | "agent";
    readonly createdAt: string;
  }) => Effect.Effect<void, SymphonyRepositoryError>;
}

export class SymphonyRepository extends Context.Service<
  SymphonyRepository,
  SymphonyRepositoryShape
>()("t3/symphony/Services/SymphonyRepository") {}
