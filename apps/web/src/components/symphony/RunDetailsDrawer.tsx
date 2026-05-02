import {
  CloudIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  MessageSquareIcon,
  TimerIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { SymphonyEvent, SymphonyRun } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../ui/sheet";
import {
  STATUS_BADGE_CLASSNAME,
  TARGET_LABEL,
  formatDateTime,
  formatStatus,
} from "./symphonyDisplay";

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="grid gap-1 border-b border-border/60 py-2 last:border-b-0 sm:grid-cols-[8rem_1fr]">
      <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
      <dd className="min-w-0 truncate font-mono text-xs text-foreground" title={value ?? "-"}>
        {value ?? "-"}
      </dd>
    </div>
  );
}

function SectionTitle({ icon, title, meta }: { icon: ReactNode; title: string; meta?: string }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-primary [&_svg]:size-4">{icon}</span>
        <h3 className="truncate text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </h3>
      </div>
      {meta ? <span className="font-mono text-[11px] text-muted-foreground/75">{meta}</span> : null}
    </div>
  );
}

export function RunDetailsDrawer({
  run,
  events,
  open,
  linkedThreadBusy,
  onOpenChange,
  onOpenLinkedThread,
}: {
  run: SymphonyRun | null;
  events: readonly SymphonyEvent[];
  open: boolean;
  linkedThreadBusy: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenLinkedThread: () => void;
}) {
  const runEvents = run
    ? events
        .filter((event) => event.runId === run.runId || event.issueId === run.issue.id)
        .toReversed()
    : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetPopup side="right" className="max-w-2xl">
        <SheetHeader className="border-b border-border/70">
          <div className="flex min-w-0 items-start justify-between gap-3 pr-8">
            <div className="min-w-0">
              <SheetTitle className="truncate text-base">
                {run ? run.issue.identifier : "Run details"}
              </SheetTitle>
              <SheetDescription className="truncate">
                {run ? run.issue.title : "No Symphony run selected."}
              </SheetDescription>
            </div>
            {run ? (
              <Badge variant="outline" className={STATUS_BADGE_CLASSNAME[run.status]}>
                {formatStatus(run.status)}
              </Badge>
            ) : null}
          </div>
        </SheetHeader>

        {run ? (
          <SheetPanel className="grid gap-5">
            <div className="flex flex-wrap gap-2">
              {run.threadId ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={linkedThreadBusy}
                  onClick={onOpenLinkedThread}
                >
                  <MessageSquareIcon className="size-4" />
                  Open thread
                </Button>
              ) : null}
              {run.issue.url ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={<a href={run.issue.url} target="_blank" rel="noreferrer" />}
                >
                  <ExternalLinkIcon className="size-4" />
                  Linear
                </Button>
              ) : null}
              {run.cloudTask?.taskUrl ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={<a href={run.cloudTask.taskUrl} target="_blank" rel="noreferrer" />}
                >
                  <CloudIcon className="size-4" />
                  Codex task
                </Button>
              ) : null}
              {(run.pullRequest?.url ?? run.prUrl) ? (
                <Button
                  size="sm"
                  variant="outline"
                  render={
                    <a
                      href={run.pullRequest?.url ?? run.prUrl ?? undefined}
                      target="_blank"
                      rel="noreferrer"
                    />
                  }
                >
                  <GitPullRequestIcon className="size-4" />
                  PR
                </Button>
              ) : null}
            </div>

            <section>
              <SectionTitle icon={<GitBranchIcon />} title="Workspace" />
              <dl className="border-y border-border/70">
                <DetailRow label="Workspace" value={run.workspacePath} />
                <DetailRow label="Branch" value={run.branchName} />
                <DetailRow label="Thread" value={run.threadId} />
                <DetailRow label="PR URL" value={run.pullRequest?.url ?? run.prUrl} />
                <DetailRow label="PR state" value={run.pullRequest?.state ?? null} />
                <DetailRow label="Linear state" value={run.issue.state} />
                <DetailRow label="Current step" value={run.currentStep?.label ?? null} />
                <DetailRow label="Step detail" value={run.currentStep?.detail ?? null} />
                <DetailRow label="Archived at" value={formatDateTime(run.archivedAt)} />
                <DetailRow
                  label="Target"
                  value={run.executionTarget ? TARGET_LABEL[run.executionTarget] : null}
                />
                <DetailRow label="Cloud status" value={run.cloudTask?.status ?? null} />
                <DetailRow label="Cloud task" value={run.cloudTask?.taskUrl ?? null} />
              </dl>
            </section>

            <section>
              <SectionTitle icon={<TimerIcon />} title="Attempts" meta={`${run.attempts.length}`} />
              <div className="divide-y divide-border/60 border-y border-border/70">
                {run.attempts.length === 0 ? (
                  <div className="py-3 text-sm text-muted-foreground">No attempts recorded.</div>
                ) : (
                  run.attempts.toReversed().map((attempt) => (
                    <div
                      key={`${attempt.attempt}-${attempt.startedAt}`}
                      className="grid gap-2 py-3 sm:grid-cols-[5rem_1fr]"
                    >
                      <div className="font-mono text-xs text-muted-foreground">
                        #{attempt.attempt}
                      </div>
                      <div className="min-w-0">
                        <div className="font-mono text-xs uppercase tracking-[0.08em] text-foreground">
                          {attempt.status}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatDateTime(attempt.startedAt)}
                          {" -> "}
                          {formatDateTime(attempt.completedAt)}
                        </div>
                        {attempt.error ? (
                          <div className="mt-2 rounded-md border border-destructive/35 bg-destructive/10 px-2 py-1 text-xs text-destructive">
                            {attempt.error}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section>
              <SectionTitle
                icon={<MessageSquareIcon />}
                title="Timeline"
                meta={`${runEvents.length}`}
              />
              <div className="divide-y divide-border/60 border-y border-border/70">
                {runEvents.length === 0 ? (
                  <div className="py-3 text-sm text-muted-foreground">No run events recorded.</div>
                ) : (
                  runEvents.map((event) => (
                    <div key={event.eventId} className="grid gap-2 py-3 sm:grid-cols-[9rem_1fr]">
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {formatDateTime(event.createdAt)}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground">{event.message}</div>
                        <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                          {event.type}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </SheetPanel>
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
