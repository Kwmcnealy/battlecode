import type {
  OrchestrationThread,
  SymphonyPullRequestSummary,
  SymphonyRun,
  SymphonyRunProgress,
  SymphonyRunStatus,
  SymphonyWorkflowConfig,
} from "@t3tools/contracts";

export type LinearStateClassification = "active" | "review" | "done" | "canceled" | "released";
export type PullRequestClassification = "review" | "done" | "closed" | "none";
export type LocalThreadClassification = "running" | "completed" | "failed" | "canceled" | "idle";
export type CloudTaskClassification = "submitted" | "running" | "failed" | "unknown";

export interface LinearLifecycleSignal {
  readonly stateName: string | null;
  readonly updatedAt?: string | null;
}

export interface RunLifecycleInput {
  readonly run: SymphonyRun;
  readonly config: SymphonyWorkflowConfig;
  readonly linear?: LinearLifecycleSignal | null;
  readonly pullRequest?: SymphonyPullRequestSummary | null;
  readonly thread?: Pick<OrchestrationThread, "latestTurn" | "activities" | "session"> | null;
  readonly now?: string;
}

export interface RunLifecycleResult {
  readonly status: SymphonyRunStatus;
  readonly pullRequest: SymphonyPullRequestSummary | null;
  readonly currentStep: SymphonyRunProgress;
}

function includesState(states: readonly string[], value: string | null | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLocaleLowerCase();
  return states.some((state) => state.trim().toLocaleLowerCase() === normalized);
}

function progress(input: {
  readonly source: SymphonyRunProgress["source"];
  readonly label: string;
  readonly detail?: string | null;
  readonly updatedAt: string;
}): SymphonyRunProgress {
  return {
    source: input.source,
    label: input.label,
    detail: input.detail ?? null,
    updatedAt: input.updatedAt,
  };
}

export function classifyLinearState(
  stateName: string | null | undefined,
  tracker: SymphonyWorkflowConfig["tracker"],
): LinearStateClassification {
  if (includesState(tracker.doneStates, stateName)) {
    return "done";
  }
  if (includesState(tracker.canceledStates, stateName)) {
    return "canceled";
  }
  if (includesState(tracker.reviewStates, stateName)) {
    return "review";
  }
  if (includesState(tracker.activeStates, stateName)) {
    return "active";
  }
  return "released";
}

export function classifyPullRequestState(
  pullRequest: SymphonyPullRequestSummary | null | undefined,
): PullRequestClassification {
  if (!pullRequest) {
    return "none";
  }
  if (pullRequest.state === "merged") {
    return "done";
  }
  if (pullRequest.state === "open") {
    return "review";
  }
  return "closed";
}

export function classifyLocalThreadState(
  thread: Pick<OrchestrationThread, "latestTurn"> | null | undefined,
): LocalThreadClassification {
  const latestTurn = thread?.latestTurn ?? null;
  if (!latestTurn) {
    return "idle";
  }
  if (latestTurn.state === "running") {
    return "running";
  }
  if (latestTurn.state === "completed") {
    return "completed";
  }
  if (latestTurn.state === "interrupted") {
    return "canceled";
  }
  return "failed";
}

export function classifyCloudTaskState(run: SymphonyRun): CloudTaskClassification {
  if (run.executionTarget !== "codex-cloud") {
    return "unknown";
  }
  if (run.cloudTask?.status === "failed") {
    return "failed";
  }
  if (run.cloudTask?.status === "detected" || run.cloudTask?.taskUrl) {
    return "running";
  }
  if (run.status === "cloud-submitted" || run.cloudTask?.status === "submitted") {
    return "submitted";
  }
  return "unknown";
}

function latestThreadActivity(
  thread: Pick<OrchestrationThread, "activities"> | null | undefined,
): OrchestrationThread["activities"][number] | null {
  const activities = thread?.activities ?? [];
  return (
    activities.toSorted((left, right) => {
      const bySequence = (right.sequence ?? 0) - (left.sequence ?? 0);
      if (bySequence !== 0) return bySequence;
      return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    })[0] ?? null
  );
}

