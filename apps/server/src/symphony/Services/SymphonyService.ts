import type {
  SymphonyApplyConfigurationInput,
  SymphonyError,
  SymphonyIssueActionInput,
  SymphonyLaunchIssueInput,
  SymphonyLinearProject,
  SymphonyLinearWorkflowState,
  SymphonyProjectInput,
  SymphonySecretStatus,
  SymphonySetLinearApiKeyInput,
  SymphonySettings,
  SymphonySnapshot,
  SymphonySubscribeEvent,
  SymphonyUpdateWorkflowPathInput,
  ThreadId,
} from "@t3tools/contracts";
import type { ProjectId } from "@t3tools/contracts";
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
  readonly archiveIssue: (
    input: SymphonyIssueActionInput,
  ) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly openLinkedThread: (
    input: SymphonyIssueActionInput,
  ) => Effect.Effect<{ readonly threadId: ThreadId | null }, SymphonyError>;
  readonly launchIssue: (
    input: SymphonyLaunchIssueInput,
  ) => Effect.Effect<SymphonySnapshot, SymphonyError>;
  readonly fetchLinearProjects: (input: {
    readonly projectId: ProjectId;
    readonly apiKey: string;
  }) => Effect.Effect<readonly SymphonyLinearProject[], SymphonyError>;
  readonly fetchLinearWorkflowStates: (input: {
    readonly projectId: ProjectId;
    readonly apiKey: string;
    readonly teamId: string;
  }) => Effect.Effect<readonly SymphonyLinearWorkflowState[], SymphonyError>;
  readonly applyConfiguration: (
    input: SymphonyApplyConfigurationInput,
  ) => Effect.Effect<
    | { readonly ok: true; readonly reloaded: boolean }
    | { readonly ok: false; readonly error: string },
    SymphonyError
  >;
}

export class SymphonyService extends Context.Service<SymphonyService, SymphonyServiceShape>()(
  "t3/symphony/Services/SymphonyService",
) {}
