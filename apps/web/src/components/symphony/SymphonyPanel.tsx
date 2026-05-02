import { WorkflowIcon } from "lucide-react";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EnvironmentId,
  ProjectId,
  SymphonyExecutionTarget,
  SymphonyRun,
  SymphonySnapshot,
} from "@t3tools/contracts";

import { ensureEnvironmentApi } from "../../environmentApi";
import { useUiStateStore } from "../../uiStateStore";
import { Badge } from "../ui/badge";
import { Spinner } from "../ui/spinner";
import { IssueQueueTable } from "./IssueQueueTable";
import { RunDetailsDrawer } from "./RunDetailsDrawer";
import { SymphonyEventTimeline } from "./SymphonyEventTimeline";
import type { SymphonyAction } from "./symphonyDisplay";
import { SymphonyToolbar } from "./SymphonyToolbar";
import { WorkflowStatus } from "./WorkflowStatus";

interface SymphonyPanelProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  projectName: string;
  projectCwd: string;
  onOpenThread: (threadId: NonNullable<SymphonyRun["threadId"]>) => void;
}

export function SymphonyPanel({
  environmentId,
  projectId,
  projectName,
  projectCwd,
  onOpenThread,
}: SymphonyPanelProps) {
  const [snapshot, setSnapshot] = useState<SymphonySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<SymphonyAction | null>(null);
  const [linkedThreadBusy, setLinkedThreadBusy] = useState(false);
  const api = useMemo(() => ensureEnvironmentApi(environmentId), [environmentId]);
  const projectKey = useMemo(
    () => scopedProjectKey(scopeProjectRef(environmentId, projectId)),
    [environmentId, projectId],
  );
  const selectedRunId = useUiStateStore(
    (state) => state.selectedSymphonyRunByProjectKey[projectKey] ?? null,
  );
  const setSelectedSymphonyRun = useUiStateStore((state) => state.setSelectedSymphonyRun);

  const loadSnapshot = useCallback(async () => {
    const next = await api.symphony.getSnapshot({ projectId });
    setSnapshot(next);
    setError(null);
  }, [api, projectId]);

  useEffect(() => {
    let disposed = false;
    void loadSnapshot().catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Failed to load Symphony.");
    });
    const unsubscribe = api.symphony.subscribe({ projectId }, (event) => {
      setSnapshot(event.snapshot);
      setError(null);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api, loadSnapshot, projectId]);

  const runAction = useCallback(
    async (action: SymphonyAction) => {
      setBusyAction(action);
      try {
        const next =
          action === "start"
            ? await api.symphony.start({ projectId })
            : action === "pause"
              ? await api.symphony.pause({ projectId })
              : action === "resume"
                ? await api.symphony.resume({ projectId })
                : await api.symphony.refresh({ projectId });
        setSnapshot(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Symphony action failed.");
      } finally {
        setBusyAction(null);
      }
    },
    [api, projectId],
  );

  const updateDefaultTarget = useCallback(
    async (target: SymphonyExecutionTarget) => {
      setBusyAction("update-target");
      try {
        const settings = await api.symphony.updateExecutionDefault({ projectId, target });
        setSnapshot((current) => (current ? { ...current, settings } : current));
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Symphony target update failed.");
      } finally {
        setBusyAction(null);
      }
    },
    [api, projectId],
  );

  const runIssueAction = useCallback(
    async (
      action: Extract<SymphonyAction, "stop" | "launch-local" | "launch-cloud" | "refresh-cloud">,
      run: SymphonyRun,
    ) => {
      setBusyAction(action);
      try {
        const next = await (action === "stop"
          ? api.symphony.stopIssue({ projectId, issueId: run.issue.id })
          : action === "launch-local"
            ? api.symphony.launchIssue({
                projectId,
                issueId: run.issue.id,
                target: "local",
              })
            : action === "launch-cloud"
              ? api.symphony.launchIssue({
                  projectId,
                  issueId: run.issue.id,
                  target: "codex-cloud",
                })
              : api.symphony.refreshCloudStatus({ projectId, issueId: run.issue.id }));
        setSnapshot(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Symphony issue action failed.");
      } finally {
        setBusyAction(null);
      }
    },
    [api, projectId],
  );

  const openLinkedThread = useCallback(
    async (run: SymphonyRun) => {
      setLinkedThreadBusy(true);
      try {
        const result = await api.symphony.openLinkedThread({
          projectId,
          issueId: run.issue.id,
        });
        if (result.threadId) {
          onOpenThread(result.threadId);
          setError(null);
        } else {
          setError("This Symphony run does not have a linked chat thread yet.");
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to open linked thread.");
      } finally {
        setLinkedThreadBusy(false);
      }
    },
    [api, onOpenThread, projectId],
  );

  const allRuns = snapshot
    ? [
        ...snapshot.queues.pendingTarget,
        ...snapshot.queues.running,
        ...snapshot.queues.retrying,
        ...snapshot.queues.eligible,
        ...snapshot.queues.failed,
        ...snapshot.queues.canceled,
        ...snapshot.queues.completed,
      ]
    : [];
  const selectedRun = selectedRunId
    ? (allRuns.find((run) => run.runId === selectedRunId) ?? null)
    : null;

  useEffect(() => {
    if (selectedRunId && snapshot && !selectedRun) {
      setSelectedSymphonyRun(projectKey, null);
    }
  }, [projectKey, selectedRun, selectedRunId, setSelectedSymphonyRun, snapshot]);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="border-b border-border bg-card/70 px-4 py-3 shadow-[inset_0_-1px_0_color-mix(in_srgb,var(--theme-primary)_18%,transparent)]">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <WorkflowIcon className="size-4 shrink-0 text-primary" />
            <h2 className="truncate text-sm font-semibold uppercase tracking-[0.08em]">Symphony</h2>
          </div>
          <Badge variant="outline" className="max-w-[18rem] truncate">
            {projectName}
          </Badge>
          <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
            {projectCwd}
          </span>
        </div>
      </div>

      {error ? (
        <div className="border-b border-destructive/35 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!snapshot ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-6" />
        </div>
      ) : (
        <>
          <WorkflowStatus snapshot={snapshot} />
          <SymphonyToolbar
            snapshot={snapshot}
            busyAction={busyAction}
            onAction={runAction}
            onTargetChange={(target) => void updateDefaultTarget(target)}
          />
          <IssueQueueTable
            runs={allRuns}
            busyAction={busyAction}
            selectedRunId={selectedRunId}
            onSelectRun={(run) => setSelectedSymphonyRun(projectKey, run.runId)}
            onIssueAction={runIssueAction}
            onOpenLinkedThread={(run) => void openLinkedThread(run)}
          />
          <SymphonyEventTimeline snapshot={snapshot} />
          <RunDetailsDrawer
            run={selectedRun}
            events={snapshot.events}
            open={selectedRun !== null}
            linkedThreadBusy={linkedThreadBusy}
            onOpenChange={(open) => {
              if (!open) setSelectedSymphonyRun(projectKey, null);
            }}
            onOpenLinkedThread={() => {
              if (selectedRun) void openLinkedThread(selectedRun);
            }}
          />
        </>
      )}
    </section>
  );
}
