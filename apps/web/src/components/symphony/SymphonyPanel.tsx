import { WorkflowIcon } from "lucide-react";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { IssueQueueTable } from "./IssueQueueTable";
import { RunDetailsDrawer } from "./RunDetailsDrawer";
import { mergeSymphonySnapshotForDisplay, type SymphonyAction } from "./symphonyDisplay";
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
  const [runView, setRunView] = useState<"active" | "archived">("active");
  const pendingSnapshotRef = useRef<SymphonySnapshot | null>(null);
  const snapshotFrameRef = useRef<number | null>(null);
  const api = useMemo(() => ensureEnvironmentApi(environmentId), [environmentId]);
  const projectKey = useMemo(
    () => scopedProjectKey(scopeProjectRef(environmentId, projectId)),
    [environmentId, projectId],
  );
  const selectedRunId = useUiStateStore(
    (state) => state.selectedSymphonyRunByProjectKey[projectKey] ?? null,
  );
  const setSelectedSymphonyRun = useUiStateStore((state) => state.setSelectedSymphonyRun);

  const enqueueLiveSnapshot = useCallback((next: SymphonySnapshot) => {
    pendingSnapshotRef.current = next;
    if (snapshotFrameRef.current !== null) {
      return;
    }

    snapshotFrameRef.current = window.requestAnimationFrame(() => {
      snapshotFrameRef.current = null;
      const pendingSnapshot = pendingSnapshotRef.current;
      pendingSnapshotRef.current = null;
      if (!pendingSnapshot) {
        return;
      }
      startTransition(() => {
        setSnapshot((current) => mergeSymphonySnapshotForDisplay(current, pendingSnapshot));
      });
    });
  }, []);

  const commitSnapshotImmediately = useCallback((next: SymphonySnapshot) => {
    if (snapshotFrameRef.current !== null) {
      window.cancelAnimationFrame(snapshotFrameRef.current);
      snapshotFrameRef.current = null;
    }
    pendingSnapshotRef.current = null;
    setSnapshot(next);
  }, []);

  const loadSnapshot = useCallback(async () => {
    const next = await api.symphony.getSnapshot({ projectId });
    commitSnapshotImmediately(next);
    setError(null);
  }, [api, commitSnapshotImmediately, projectId]);

  useEffect(() => {
    let disposed = false;
    void loadSnapshot().catch((cause) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : "Failed to load Symphony.");
    });
    const unsubscribe = api.symphony.subscribe({ projectId }, (event) => {
      enqueueLiveSnapshot(event.snapshot);
      setError(null);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api, enqueueLiveSnapshot, loadSnapshot, projectId]);

  useEffect(
    () => () => {
      if (snapshotFrameRef.current !== null) {
        window.cancelAnimationFrame(snapshotFrameRef.current);
        snapshotFrameRef.current = null;
      }
      pendingSnapshotRef.current = null;
    },
    [],
  );

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
        commitSnapshotImmediately(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Symphony action failed.");
      } finally {
        setBusyAction(null);
      }
    },
    [api, commitSnapshotImmediately, projectId],
  );

  const updateDefaultTarget = useCallback(
    async (target: SymphonyExecutionTarget) => {
      setBusyAction("update-target");
      try {
        const settings = await api.symphony.updateExecutionDefault({ projectId, target });
        if (snapshotFrameRef.current !== null) {
          window.cancelAnimationFrame(snapshotFrameRef.current);
          snapshotFrameRef.current = null;
        }
        pendingSnapshotRef.current = null;
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
      action: Extract<
        SymphonyAction,
        "archive" | "stop" | "launch-local" | "launch-cloud" | "refresh-cloud"
      >,
      run: SymphonyRun,
    ) => {
      setBusyAction(action);
      try {
        const next = await (action === "archive"
          ? api.symphony.archiveIssue({ projectId, issueId: run.issue.id })
          : action === "stop"
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
        commitSnapshotImmediately(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Symphony issue action failed.");
      } finally {
        setBusyAction(null);
      }
    },
    [api, commitSnapshotImmediately, projectId],
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

  const { activeRuns, allRuns, archivedRuns } = useMemo(() => {
    if (!snapshot) {
      return {
        activeRuns: [] as readonly SymphonyRun[],
        allRuns: [] as readonly SymphonyRun[],
        archivedRuns: [] as readonly SymphonyRun[],
      };
    }
    const nextActiveRuns = [
      ...snapshot.queues.pendingTarget,
      ...snapshot.queues.running,
      ...snapshot.queues.retrying,
      ...snapshot.queues.eligible,
      ...snapshot.queues.failed,
      ...snapshot.queues.canceled,
      ...snapshot.queues.completed,
    ].filter((run) => run.archivedAt === null);
    return {
      activeRuns: nextActiveRuns,
      archivedRuns: snapshot.queues.archived,
      allRuns: [...nextActiveRuns, ...snapshot.queues.archived],
    };
  }, [snapshot]);
  const visibleRuns = useMemo(
    () => (runView === "archived" ? archivedRuns : activeRuns),
    [activeRuns, archivedRuns, runView],
  );
  const selectedRun = useMemo(
    () => (selectedRunId ? (allRuns.find((run) => run.runId === selectedRunId) ?? null) : null),
    [allRuns, selectedRunId],
  );

  const selectRun = useCallback(
    (run: SymphonyRun) => setSelectedSymphonyRun(projectKey, run.runId),
    [projectKey, setSelectedSymphonyRun],
  );
  const handleOpenLinkedThread = useCallback(
    (run: SymphonyRun) => {
      void openLinkedThread(run);
    },
    [openLinkedThread],
  );

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
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-4 py-2">
            <div className="inline-flex overflow-hidden rounded-md border border-border bg-background">
              <Button
                type="button"
                size="xs"
                variant={runView === "active" ? "secondary" : "ghost"}
                className="rounded-none border-0"
                onClick={() => setRunView("active")}
              >
                Active
                <span className="font-mono text-[10px]">{activeRuns.length}</span>
              </Button>
              <Button
                type="button"
                size="xs"
                variant={runView === "archived" ? "secondary" : "ghost"}
                className="rounded-none border-0"
                onClick={() => setRunView("archived")}
              >
                Archived
                <span className="font-mono text-[10px]">{archivedRuns.length}</span>
              </Button>
            </div>
          </div>
          <IssueQueueTable
            runs={visibleRuns}
            busyAction={busyAction}
            selectedRunId={selectedRunId}
            onSelectRun={selectRun}
            onIssueAction={runIssueAction}
            onOpenLinkedThread={handleOpenLinkedThread}
          />
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
