import { EyeIcon, RotateCcwIcon, SquareIcon } from "lucide-react";
import type { SymphonyRun } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { STATUS_BADGE_CLASSNAME, formatStatus, type SymphonyAction } from "./symphonyDisplay";
import { SymphonyEmptyState } from "./SymphonyEmptyState";

const RETRYABLE_STATUSES = new Set<SymphonyRun["status"]>(["failed", "canceled", "released"]);
const STOPPABLE_STATUSES = new Set<SymphonyRun["status"]>(["eligible", "running", "retry-queued"]);

export function IssueQueueTable({
  runs,
  busyAction,
  selectedRunId,
  onSelectRun,
  onIssueAction,
}: {
  runs: readonly SymphonyRun[];
  busyAction: SymphonyAction | null;
  selectedRunId: string | null;
  onSelectRun: (run: SymphonyRun) => void;
  onIssueAction: (action: Extract<SymphonyAction, "stop" | "retry">, run: SymphonyRun) => void;
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
            <th className="px-3 py-2 font-medium">Branch</th>
            <th className="px-3 py-2 font-medium">Thread</th>
            <th className="px-4 py-2 text-right font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const canRetry = RETRYABLE_STATUSES.has(run.status);
            const canStop = STOPPABLE_STATUSES.has(run.status);
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
                </td>
                <td className="max-w-[12rem] truncate px-3 py-3 font-mono text-xs text-muted-foreground">
                  {run.branchName ?? "-"}
                </td>
                <td className="max-w-[10rem] truncate px-3 py-3 font-mono text-xs text-muted-foreground">
                  {run.threadId ?? "-"}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <Button size="xs" variant="ghost" onClick={() => onSelectRun(run)}>
                      <EyeIcon className="size-3" />
                      Details
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busyAction !== null || !canRetry}
                      onClick={() => onIssueAction("retry", run)}
                    >
                      <RotateCcwIcon className="size-3" />
                      Retry
                    </Button>
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
