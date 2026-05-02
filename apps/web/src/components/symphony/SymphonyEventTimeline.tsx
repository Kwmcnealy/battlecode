import type { SymphonySnapshot } from "@t3tools/contracts";

import { formatDateTime } from "./symphonyDisplay";

export function SymphonyEventTimeline({ snapshot }: { snapshot: SymphonySnapshot }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Event timeline
        </h3>
        <span className="font-mono text-[11px] text-muted-foreground/70">
          {snapshot.events.length} events
        </span>
      </div>
      <div className="divide-y divide-border/60 border border-border/70 bg-card/45">
        {snapshot.events.length === 0 ? (
          <div className="px-4 py-6 text-sm text-muted-foreground">No Symphony events yet.</div>
        ) : (
          snapshot.events.toReversed().map((event) => (
            <div key={event.eventId} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_1fr]">
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
    </div>
  );
}
