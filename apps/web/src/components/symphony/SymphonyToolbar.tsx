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
import type { SymphonyExecutionTarget, SymphonySnapshot } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import {
  TARGET_LABEL,
  getSymphonyDiagnosticsDisplay,
  type SymphonyAction,
} from "./symphonyDisplay";

export function SymphonyToolbar({
  snapshot,
  busyAction,
  onAction,
  onTargetChange,
}: {
  snapshot: SymphonySnapshot;
  busyAction: SymphonyAction | null;
  onAction: (action: SymphonyAction) => void;
  onTargetChange: (target: SymphonyExecutionTarget) => void;
}) {
  const busy = busyAction !== null;
  const isRunning = snapshot.status === "running";
  const isPaused = snapshot.status === "paused";
  const selectedTarget = snapshot.settings.executionDefaultTarget;
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
        <div className="flex items-center gap-2 pl-1 text-[11px] text-muted-foreground">
          <span className="uppercase tracking-[0.08em]">Default</span>
          <Select
            value={selectedTarget}
            onValueChange={(value) => {
              if (value === "local" || value === "codex-cloud") {
                onTargetChange(value);
              }
            }}
          >
            <SelectTrigger
              className="h-7 w-[8.5rem]"
              aria-label="Default Symphony execution target"
              disabled={busy}
            >
              <SelectValue>{TARGET_LABEL[selectedTarget]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value="local">
                Local
              </SelectItem>
              <SelectItem hideIndicator value="codex-cloud">
                Codex Cloud
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
        <div className="ms-auto flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          <span>{snapshot.totals.pendingTarget} pending target</span>
          <span>{snapshot.totals.running} running</span>
          <span>{snapshot.totals.eligible} eligible</span>
          <span>{snapshot.totals.retrying} retrying</span>
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
