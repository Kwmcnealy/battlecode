import { AlertCircleIcon, CheckCircle2Icon } from "lucide-react";
import type { SymphonySnapshot } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { formatStatus } from "./symphonyDisplay";

export function WorkflowStatus({ snapshot }: { snapshot: SymphonySnapshot }) {
  const workflow = snapshot.settings.workflowStatus;
  const secret = snapshot.settings.linearSecret;
  const workflowReady = workflow.status === "valid";
  const secretReady = secret.configured;

  return (
    <div className="grid gap-3 border-b border-border/70 bg-card/55 p-4 sm:grid-cols-3">
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Runtime
        </div>
        <div className="mt-1 flex items-center gap-2">
          <span
            className={cn(
              "size-2 rounded-full",
              snapshot.status === "running"
                ? "bg-success"
                : snapshot.status === "paused"
                  ? "bg-warning"
                  : snapshot.status === "setup-blocked"
                    ? "bg-destructive"
                    : "bg-muted-foreground/50",
            )}
          />
          <span className="text-sm font-medium uppercase tracking-[0.06em]">
            {formatStatus(snapshot.status)}
          </span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Workflow
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          {workflowReady ? (
            <CheckCircle2Icon className="size-4 shrink-0 text-success" />
          ) : (
            <AlertCircleIcon className="size-4 shrink-0 text-warning" />
          )}
          <span className="truncate text-sm" title={snapshot.settings.workflowPath}>
            {workflow.message ?? snapshot.settings.workflowPath}
          </span>
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Linear
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          {secretReady ? (
            <CheckCircle2Icon className="size-4 shrink-0 text-success" />
          ) : (
            <AlertCircleIcon className="size-4 shrink-0 text-destructive" />
          )}
          <span className="truncate text-sm">
            {secretReady ? `Configured via ${secret.source}` : "API key missing"}
          </span>
        </div>
      </div>
    </div>
  );
}
