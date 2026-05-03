import {
  ArchiveIcon,
  ExternalLinkIcon,
  EyeIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  PlayIcon,
  SquareIcon,
} from "lucide-react";
import { memo } from "react";
import type { SymphonyRun } from "@t3tools/contracts";
import { canArchiveSymphonyRun } from "@t3tools/shared/symphony";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  PHASE_BADGE_CLASSNAME,
  formatLifecyclePhase,
  formatStatus,
  type SymphonyAction,
} from "./symphonyDisplay";
import { SymphonyEmptyState } from "./SymphonyEmptyState";

const RETRYABLE_STATUSES = new Set<SymphonyRun["status"]>(["failed", "canceled"]);
const STOPPABLE_STATUSES = new Set<SymphonyRun["status"]>([
  "intake",
  "planning",
  "implementing",
  "in-review",
]);
const LAUNCHABLE_STATUSES = new Set<SymphonyRun["status"]>(["intake", "failed", "canceled"]);

function getIssueQueueRowState(run: SymphonyRun) {
  return {
    canRetry: RETRYABLE_STATUSES.has(run.status),
    canArchive: run.archivedAt === null && canArchiveSymphonyRun(run),
    canLaunch: LAUNCHABLE_STATUSES.has(run.status),
    canStop: STOPPABLE_STATUSES.has(run.status),
  };
}

function buildIssueQueueRowDigest(run: SymphonyRun): string {
  return JSON.stringify({
    branchName: run.branchName,
    archivedAt: run.archivedAt,
    currentStepDetail: run.currentStep?.detail ?? null,
    currentStepLabel: run.currentStep?.label ?? null,
    issueIdentifier: run.issue.identifier,
    issueState: run.issue.state,
    issueTitle: run.issue.title,
    issueUrl: run.issue.url,
    lastError: run.lastError,
    prUrl: run.pullRequest?.url ?? run.prUrl,
    runId: run.runId,
    status: run.status,
    threadId: run.threadId,
  });
}

interface IssueQueueRowProps {
  busyAction: SymphonyAction | null;
  isSelected: boolean;
  onIssueAction: (
    action: Extract<SymphonyAction, "archive" | "stop" | "launch">,
    run: SymphonyRun,
  ) => void;
  onOpenLinkedThread: (run: SymphonyRun) => void;
  onSelectRun: (run: SymphonyRun) => void;
  run: SymphonyRun;
}

const IssueQueueRow = memo(
  function IssueQueueRow({
    busyAction,
    isSelected,
    onIssueAction,
    onOpenLinkedThread,
    onSelectRun,
    run,
  }: IssueQueueRowProps) {
    const { canRetry, canArchive, canLaunch, canStop } = getIssueQueueRowState(run);

    return (
      <tr
        role="button"
        tabIndex={0}
        className={cn(
          "cursor-pointer border-t border-border/60 hover:bg-accent/35",
          isSelected && "bg-primary/5",
        )}
        onClick={() => onSelectRun(run)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onSelectRun(run);
        }}
      >
        <td className="max-w-[22rem] px-4 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-mono text-xs text-primary">{run.issue.identifier}</span>
            <span className="truncate font-medium text-foreground" title={run.issue.title}>
              {run.issue.title}
            </span>
          </div>
        </td>
        <td className="px-3 py-3 text-xs text-muted-foreground">{run.issue.state}</td>
        <td className="px-3 py-3">
          <Badge
            variant="outline"
            className={cn("whitespace-nowrap", PHASE_BADGE_CLASSNAME[run.status])}
          >
            {formatLifecyclePhase(run.status)}
          </Badge>
        </td>
        <td className="max-w-[15rem] px-3 py-3 text-xs text-muted-foreground">
          <div className="line-clamp-2" title={run.currentStep?.detail ?? undefined}>
            {run.currentStep?.label ?? "-"}
          </div>
        </td>
        <td className="max-w-[12rem] truncate px-3 py-3 font-mono text-xs text-muted-foreground">
          {run.branchName ?? "-"}
        </td>
        <td className="max-w-[10rem] truncate px-3 py-3 font-mono text-xs text-muted-foreground">
          {run.threadId ?? "-"}
        </td>
        <td className="px-4 py-3">
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onSelectRun(run);
              }}
            >
              <EyeIcon className="size-3" />
              Details
            </Button>
            {run.threadId ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busyAction !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenLinkedThread(run);
                }}
              >
                <MessageSquareIcon className="size-3" />
                Open Thread
              </Button>
            ) : null}
            {(run.pullRequest?.url ?? run.prUrl) ? (
              <Button
                size="xs"
                variant="outline"
                render={
                  <a
                    href={run.pullRequest?.url ?? run.prUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  />
                }
              >
                <GitPullRequestIcon className="size-3" />
                Open PR
              </Button>
            ) : null}
            {run.issue.url ? (
              <Button
                size="xs"
                variant="outline"
                render={
                  <a
                    href={run.issue.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                  />
                }
              >
                <ExternalLinkIcon className="size-3" />
                Linear
              </Button>
            ) : null}
            {canLaunch ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busyAction !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  onIssueAction("launch", run);
                }}
              >
                <PlayIcon className="size-3" />
                {canRetry ? "Retry" : "Run"}
              </Button>
            ) : null}
            {canArchive ? (
              <Button
                size="xs"
                variant="outline"
                disabled={busyAction !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  onIssueAction("archive", run);
                }}
              >
                <ArchiveIcon className="size-3" />
                Archive
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={busyAction !== null || !canStop}
              onClick={(event) => {
                event.stopPropagation();
                onIssueAction("stop", run);
              }}
            >
              <SquareIcon className="size-3" />
              Stop
            </Button>
          </div>
        </td>
      </tr>
    );
  },
  (previous, next) =>
    previous.busyAction === next.busyAction &&
    previous.isSelected === next.isSelected &&
    previous.onIssueAction === next.onIssueAction &&
    previous.onOpenLinkedThread === next.onOpenLinkedThread &&
    previous.onSelectRun === next.onSelectRun &&
    buildIssueQueueRowDigest(previous.run) === buildIssueQueueRowDigest(next.run),
);

export function IssueQueueTable({
  runs,
  busyAction,
  selectedRunId,
  onSelectRun,
  onIssueAction,
  onOpenLinkedThread,
}: {
  runs: readonly SymphonyRun[];
  busyAction: SymphonyAction | null;
  selectedRunId: string | null;
  onSelectRun: (run: SymphonyRun) => void;
  onIssueAction: (
    action: Extract<SymphonyAction, "archive" | "stop" | "launch">,
    run: SymphonyRun,
  ) => void;
  onOpenLinkedThread: (run: SymphonyRun) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="flex min-h-44 items-center justify-center border-b border-border/70 px-4 py-8">
        <SymphonyEmptyState />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto border-b border-border/70">
      <table className="w-full min-w-[800px] border-collapse text-left text-sm">
        <thead className="bg-muted/30 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Issue</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Current Step</th>
            <th className="px-3 py-2 font-medium">Branch</th>
            <th className="px-3 py-2 font-medium">Thread</th>
            <th className="px-4 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <IssueQueueRow
              key={run.runId}
              run={run}
              busyAction={busyAction}
              isSelected={selectedRunId === run.runId}
              onSelectRun={onSelectRun}
              onIssueAction={onIssueAction}
              onOpenLinkedThread={onOpenLinkedThread}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
