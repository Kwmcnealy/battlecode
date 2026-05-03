import {
  AlertCircleIcon,
  AlertTriangleIcon,
  CirclePauseIcon,
  ClockIcon,
  FileSearchIcon,
  PlayIcon,
  RefreshCwIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { SymphonySnapshot } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { getSymphonyDiagnosticsDisplay, type SymphonyAction } from "./symphonyDisplay";

export function SymphonyToolbar({
  snapshot,
  busyAction,
  onAction,
}: {
  snapshot: SymphonySnapshot;
  busyAction: SymphonyAction | null;
  onAction: (action: SymphonyAction) => void;
}) {
  const busy = busyAction !== null;
  const isRunning = snapshot.status === "running";
  const isPaused = snapshot.status === "paused";
  const diagnostics = getSymphonyDiagnosticsDisplay(snapshot);
  return (
    <div className="border-b border-border/70 bg-background/75">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Button size="xs" disabled={busy || isRunning} onClick={() => onAction("start")}>
          {busyAction === "start" ? (
            <Spinner className="size-3" />
          ) : (
            <PlayIcon className="size-3" />
          )}
          Start Watching
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !isRunning}
          onClick={() => onAction("pause")}
        >
          {busyAction === "pause" ? (
            <Spinner className="size-3" />
          ) : (
            <CirclePauseIcon className="size-3" />
          )}
          Pause
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={busy || !isPaused}
          onClick={() => onAction("resume")}
        >
          {busyAction === "resume" ? (
            <Spinner className="size-3" />
          ) : (
            <RotateCcwIcon className="size-3" />
          )}
          Resume
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={() => onAction("refresh")}>
          {busyAction === "refresh" ? (
            <Spinner className="size-3" />
          ) : (
            <RefreshCwIcon className="size-3" />
          )}
          Refresh Issues
        </Button>
        <div className="ms-auto flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          <span>{snapshot.totals.intake} intake</span>
          <span>{snapshot.totals.planning} planning</span>
          <span>{snapshot.totals.implementing} implementing</span>
          <span>{snapshot.totals["in-review"]} in-review</span>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border/60 px-4 py-2 text-[11px] text-muted-foreground">
        <span
          className="inline-flex max-w-full items-center gap-1 truncate"
          title={diagnostics.lastPollTitle}
        >
          <ClockIcon className="size-3 shrink-0" />
          <span className="shrink-0 uppercase tracking-[0.08em]">Last poll</span>
          <span className="truncate font-mono">{diagnostics.lastPollLabel}</span>
        </span>
        <span
          className="inline-flex max-w-full items-center gap-1 truncate"
          title={diagnostics.workflowTitle}
        >
          <FileSearchIcon className="size-3 shrink-0" />
          <span className="shrink-0 uppercase tracking-[0.08em]">Workflow</span>
          <span className="truncate font-mono">{diagnostics.workflowLabel}</span>
        </span>
        {diagnostics.queriedStatesLabel ? (
          <span className="truncate font-mono" title={diagnostics.queriedStatesLabel}>
            {diagnostics.queriedStatesLabel}
          </span>
        ) : null}
        {diagnostics.candidateCountLabel ? (
          <span className="font-mono">{diagnostics.candidateCountLabel}</span>
        ) : null}
        {diagnostics.warningLabel ? (
          <span
            className="inline-flex items-center gap-1 text-warning"
            title={diagnostics.warningTitle ?? undefined}
          >
            <AlertTriangleIcon className="size-3" />
            {diagnostics.warningLabel}
          </span>
        ) : null}
        {diagnostics.errorLabel ? (
          <span
            className="inline-flex items-center gap-1 text-destructive"
            title={diagnostics.errorTitle ?? undefined}
          >
            <AlertCircleIcon className="size-3" />
            {diagnostics.errorLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}