export function deriveRunProgress(
  input: RunLifecycleInput & { readonly status: SymphonyRunStatus },
): SymphonyRunProgress {
  const now = input.now ?? input.run.updatedAt;
  const pullRequest = input.pullRequest ?? input.run.pullRequest ?? null;
  const prClassification = classifyPullRequestState(pullRequest);
  if (prClassification === "done" && pullRequest) {
    return progress({
      source: "github",
      label: "Pull request merged",
      detail: `#${pullRequest.number} ${pullRequest.title}`,
      updatedAt: pullRequest.updatedAt,
    });
  }
  if (prClassification === "review" && pullRequest) {
    return progress({
      source: "github",
      label: "Pull request open",
      detail: `#${pullRequest.number} ${pullRequest.title}`,
      updatedAt: pullRequest.updatedAt,
    });
  }

  const linearState = input.linear?.stateName ?? input.run.issue.state;
  const linearClassification = classifyLinearState(linearState, input.config.tracker);
  if (linearClassification === "done") {
    return progress({
      source: "linear",
      label: "Linear done state",
      detail: linearState,
      updatedAt: input.linear?.updatedAt ?? now,
    });
  }
  if (linearClassification === "canceled") {
    return progress({
      source: "linear",
      label: "Linear canceled state",
      detail: linearState,
      updatedAt: input.linear?.updatedAt ?? now,
    });
  }
  if (linearClassification === "review") {
    return progress({
      source: "linear",
      label: "Linear review state",
      detail: linearState,
      updatedAt: input.linear?.updatedAt ?? now,
    });
  }

  if (input.run.executionTarget === "codex-cloud") {
    const cloudTask = input.run.cloudTask;
    if (input.status === "failed") {
      return progress({
        source: "codex-cloud",
        label: "Codex Cloud failed",
        detail: cloudTask?.lastMessage ?? input.run.lastError,
        updatedAt: cloudTask?.lastCheckedAt ?? now,
      });
    }
    if (classifyCloudTaskState(input.run) === "running") {
      return progress({
        source: "codex-cloud",
        label: "Codex task detected",
        detail: cloudTask?.taskUrl ?? null,
        updatedAt: cloudTask?.lastCheckedAt ?? now,
      });
    }
    return progress({
      source: "codex-cloud",
      label: "Waiting for Codex Cloud task",
      detail: cloudTask?.linearCommentUrl ?? input.run.issue.url,
      updatedAt: cloudTask?.lastCheckedAt ?? now,
    });
  }

  const threadState = classifyLocalThreadState(input.thread);
  const activity = latestThreadActivity(input.thread);
  if (threadState === "running") {
    return progress({
      source: "local-thread",
      label: "Codex turn running",
      detail: activity?.summary ?? null,
      updatedAt: activity?.createdAt ?? input.thread?.latestTurn?.startedAt ?? now,
    });
  }
  if (threadState === "completed") {
    return progress({
      source: "local-thread",
      label: "Turn completed; waiting for PR or Linear review",
      detail: activity?.summary ?? null,
      updatedAt: input.thread?.latestTurn?.completedAt ?? now,
    });
  }
  if (threadState === "failed") {
    return progress({
      source: "local-thread",
      label: "Codex turn failed",
      detail: input.run.lastError,
      updatedAt: input.thread?.latestTurn?.completedAt ?? now,
    });
  }
  if (threadState === "canceled") {
    return progress({
      source: "local-thread",
      label: "Codex turn interrupted",
      detail: input.run.lastError,
      updatedAt: input.thread?.latestTurn?.completedAt ?? now,
    });
  }

  return progress({
    source: "symphony",
    label: input.status === "target-pending" ? "Waiting for target selection" : "Queued",
    detail: null,
    updatedAt: now,
  });
}

export function resolveRunLifecycle(input: RunLifecycleInput): RunLifecycleResult {
  const pullRequest = input.pullRequest ?? input.run.pullRequest ?? null;
  const prClassification = classifyPullRequestState(pullRequest);
  const linearClassification = classifyLinearState(
    input.linear?.stateName ?? input.run.issue.state,
    input.config.tracker,
  );
  const cloudClassification = classifyCloudTaskState(input.run);
  const threadClassification = classifyLocalThreadState(input.thread);

  const status: SymphonyRunStatus =
    prClassification === "done" || linearClassification === "done"
      ? "completed"
      : linearClassification === "canceled"
        ? "canceled"
        : prClassification === "review" || linearClassification === "review"
          ? "review-ready"
          : cloudClassification === "failed"
            ? "failed"
            : input.run.executionTarget === "codex-cloud" && cloudClassification === "running"
              ? "cloud-running"
              : input.run.executionTarget === "codex-cloud" && cloudClassification === "submitted"
                ? "cloud-submitted"
                : threadClassification === "failed"
                  ? "failed"
                  : threadClassification === "canceled"
                    ? "canceled"
                    : input.run.status;

  return {
    status,
    pullRequest,
    currentStep: deriveRunProgress({ ...input, status }),
  };
}
