import type {
  SymphonyError,
  SymphonyIssueActionInput,
  SymphonyProjectInput,
  SymphonySecretStatus,
  SymphonySetLinearApiKeyInput,
  SymphonySettings,
  SymphonySnapshot,
  SymphonySubscribeEvent,
  SymphonyUpdateWorkflowPathInput,
  ThreadId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface SymphonyServiceShape {
  readonly getSettings: (
    input: SymphonyProjectInput,
  ) => Effect.Effect<SymphonySettings, SymphonyError>;
  readonly updateWorkflowPath: (
    input: SymphonyUpdateWorkflowPathInput,
  ) => Effect.Effect<SymphonySettings, SymphonyError>;
  readonly createStarterWorkflow: (
    input: SymphonyProjectInput,
  ) => Effect.Effect<SymphonySettings, SymphonyError>;
  readonly validateWorkflow: (
    input: SymphonyProjectInput,
  ) => Effect.Effect<SymphonySettings, SymphonyError>;
  readonly setLinearApiKey: (
    input: SymphonySetLinearApiKeyInput,
  ) => Effect.Effect<SymphonySecretStatus, SymphonyError>;
  readonly testLinearConnection: (
    input: SymphonyProjectInput,
  ) => Effect.Effect<SymphonySecretStatus, SymphonyError>;
  readonly deleteLinearApiKey: (
    input: SymphonyProjectInput,
  ) => Effect.Effect<SymphonySecretStatus, SymphonyError>;
  readonly getSnapshot: (
    input: SymphonyProjectInput,
  ) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly subscribe: (
    input: SymphonyProjectInput,
  ) => Stream.Stream<SymphonySubscribeEvent, SymphonyError>;
  readonly start: (input: SymphonyProjectInput) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly pause: (input: SymphonyProjectInput) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly resume: (input: SymphonyProjectInput) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly refresh: (input: SymphonyProjectInput) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly stopIssue: (
    input: SymphonyIssueActionInput,
  ) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly retryIssue: (
    input: SymphonyIssueActionInput,
  ) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly openLinkedThread: (
    input: SymphonyIssueActionInput,
  ) => Effect.Effect<{ readonly threadId: ThreadId | null }, SymphonyError>;
}

export class SymphonyService extends Context.Service<SymphonyService, SymphonyServiceShape>()(
  "t3/symphony/Services/SymphonyService",
) {}
