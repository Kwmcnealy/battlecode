import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";

export function NoActiveThreadState() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header
          className={cn(
            "border-b border-border bg-card/70 px-3 sm:px-5",
            isElectron
              ? "drag-region flex h-[52px] items-center wco:h-[env(titlebar-area-height)]"
              : "py-2 sm:py-3",
          )}
        >
          {isElectron ? (
            <span className="text-xs tracking-[0.16em] text-muted-foreground/70 uppercase wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]">
              No active thread
            </span>
          ) : (
            <div className="flex items-center gap-2">
              <SidebarTrigger className="size-7 shrink-0 md:hidden" />
              <span className="text-sm font-medium tracking-[0.08em] text-foreground uppercase md:text-muted-foreground/80">
                No active thread
              </span>
            </div>
          )}
        </header>

        <Empty className="crimson-conversation-canvas flex-1">
          <div className="relative w-full max-w-lg border border-border bg-card/80 px-8 py-12 shadow-[var(--glow-standard)]">
            <span className="pointer-events-none absolute -left-px -top-px size-3 border-l-2 border-t-2 border-primary" />
            <span className="pointer-events-none absolute -bottom-px -right-px size-3 border-b-2 border-r-2 border-info" />
            <EmptyHeader className="max-w-none">
              <EmptyTitle className="text-foreground text-xl tracking-[0.08em] uppercase">
                Pick a thread to continue
              </EmptyTitle>
              <EmptyDescription className="mt-2 text-sm text-muted-foreground/78">
                Select an existing thread or create a new one to get started.
              </EmptyDescription>
            </EmptyHeader>
          </div>
        </Empty>
      </div>
    </SidebarInset>
  );
}
