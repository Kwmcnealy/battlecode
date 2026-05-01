import { CirclePauseIcon, PlayIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import type { SymphonySnapshot } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { SymphonyAction } from "./symphonyDisplay";

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
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border/70 bg-background/75 px-4 py-3">
      <Button size="xs" disabled={busy || isRunning} onClick={() => onAction("start")}>
        {busyAction === "start" ? <Spinner className="size-3" /> : <PlayIcon className="size-3" />}
        Start
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
        Refresh
      </Button>
      <div className="ms-auto flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
        <span>{snapshot.totals.running} running</span>
        <span>{snapshot.totals.eligible} eligible</span>
        <span>{snapshot.totals.retrying} retrying</span>
      </div>
    </div>
  );
}
