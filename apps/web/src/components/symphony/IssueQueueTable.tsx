import {
  CloudIcon,
  ExternalLinkIcon,
  EyeIcon,
  MessageSquareIcon,
  PlayIcon,
  RefreshCwIcon,
  SquareIcon,
} from "lucide-react";
import type { SymphonyRun } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  STATUS_BADGE_CLASSNAME,
  TARGET_LABEL,
  formatStatus,
  type SymphonyAction,
} from "./symphonyDisplay";
import { SymphonyEmptyState } from "./SymphonyEmptyState";

const RETRYABLE_STATUSES = new Set<SymphonyRun["status"]>(["failed", "canceled", "released"]);
const STOPPABLE_STATUSES = new Set<SymphonyRun["status"]>([
  "eligible",
  "running",
  "retry-queued",
  "cloud-submitted",
]);
const LAUNCHABLE_STATUSES = new Set<SymphonyRun["status"]>([
  "target-pending",
  "eligible",
  "failed",
  "canceled",
  "released",
]);

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
    action: Extract<SymphonyAction, "stop" | "launch-local" | "launch-cloud" | "refresh-cloud">,
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
    <div className="overflow-auto border-b border-border/70">
      <table className="w-full min-w-[760px] border-collapse text-left text-sm">
        <thead className="bg-muted/30 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Issue</th>
            <th className="px-3 py-2 font-medium">State</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Target</th>
            <th className="px-3 py-2 font-medium">Branch</th>
            <th className="px-3 py-2 font-medium">Thread / Task</th>
            <th className="px-4 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const canRetry = RETRYABLE_STATUSES.has(run.status);
            const canLaunch = LAUNCHABLE_STATUSES.has(run.status);
            const canStop = STOPPABLE_STATUSES.has(run.status);
            const targetLabel = run.executionTarget ? TARGET_LABEL[run.executionTarget] : "Choose";
            const taskHref =
              run.executionTarget === "codex-cloud"
                ? (run.cloudTask?.taskUrl ?? run.issue.url)
                : null;
            const cloudMessage =
              run.executionTarget === "codex-cloud" ? run.cloudTask?.lastMessage : null;
            return (
              <tr
                key={run.runId}
                className={cn(
                  "border-t border-border/60",
                  selectedRunId === run.runId && "bg-primary/5",
                )}
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
                    className={cn("whitespace-nowrap", STATUS_BADGE_CLASSNAME[run.status])}
                  >
                    {formatStatus(run.status)}
                  </Badge>
                  {cloudMessage ? (
                    <div
                      title={cloudMessage}
                      className={cn(
                        "mt-1 line-clamp-2 max-w-[14rem] break-words text-[11px] leading-snug",
                        run.cloudTask?.status === "failed"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {cloudMessage}
                    </div>
                  ) : null}
                </td>
                <td className="px-3 py-3">
                  <Badge variant="outline" className="whitespace-nowrap">
                    {targetLabel}
                  </Badge>
                </td>
                <td className="max-w-[12rem] truncate px-3 py-3 font-mono text-xs text-muted-foreground">
                  {run.branchName ?? "-"}
                </td>
                <td className="max-w-[10rem] truncate px-3 py-3 font-mono text-xs text-muted-foreground">
                  {run.executionTarget === "codex-cloud"
                    ? (run.cloudTask?.taskUrl ?? run.issue.url ?? "-")
                    : (run.threadId ?? "-")}
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button size="xs" variant="ghost" onClick={() => onSelectRun(run)}>
                      <EyeIcon className="size-3" />
                      Details
                    </Button>
                    {run.executionTarget === "local" && run.threadId ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busyAction !== null}
                        onClick={() => onOpenLinkedThread(run)}
                      >
                        <MessageSquareIcon className="size-3" />
                        Open Thread
                      </Button>
                    ) : null}
                    {run.executionTarget === "codex-cloud" ? (
                      <>
                        {taskHref ? (
                          <Button
                            size="xs"
                            variant="outline"
                            render={<a href={taskHref} target="_blank" rel="noreferrer" />}
                          >
                            <ExternalLinkIcon className="size-3" />
                            {run.cloudTask?.taskUrl ? "Open Codex Task" : "Open Linear Issue"}
                          </Button>
                        ) : null}
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => onIssueAction("refresh-cloud", run)}
                        >
                          <RefreshCwIcon className="size-3" />
                          Refresh Cloud Status
                        </Button>
                      </>
                    ) : null}
                    {canLaunch ? (
                      <>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => onIssueAction("launch-local", run)}
                        >
                          <PlayIcon className="size-3" />
                          {canRetry ? "Retry Local" : "Run Local"}
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busyAction !== null}
                          onClick={() => onIssueAction("launch-cloud", run)}
                        >
                          <CloudIcon className="size-3" />
                          {canRetry ? "Retry Cloud" : "Send to Cloud"}
                        </Button>
                      </>
                    ) : null}
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null || !canStop}
                      onClick={() => onIssueAction("stop", run)}
                    >
                      <SquareIcon className="size-3" />
                      Stop
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
