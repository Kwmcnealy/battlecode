import { type EnvironmentId, type MessageId, type ThreadId, type TurnId } from "@t3tools/contracts";
import {
  createContext,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { deriveTimelineEntries, formatElapsed } from "../../session-logic";
import { type TurnDiffSummary } from "../../types";
import { summarizeTurnDiffStats } from "../../lib/turnDiffTree";
import ChatMarkdown from "../ChatMarkdown";
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  type LucideIcon,
  SquarePenIcon,
  TerminalIcon,
  Undo2Icon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { buildExpandedImagePreview, ExpandedImagePreview } from "./ExpandedImagePreview";
import { ProposedPlanCard } from "./ProposedPlanCard";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { DiffStatLabel, hasNonZeroStat } from "./DiffStatLabel";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  computeStableMessagesTimelineRows,
  MAX_VISIBLE_WORK_LOG_ENTRIES,
  deriveMessagesTimelineRows,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  type StableMessagesTimelineRowsState,
  type MessagesTimelineRow,
} from "./MessagesTimeline.logic";
import { TerminalContextInlineChip } from "./TerminalContextInlineChip";
import {
  filterParsedFilesByPaths,
  InlineFileDiffsList,
  parseInlineUnifiedDiffFiles,
  type ParsedTurnDiffResult,
  useParsedTurnDiff,
} from "./VerboseInlineFileDiffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "~/lib/terminalContext";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "~/uiStateStore";
import { type TimestampFormat } from "@t3tools/contracts/settings";
import { formatTimestamp } from "../../timestampFormat";

import {
  buildInlineTerminalContextText,
  formatInlineTerminalContextLabel,
  textContainsInlineTerminalContextLabels,
} from "./userMessageTerminalContexts";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

// ---------------------------------------------------------------------------
// Context — shared state consumed by every row component via useContext.
// Propagates through LegendList's memo boundaries for shared callbacks and
// non-row-scoped state. `nowIso` is intentionally excluded — self-ticking
// components (WorkingTimer, LiveElapsed) handle it.
// ---------------------------------------------------------------------------

interface TimelineRowSharedState {
  activeTurnInProgress: boolean;
  activeTurnId: TurnId | null | undefined;
  isWorking: boolean;
  isRevertingCheckpoint: boolean;
  completionSummary: string | null;
  timestampFormat: TimestampFormat;
  routeThreadKey: string;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  workspaceRoot: string | undefined;
  activeThreadEnvironmentId: EnvironmentId;
  /**
   * Active thread id for the timeline. Used by verbose-mode inline diff
   * rendering to fetch checkpoint diffs via `checkpointDiffQueryOptions`.
   * `null` while the route is resolving or in draft mode (no inline diffs
   * are fetched in that case).
   */
  activeThreadId: ThreadId | null;
  /**
   * Live lookup of TurnDiffSummary by `turnId`. Verbose-mode rendering
   * resolves the summary AT RENDER TIME from this map (keyed on the work
   * row's `turnId` field) instead of caching it on the row itself. This
   * avoids the timing race where a row's cached summary stays `undefined`
   * after the summary's `assistantMessageId` binding eventually lands.
   */
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>;
  liveUnifiedDiffByTurnId: ReadonlyMap<TurnId, string>;
  /**
   * Fallback for turns whose `TurnDiffSummary.checkpointTurnCount` is
   * undefined (server hasn't echoed it yet). Built from the same
   * `turnDiffSummaries` array via `inferCheckpointTurnCountByTurnId`. This
   * is what `DiffPanel` and `ChatView` already use; verbose mode now uses
   * the same fallback so its query enables as soon as a summary exists.
   */
  inferredCheckpointTurnCountByTurnId: Readonly<Record<TurnId, number>>;
  /**
   * When true, work entries render as expanded cards (full command, all
   * changed files, tone-coloured borders), the work-log overflow cap is
   * removed, and the changed-files section renders real inline diff hunks
   * (via `@pierre/diffs`) instead of just a file tree. Driven by
   * ClientSettings.verboseChatMode.
   */
  verboseChatMode: boolean;
  /**
   * Mirror of ClientSettings.diffWordWrap. Threaded into the inline diff
   * renderer so it matches the user's preferred wrap behaviour from the
   * full diff panel.
   */
  diffWordWrap: boolean;
  onRevertUserMessage: (messageId: MessageId) => void;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}

const TimelineRowCtx = createContext<TimelineRowSharedState>(null!);

// ---------------------------------------------------------------------------
// Props (public API)
// ---------------------------------------------------------------------------

interface MessagesTimelineProps {
  isWorking: boolean;
  activeTurnInProgress: boolean;
  activeTurnId?: TurnId | null;
  activeTurnStartedAt: string | null;
  listRef: React.RefObject<LegendListRef | null>;
  timelineEntries: ReturnType<typeof deriveTimelineEntries>;
  completionDividerBeforeEntryId: string | null;
  completionSummary: string | null;
  turnDiffSummaryByAssistantMessageId: Map<MessageId, TurnDiffSummary>;
  routeThreadKey: string;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  revertTurnCountByUserMessageId: Map<MessageId, number>;
  onRevertUserMessage: (messageId: MessageId) => void;
  isRevertingCheckpoint: boolean;
  onImageExpand: (preview: ExpandedImagePreview) => void;
  activeThreadEnvironmentId: EnvironmentId;
  markdownCwd: string | undefined;
  resolvedTheme: "light" | "dark";
  timestampFormat: TimestampFormat;
  workspaceRoot: string | undefined;
  verboseChatMode: boolean;
  diffWordWrap: boolean;
  activeThreadId: ThreadId | null;
  turnDiffSummaryByTurnId: ReadonlyMap<TurnId, TurnDiffSummary>;
  liveUnifiedDiffByTurnId: ReadonlyMap<TurnId, string>;
  inferredCheckpointTurnCountByTurnId: Readonly<Record<TurnId, number>>;
  onIsAtEndChange: (isAtEnd: boolean) => void;
}

// ---------------------------------------------------------------------------
// MessagesTimeline — list owner
// ---------------------------------------------------------------------------

export const MessagesTimeline = memo(function MessagesTimeline({
  isWorking,
  activeTurnInProgress,
  activeTurnId,
  activeTurnStartedAt,
  listRef,
  timelineEntries,
  completionDividerBeforeEntryId,
  completionSummary,
  turnDiffSummaryByAssistantMessageId,
  routeThreadKey,
  onOpenTurnDiff,
  revertTurnCountByUserMessageId,
  onRevertUserMessage,
  isRevertingCheckpoint,
  onImageExpand,
  activeThreadEnvironmentId,
  markdownCwd,
  resolvedTheme,
  timestampFormat,
  workspaceRoot,
  verboseChatMode,
  diffWordWrap,
  activeThreadId,
  turnDiffSummaryByTurnId,
  liveUnifiedDiffByTurnId,
  inferredCheckpointTurnCountByTurnId,
  onIsAtEndChange,
}: MessagesTimelineProps) {
  const rawRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        completionDividerBeforeEntryId,
        isWorking,
        activeTurnId: activeTurnId ?? null,
        activeTurnStartedAt,
        turnDiffSummaryByAssistantMessageId,
        revertTurnCountByUserMessageId,
      }),
    [
      timelineEntries,
      completionDividerBeforeEntryId,
      isWorking,
      activeTurnId,
      activeTurnStartedAt,
      turnDiffSummaryByAssistantMessageId,
      revertTurnCountByUserMessageId,
    ],
  );
  const rows = useStableRows(rawRows);

  const handleScroll = useCallback(() => {
    const state = listRef.current?.getState?.();
    if (state) {
      onIsAtEndChange(state.isAtEnd);
    }
  }, [listRef, onIsAtEndChange]);

  const previousRowCountRef = useRef(rows.length);
  useEffect(() => {
    const previousRowCount = previousRowCountRef.current;
    previousRowCountRef.current = rows.length;

    if (previousRowCount > 0 || rows.length === 0) {
      return;
    }

    onIsAtEndChange(true);
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToEnd?.({ animated: false });
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [listRef, onIsAtEndChange, rows.length]);

  // Memoised context value — only changes on state transitions, NOT on
  // every streaming chunk. Callbacks from ChatView are useCallback-stable.
  const sharedState = useMemo<TimelineRowSharedState>(
    () => ({
      activeTurnInProgress,
      activeTurnId: activeTurnId ?? null,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      activeThreadId,
      turnDiffSummaryByTurnId,
      liveUnifiedDiffByTurnId,
      inferredCheckpointTurnCountByTurnId,
      verboseChatMode,
      diffWordWrap,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    }),
    [
      activeTurnInProgress,
      activeTurnId,
      isWorking,
      isRevertingCheckpoint,
      completionSummary,
      timestampFormat,
      routeThreadKey,
      markdownCwd,
      resolvedTheme,
      workspaceRoot,
      activeThreadEnvironmentId,
      activeThreadId,
      turnDiffSummaryByTurnId,
      liveUnifiedDiffByTurnId,
      inferredCheckpointTurnCountByTurnId,
      verboseChatMode,
      diffWordWrap,
      onRevertUserMessage,
      onImageExpand,
      onOpenTurnDiff,
    ],
  );

  // Stable renderItem — no closure deps. Row components read shared state
  // from TimelineRowCtx, which propagates through LegendList's memo.
  const renderItem = useCallback(
    ({ item }: { item: MessagesTimelineRow }) => (
      <div className="mx-auto w-full min-w-0 max-w-3xl overflow-x-hidden" data-timeline-root="true">
        <TimelineRowContent row={item} />
      </div>
    ),
    [],
  );

  if (rows.length === 0 && !isWorking) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground/30">
          Send a message to start the conversation.
        </p>
      </div>
    );
  }

  return (
    <TimelineRowCtx.Provider value={sharedState}>
      <LegendList<MessagesTimelineRow>
        ref={listRef}
        data={rows}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        estimatedItemSize={90}
        initialScrollAtEnd
        maintainScrollAtEnd
        maintainScrollAtEndThreshold={0.1}
        maintainVisibleContentPosition
        onScroll={handleScroll}
        className="h-full overflow-x-hidden overscroll-y-contain px-3 sm:px-5"
        ListHeaderComponent={<div className="h-3 sm:h-4" />}
        ListFooterComponent={<div className="h-3 sm:h-4" />}
      />
    </TimelineRowCtx.Provider>
  );
});

function keyExtractor(item: MessagesTimelineRow) {
  return item.id;
}

// ---------------------------------------------------------------------------
// TimelineRowContent — the actual row component
// ---------------------------------------------------------------------------

type TimelineEntry = ReturnType<typeof deriveTimelineEntries>[number];
type TimelineMessage = Extract<TimelineEntry, { kind: "message" }>["message"];
type TimelineWorkEntry = Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"][number];
type TimelineRow = MessagesTimelineRow;

function TimelineRowContent({ row }: { row: TimelineRow }) {
  const ctx = use(TimelineRowCtx);

  return (
    <div
      className={cn(
        "pb-4",
        row.kind === "message" && row.message.role === "assistant" ? "group/assistant" : null,
      )}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind}
      data-message-id={row.kind === "message" ? row.message.id : undefined}
      data-message-role={row.kind === "message" ? row.message.role : undefined}
    >
      {row.kind === "work" && (
        <WorkGroupSection groupedEntries={row.groupedEntries} turnId={row.turnId ?? null} />
      )}

      {row.kind === "message" &&
        row.message.role === "user" &&
        (() => {
          const userImages = row.message.attachments ?? [];
          const displayedUserMessage = deriveDisplayedUserMessageState(row.message.text);
          const terminalContexts = displayedUserMessage.contexts;
          const canRevertAgentWork = typeof row.revertTurnCount === "number";
          return (
            <div className="flex justify-end">
              <div className="group relative max-w-[80%] border border-info/35 bg-secondary/80 px-4 py-3 shadow-[0_0_10px_color-mix(in_srgb,var(--theme-secondary)_12%,transparent)]">
                <span className="pointer-events-none absolute -left-px -top-px size-2.5 border-l-2 border-t-2 border-info" />
                <span className="pointer-events-none absolute -bottom-px -right-px size-2.5 border-b-2 border-r-2 border-primary" />
                {userImages.length > 0 && (
                  <div className="mb-2 grid max-w-[420px] grid-cols-2 gap-2">
                    {userImages.map(
                      (image: NonNullable<TimelineMessage["attachments"]>[number]) => (
                        <div
                          key={image.id}
                          className="overflow-hidden border border-border/80 bg-background/70"
                        >
                          {image.previewUrl ? (
                            <button
                              type="button"
                              className="h-full w-full cursor-zoom-in"
                              aria-label={`Preview ${image.name}`}
                              onClick={() => {
                                const preview = buildExpandedImagePreview(userImages, image.id);
                                if (!preview) return;
                                ctx.onImageExpand(preview);
                              }}
                            >
                              <img
                                src={image.previewUrl}
                                alt={image.name}
                                className="block h-auto max-h-[220px] w-full object-cover"
                              />
                            </button>
                          ) : (
                            <div className="flex min-h-[72px] items-center justify-center px-2 py-3 text-center text-[11px] text-muted-foreground/70">
                              {image.name}
                            </div>
                          )}
                        </div>
                      ),
                    )}
                  </div>
                )}
                {(displayedUserMessage.visibleText.trim().length > 0 ||
                  terminalContexts.length > 0) && (
                  <UserMessageBody
                    text={displayedUserMessage.visibleText}
                    terminalContexts={terminalContexts}
                  />
                )}
                <div className="mt-1.5 flex items-center justify-end gap-2">
                  <div className="flex items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover:opacity-100">
                    {displayedUserMessage.copyText && (
                      <MessageCopyButton text={displayedUserMessage.copyText} />
                    )}
                    {canRevertAgentWork && (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={ctx.isRevertingCheckpoint || ctx.isWorking}
                        onClick={() => ctx.onRevertUserMessage(row.message.id)}
                        title="Revert to this message"
                      >
                        <Undo2Icon className="size-3" />
                      </Button>
                    )}
                  </div>
                  <p className="text-right text-xs text-muted-foreground/50">
                    {formatTimestamp(row.message.createdAt, ctx.timestampFormat)}
                  </p>
                </div>
              </div>
            </div>
          );
        })()}

      {row.kind === "message" &&
        row.message.role === "assistant" &&
        (() => {
          const messageText = row.message.text || (row.message.streaming ? "" : "(empty response)");
          const assistantTurnStillInProgress =
            ctx.activeTurnInProgress &&
            ctx.activeTurnId !== null &&
            ctx.activeTurnId !== undefined &&
            row.message.turnId === ctx.activeTurnId;
          const assistantCopyState = resolveAssistantMessageCopyState({
            text: row.message.text ?? null,
            showCopyButton: row.showAssistantCopyButton,
            streaming: row.message.streaming || assistantTurnStillInProgress,
          });
          return (
            <>
              {row.showCompletionDivider && (
                <div className="my-3 flex items-center gap-3">
                  <span className="h-px flex-1 bg-border" />
                  <span className="border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-muted-foreground/80">
                    {ctx.completionSummary ? `Response | ${ctx.completionSummary}` : "Response"}
                  </span>
                  <span className="h-px flex-1 bg-border" />
                </div>
              )}
              <div className="min-w-0 px-1 py-0.5">
                <ChatMarkdown
                  text={messageText}
                  cwd={ctx.markdownCwd}
                  isStreaming={Boolean(row.message.streaming)}
                />
                <AssistantChangedFilesSection
                  turnSummary={row.assistantTurnDiffSummary}
                  routeThreadKey={ctx.routeThreadKey}
                  resolvedTheme={ctx.resolvedTheme}
                  onOpenTurnDiff={ctx.onOpenTurnDiff}
                />
                <div className="mt-1.5 flex items-center gap-2">
                  <p className="text-[10px] text-muted-foreground/30">
                    {row.message.streaming ? (
                      <LiveMessageMeta
                        createdAt={row.message.createdAt}
                        durationStart={row.durationStart}
                        timestampFormat={ctx.timestampFormat}
                      />
                    ) : (
                      formatMessageMeta(
                        row.message.createdAt,
                        formatElapsed(row.durationStart, row.message.completedAt),
                        ctx.timestampFormat,
                      )
                    )}
                  </p>
                  {assistantCopyState.visible ? (
                    <div className="flex items-center opacity-0 transition-opacity duration-200  group-hover/assistant:opacity-100">
                      <MessageCopyButton
                        text={assistantCopyState.text ?? ""}
                        size="icon-xs"
                        variant="outline"
                        className="border-border/50 bg-background/35 text-muted-foreground/45 shadow-none hover:border-border/70 hover:bg-background/55 hover:text-muted-foreground/70"
                      />
                    </div>
                  ) : null}
                </div>
              </div>
            </>
          );
        })()}

      {row.kind === "proposed-plan" && (
        <div className="min-w-0 px-1 py-0.5">
          <ProposedPlanCard
            planMarkdown={row.proposedPlan.planMarkdown}
            environmentId={ctx.activeThreadEnvironmentId}
            cwd={ctx.markdownCwd}
            workspaceRoot={ctx.workspaceRoot}
          />
        </div>
      )}

      {row.kind === "working" && (
        <div className="py-0.5 pl-1.5">
          <div
            className={cn(
              "flex items-center gap-2 pt-1",
              ctx.verboseChatMode
                ? "text-xs font-medium text-info/85"
                : "text-[11px] text-muted-foreground/70",
            )}
          >
            <span className="inline-flex items-center gap-[3px]">
              {ctx.verboseChatMode ? (
                <>
                  <span className="verbose-dot verbose-dot-1 h-1.5 w-1.5 rounded-full bg-info/70" />
                  <span className="verbose-dot verbose-dot-2 h-1.5 w-1.5 rounded-full bg-info/70" />
                  <span className="verbose-dot verbose-dot-3 h-1.5 w-1.5 rounded-full bg-info/70" />
                </>
              ) : (
                <>
                  <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse" />
                  <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:200ms]" />
                  <span className="h-1 w-1 rounded-full bg-muted-foreground/30 animate-pulse [animation-delay:400ms]" />
                </>
              )}
            </span>
            <span>
              {row.createdAt ? (
                <>
                  Working for <WorkingTimer createdAt={row.createdAt} />
                  {ctx.verboseChatMode ? <span className="ml-1 opacity-80">· live</span> : null}
                </>
              ) : (
                "Working..."
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Self-ticking components — bypass LegendList memoisation entirely.
// Each owns a `nowMs` state value consumed in the render output so the
// React Compiler cannot elide the re-render as a no-op.
// ---------------------------------------------------------------------------

/** Live "Working for Xs" label. */
function WorkingTimer({ createdAt }: { createdAt: string }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [createdAt]);
  return <>{formatWorkingTimer(createdAt, new Date(nowMs).toISOString()) ?? "0s"}</>;
}

/** Live timestamp + elapsed duration for a streaming assistant message. */
function LiveMessageMeta({
  createdAt,
  durationStart,
  timestampFormat,
}: {
  createdAt: string;
  durationStart: string | null | undefined;
  timestampFormat: TimestampFormat;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [durationStart]);
  const elapsed = durationStart
    ? formatElapsed(durationStart, new Date(nowMs).toISOString())
    : null;
  return <>{formatMessageMeta(createdAt, elapsed, timestampFormat)}</>;
}

// ---------------------------------------------------------------------------
// Extracted row sections — own their state / store subscriptions so changes
// re-render only the affected row, not the entire list.
// ---------------------------------------------------------------------------

/** Owns its own expand/collapse state so toggling re-renders only this row.
 *  State resets on unmount which is fine — work groups start collapsed.
 *
 *  In verbose mode, the work-log overflow cap is lifted (every entry is
 *  visible without a "Show N more" button) and each row renders as the
 *  expanded VerboseWorkEntryRow card. The verbose render path is split
 *  into a child component (`VerboseWorkEntryList`) so the per-turn diff
 *  fetch only runs when verbose is on — keeping `useQuery` out of the
 *  non-verbose path means tests + non-verbose usage need no
 *  QueryClientProvider for the work-log subtree. */
const WorkGroupSection = memo(function WorkGroupSection({
  groupedEntries,
  turnId,
}: {
  groupedEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  turnId: TurnId | null;
}) {
  const { workspaceRoot, verboseChatMode } = use(TimelineRowCtx);
  const [isExpanded, setIsExpanded] = useState(false);
  const overflowGated = !verboseChatMode;
  const hasOverflow = overflowGated && groupedEntries.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleEntries =
    hasOverflow && !isExpanded
      ? groupedEntries.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES)
      : groupedEntries;
  const hiddenCount = groupedEntries.length - visibleEntries.length;
  const onlyToolEntries = groupedEntries.every((entry) => entry.tone === "tool");
  const showHeader = hasOverflow || !onlyToolEntries || verboseChatMode;
  const groupLabel = onlyToolEntries ? "Tool calls" : "Work log";

  return (
    <div className="border border-border/60 bg-card/45 px-2 py-1.5 shadow-[var(--glow-standard)]">
      {showHeader && (
        <div className="mb-1.5 flex items-center justify-between gap-2 px-0.5">
          <p className="text-[9px] uppercase tracking-[0.16em] text-muted-foreground/55">
            {groupLabel} ({groupedEntries.length})
          </p>
          {hasOverflow && (
            <button
              type="button"
              className="text-[9px] uppercase tracking-[0.12em] text-muted-foreground/55 transition-colors duration-150 hover:text-foreground/75"
              onClick={() => setIsExpanded((v) => !v)}
            >
              {isExpanded ? "Show less" : `Show ${hiddenCount} more`}
            </button>
          )}
        </div>
      )}
      <div className={verboseChatMode ? "space-y-1.5" : "space-y-0.5"}>
        {verboseChatMode ? (
          <VerboseWorkEntryList visibleEntries={visibleEntries} turnId={turnId} />
        ) : (
          visibleEntries.map((workEntry) => (
            <SimpleWorkEntryRow
              key={`work-row:${workEntry.id}`}
              workEntry={workEntry}
              workspaceRoot={workspaceRoot}
            />
          ))
        )}
      </div>
    </div>
  );
});

/**
 * Verbose-only render path for the visible work entries. Only mounts in
 * verbose mode, so the per-turn `useParsedTurnDiff` hook (and therefore
 * `useQuery`) only ever runs when verbose is on — non-verbose renders
 * (including most of the test suite) don't need a QueryClientProvider in
 * the work-log subtree.
 *
 * Resolves the live `TurnDiffSummary` and `checkpointTurnCount` AT RENDER
 * TIME from `turnDiffSummaryByTurnId` / `inferredCheckpointTurnCountByTurnId`
 * (both passed via context). This keeps the inline diff fetch in sync with
 * the live summary state — when the summary's `assistantMessageId`
 * binding lands later, the lookup picks it up on the next render.
 *
 * Single fetch per turn here, fanned out via prop to each
 * VerboseWorkEntryRow which slices the parsed files by its own
 * `changedFiles` to render inline diffs in place.
 */
const VerboseWorkEntryList = memo(function VerboseWorkEntryList({
  visibleEntries,
  turnId,
}: {
  visibleEntries: Extract<MessagesTimelineRow, { kind: "work" }>["groupedEntries"];
  turnId: TurnId | null;
}) {
  const {
    workspaceRoot,
    diffWordWrap,
    resolvedTheme,
    activeThreadEnvironmentId,
    activeThreadId,
    turnDiffSummaryByTurnId,
    liveUnifiedDiffByTurnId,
    inferredCheckpointTurnCountByTurnId,
    activeTurnInProgress,
    onOpenTurnDiff,
  } = use(TimelineRowCtx);

  // Resolve the live summary by turnId — re-runs whenever the map changes
  // (e.g. when a streaming turn's TurnDiffSummary first lands or its
  // checkpointTurnCount is updated server-side). The work row never caches
  // the summary itself, only the turnId, so there's no stale-row problem.
  const resolvedSummary = turnId !== null ? turnDiffSummaryByTurnId.get(turnId) : undefined;
  // Match the fallback pattern used by ChatView and DiffPanel: prefer the
  // server-stamped checkpointTurnCount, fall back to the inferred ordinal
  // computed locally from `turnDiffSummaries`. Without this fallback,
  // turns whose summary lacks `checkpointTurnCount` (a common case during
  // and shortly after a turn) never enable the inline diff query.
  const resolvedCheckpointTurnCount =
    resolvedSummary?.checkpointTurnCount ??
    (turnId !== null ? inferredCheckpointTurnCountByTurnId[turnId] : undefined);

  const groupHasFileEdits = useMemo(
    () => visibleEntries.some((entry) => (entry.changedFiles?.length ?? 0) > 0),
    [visibleEntries],
  );
  const liveUnifiedDiff = turnId !== null ? (liveUnifiedDiffByTurnId.get(turnId) ?? null) : null;
  const hasLiveUnifiedDiff = (liveUnifiedDiff?.trim().length ?? 0) > 0;
  const shouldFetchTurnDiff =
    groupHasFileEdits &&
    turnId !== null &&
    (hasLiveUnifiedDiff ||
      (activeThreadId !== null && typeof resolvedCheckpointTurnCount === "number"));

  const parsedTurnDiff = useParsedTurnDiff({
    environmentId: shouldFetchTurnDiff ? activeThreadEnvironmentId : null,
    threadId: shouldFetchTurnDiff ? activeThreadId : null,
    turnId: shouldFetchTurnDiff ? turnId : null,
    checkpointTurnCount: shouldFetchTurnDiff ? resolvedCheckpointTurnCount : undefined,
    liveUnifiedDiff: shouldFetchTurnDiff ? liveUnifiedDiff : null,
    preferLive: activeTurnInProgress,
  });
  const parsedTurnDiffResult = shouldFetchTurnDiff ? parsedTurnDiff : null;

  return (
    <>
      {visibleEntries.map((workEntry) => (
        <VerboseWorkEntryRow
          key={`work-row:${workEntry.id}`}
          workEntry={workEntry}
          workspaceRoot={workspaceRoot}
          parsedTurnDiff={parsedTurnDiffResult}
          turnIdForDiff={turnId}
          resolvedTheme={resolvedTheme}
          diffWordWrap={diffWordWrap}
          activeTurnInProgress={activeTurnInProgress}
          onOpenTurnDiff={onOpenTurnDiff}
        />
      ))}
    </>
  );
});

/** Subscribes directly to the UI state store for expand/collapse state,
 *  so toggling re-renders only this component — not the entire list.
 *
 *  In verbose chat mode, the actual inline diff hunks are rendered per
 *  work entry (in VerboseWorkEntryRow) right where each edit happened.
 *  This summary section keeps the file tree as a turn-level overview /
 *  navigation aid — clicking a file routes to the side DiffPanel for the
 *  full virtualized view. */
const AssistantChangedFilesSection = memo(function AssistantChangedFilesSection({
  turnSummary,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary | undefined;
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  if (!turnSummary) return null;
  const checkpointFiles = turnSummary.files;
  if (checkpointFiles.length === 0) return null;

  return (
    <AssistantChangedFilesSectionInner
      turnSummary={turnSummary}
      checkpointFiles={checkpointFiles}
      routeThreadKey={routeThreadKey}
      resolvedTheme={resolvedTheme}
      onOpenTurnDiff={onOpenTurnDiff}
    />
  );
});

/** Inner component that only mounts when there are actual changed files,
 *  so the store subscription is unconditional (no hooks after early return). */
function AssistantChangedFilesSectionInner({
  turnSummary,
  checkpointFiles,
  routeThreadKey,
  resolvedTheme,
  onOpenTurnDiff,
}: {
  turnSummary: TurnDiffSummary;
  checkpointFiles: TurnDiffSummary["files"];
  routeThreadKey: string;
  resolvedTheme: "light" | "dark";
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const allDirectoriesExpanded = useUiStateStore(
    (store) => store.threadChangedFilesExpandedById[routeThreadKey]?.[turnSummary.turnId] ?? true,
  );
  const setExpanded = useUiStateStore((store) => store.setThreadChangedFilesExpanded);
  const summaryStat = summarizeTurnDiffStats(checkpointFiles);
  const changedFileCountLabel = String(checkpointFiles.length);

  return (
    <div className="mt-2 border border-border/80 bg-card/45 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/65">
          <span>Changed files ({changedFileCountLabel})</span>
          {hasNonZeroStat(summaryStat) && (
            <>
              <span className="mx-1">|</span>
              <DiffStatLabel additions={summaryStat.additions} deletions={summaryStat.deletions} />
            </>
          )}
        </p>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant="outline"
            data-scroll-anchor-ignore
            onClick={() => setExpanded(routeThreadKey, turnSummary.turnId, !allDirectoriesExpanded)}
          >
            {allDirectoriesExpanded ? "Collapse all" : "Expand all"}
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnSummary.turnId, checkpointFiles[0]?.path)}
          >
            View diff
          </Button>
        </div>
      </div>
      <ChangedFilesTree
        key={`changed-files-tree:${turnSummary.turnId}`}
        turnId={turnSummary.turnId}
        files={checkpointFiles}
        allDirectoriesExpanded={allDirectoriesExpanded}
        resolvedTheme={resolvedTheme}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

const UserMessageTerminalContextInlineLabel = memo(
  function UserMessageTerminalContextInlineLabel(props: { context: ParsedTerminalContextEntry }) {
    const tooltipText =
      props.context.body.length > 0
        ? `${props.context.header}\n${props.context.body}`
        : props.context.header;

    return <TerminalContextInlineChip label={props.context.header} tooltipText={tooltipText} />;
  },
);

const UserMessageBody = memo(function UserMessageBody(props: {
  text: string;
  terminalContexts: ParsedTerminalContextEntry[];
}) {
  if (props.terminalContexts.length > 0) {
    const hasEmbeddedInlineLabels = textContainsInlineTerminalContextLabels(
      props.text,
      props.terminalContexts,
    );
    const inlinePrefix = buildInlineTerminalContextText(props.terminalContexts);
    const inlineNodes: ReactNode[] = [];

    if (hasEmbeddedInlineLabels) {
      let cursor = 0;

      for (const context of props.terminalContexts) {
        const label = formatInlineTerminalContextLabel(context.header);
        const matchIndex = props.text.indexOf(label, cursor);
        if (matchIndex === -1) {
          inlineNodes.length = 0;
          break;
        }
        if (matchIndex > cursor) {
          inlineNodes.push(
            <span key={`user-terminal-context-inline-before:${context.header}:${cursor}`}>
              {props.text.slice(cursor, matchIndex)}
            </span>,
          );
        }
        inlineNodes.push(
          <UserMessageTerminalContextInlineLabel
            key={`user-terminal-context-inline:${context.header}`}
            context={context}
          />,
        );
        cursor = matchIndex + label.length;
      }

      if (inlineNodes.length > 0) {
        if (cursor < props.text.length) {
          inlineNodes.push(
            <span key={`user-message-terminal-context-inline-rest:${cursor}`}>
              {props.text.slice(cursor)}
            </span>,
          );
        }

        return (
          <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
            {inlineNodes}
          </div>
        );
      }
    }

    for (const context of props.terminalContexts) {
      inlineNodes.push(
        <UserMessageTerminalContextInlineLabel
          key={`user-terminal-context-inline:${context.header}`}
          context={context}
        />,
      );
      inlineNodes.push(
        <span key={`user-terminal-context-inline-space:${context.header}`} aria-hidden="true">
          {" "}
        </span>,
      );
    }

    if (props.text.length > 0) {
      inlineNodes.push(<span key="user-message-terminal-context-inline-text">{props.text}</span>);
    } else if (inlinePrefix.length === 0) {
      return null;
    }

    return (
      <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
        {inlineNodes}
      </div>
    );
  }

  if (props.text.length === 0) {
    return null;
  }

  return (
    <div className="whitespace-pre-wrap wrap-break-word text-sm leading-relaxed text-foreground">
      {props.text}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Structural sharing — reuse old row references when data hasn't changed
// so LegendList (and React) can skip re-rendering unchanged items.
// ---------------------------------------------------------------------------

/** Returns a structurally-shared copy of `rows`: for each row whose content
 *  hasn't changed since last call, the previous object reference is reused. */
function useStableRows(rows: MessagesTimelineRow[]): MessagesTimelineRow[] {
  const prevState = useRef<StableMessagesTimelineRowsState>({
    byId: new Map<string, MessagesTimelineRow>(),
    result: [],
  });

  return useMemo(() => {
    const nextState = computeStableMessagesTimelineRows(rows, prevState.current);
    prevState.current = nextState;
    return nextState.result;
  }, [rows]);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function formatWorkingTimer(startIso: string, endIso: string): string | null {
  const startedAtMs = Date.parse(startIso);
  const endedAtMs = Date.parse(endIso);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) {
    return null;
  }

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }

  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;

  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function formatMessageMeta(
  createdAt: string,
  duration: string | null,
  timestampFormat: TimestampFormat,
): string {
  if (!duration) return formatTimestamp(createdAt, timestampFormat);
  return `${formatTimestamp(createdAt, timestampFormat)} | ${duration}`;
}

function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  icon: LucideIcon;
  className: string;
} {
  if (tone === "error") {
    return {
      icon: CircleAlertIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      icon: BotIcon,
      className: "text-foreground/92",
    };
  }
  if (tone === "info") {
    return {
      icon: CheckIcon,
      className: "text-foreground/92",
    };
  }
  return {
    icon: ZapIcon,
    className: "text-foreground/92",
  };
}

function workToneClass(tone: "thinking" | "tool" | "info" | "error"): string {
  if (tone === "error") return "text-rose-300/50 dark:text-rose-300/50";
  if (tone === "tool") return "text-muted-foreground/70";
  if (tone === "thinking") return "text-muted-foreground/50";
  return "text-muted-foreground/40";
}

function workEntryPreview(
  workEntry: Pick<TimelineWorkEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
) {
  if (workEntry.command) return workEntry.command;
  if (workEntry.detail) return workEntry.detail;
  if ((workEntry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = workEntry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return workEntry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${workEntry.changedFiles!.length - 1} more`;
}

function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

function workEntryIcon(workEntry: TimelineWorkEntry): LucideIcon {
  if (workEntry.requestKind === "command") return TerminalIcon;
  if (workEntry.requestKind === "file-read") return EyeIcon;
  if (workEntry.requestKind === "file-change") return SquarePenIcon;

  if (workEntry.itemType === "command_execution" || workEntry.command) {
    return TerminalIcon;
  }
  if (workEntry.itemType === "file_change" || (workEntry.changedFiles?.length ?? 0) > 0) {
    return SquarePenIcon;
  }
  if (workEntry.itemType === "web_search") return GlobeIcon;
  if (workEntry.itemType === "image_view") return EyeIcon;

  switch (workEntry.itemType) {
    case "mcp_tool_call":
      return WrenchIcon;
    case "dynamic_tool_call":
    case "collab_agent_tool_call":
      return HammerIcon;
  }

  return workToneIcon(workEntry.tone).icon;
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function toolWorkEntryHeading(workEntry: TimelineWorkEntry): string {
  if (!workEntry.toolTitle) {
    return capitalizePhrase(normalizeCompactToolLabel(workEntry.label));
  }
  return capitalizePhrase(normalizeCompactToolLabel(workEntry.toolTitle));
}

const SimpleWorkEntryRow = memo(function SimpleWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
}) {
  const { workEntry, workspaceRoot } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry);
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const hasChangedFiles = (workEntry.changedFiles?.length ?? 0) > 0;
  const previewIsChangedFiles = hasChangedFiles && !workEntry.command && !workEntry.detail;

  return (
    <div className="px-1 py-1">
      <div className="flex items-center gap-2 transition-[opacity,translate] duration-200">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3" />
        </span>
        <div className="min-w-0 flex-1 overflow-hidden">
          {rawCommand ? (
            <div className="max-w-full">
              <p
                className={cn(
                  "truncate text-xs leading-5",
                  workToneClass(workEntry.tone),
                  preview ? "text-muted-foreground/70" : "",
                )}
                title={displayText}
              >
                <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                  {heading}
                </span>
                {preview && (
                  <Tooltip>
                    <TooltipTrigger
                      closeDelay={0}
                      delay={75}
                      render={
                        <span className="max-w-full cursor-default text-muted-foreground/55 transition-colors hover:text-muted-foreground/75 focus-visible:text-muted-foreground/75">
                          {" "}
                          - {preview}
                        </span>
                      }
                    />
                    <TooltipPopup
                      align="start"
                      className="max-w-[min(56rem,calc(100vw-2rem))] px-0 py-0"
                      side="top"
                    >
                      <div className="max-w-[min(56rem,calc(100vw-2rem))] overflow-x-auto px-1.5 py-1 font-mono text-[11px] leading-4 whitespace-nowrap">
                        {rawCommand}
                      </div>
                    </TooltipPopup>
                  </Tooltip>
                )}
              </p>
            </div>
          ) : (
            <Tooltip>
              <TooltipTrigger
                className="block min-w-0 w-full text-left"
                title={displayText}
                aria-label={displayText}
              >
                <p
                  className={cn(
                    "truncate text-[11px] leading-5",
                    workToneClass(workEntry.tone),
                    preview ? "text-muted-foreground/70" : "",
                  )}
                >
                  <span className={cn("text-foreground/80", workToneClass(workEntry.tone))}>
                    {heading}
                  </span>
                  {preview && <span className="text-muted-foreground/55"> - {preview}</span>}
                </p>
              </TooltipTrigger>
              <TooltipPopup className="max-w-[min(720px,calc(100vw-2rem))]">
                <p className="whitespace-pre-wrap wrap-break-word text-xs leading-5">
                  {displayText}
                </p>
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
      </div>
      {hasChangedFiles && !previewIsChangedFiles && (
        <div className="mt-1 flex flex-wrap gap-1 pl-6">
          {workEntry.changedFiles?.slice(0, 4).map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="border border-border/55 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/75"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
          {(workEntry.changedFiles?.length ?? 0) > 4 && (
            <span className="px-1 text-[10px] text-muted-foreground/55">
              +{(workEntry.changedFiles?.length ?? 0) - 4}
            </span>
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Tone-coloured left border used by VerboseWorkEntryRow. Discriminates by
 * requestKind / itemType so bash, file edits, file reads, and errors each
 * get a distinct accent without introducing new theme tokens.
 */
function workEntryAccentBorderClass(workEntry: TimelineWorkEntry): string {
  if (workEntry.tone === "error") return "border-l-rose-400/60";
  if (
    workEntry.requestKind === "command" ||
    workEntry.itemType === "command_execution" ||
    workEntry.command
  ) {
    return "border-l-emerald-400/55";
  }
  if (
    workEntry.requestKind === "file-change" ||
    workEntry.itemType === "file_change" ||
    (workEntry.changedFiles?.length ?? 0) > 0
  ) {
    return "border-l-amber-400/55";
  }
  if (workEntry.requestKind === "file-read" || workEntry.itemType === "image_view") {
    return "border-l-sky-400/55";
  }
  if (workEntry.tone === "thinking") return "border-l-violet-400/55";
  return "border-l-muted-foreground/40";
}

/**
 * Verbose-mode counterpart to SimpleWorkEntryRow.
 *
 * Renders each work entry as an expanded card: tone-coloured left border,
 * heading + tool-name pill, full monospace command text without truncation,
 * and the complete list of changed-file chips. File-change entries render
 * their diff hunks below the card so the edit metadata and the actual patch
 * stay visually connected without nesting diff chrome inside the card.
 *
 * Active when ClientSettings.verboseChatMode is true. Animated entry on
 * mount via the verbose-card-enter keyframe (gated on prefers-reduced-motion).
 */
const VerboseWorkEntryRow = memo(function VerboseWorkEntryRow(props: {
  workEntry: TimelineWorkEntry;
  workspaceRoot: string | undefined;
  parsedTurnDiff: ParsedTurnDiffResult | null;
  turnIdForDiff: TurnId | null;
  resolvedTheme: "light" | "dark";
  diffWordWrap: boolean;
  activeTurnInProgress: boolean;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const {
    workEntry,
    workspaceRoot,
    parsedTurnDiff,
    turnIdForDiff,
    resolvedTheme,
    diffWordWrap,
    activeTurnInProgress,
    onOpenTurnDiff,
  } = props;
  const iconConfig = workToneIcon(workEntry.tone);
  const EntryIcon = workEntryIcon(workEntry);
  const heading = toolWorkEntryHeading(workEntry);
  const rawPreview = workEntryPreview(workEntry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const rawCommand = workEntryRawCommand(workEntry) ?? workEntry.command ?? null;
  const detail = workEntry.detail ?? null;
  const accentBorder = workEntryAccentBorderClass(workEntry);
  const changedFilesForRender = workEntry.changedFiles;
  const hasChangedFiles = (changedFilesForRender?.length ?? 0) > 0;
  const isFileChange = workEntry.itemType === "file_change" || hasChangedFiles;
  const displayHeading = isFileChange ? "File change" : heading;
  const displayPreview =
    isFileChange && heading !== "File change" ? heading : preview && !rawCommand ? preview : null;

  // Slice the per-turn parsed diff down to just the files this entry
  // touched. For a work entry that says "Edit src/foo.ts" we'll match a
  // single file; for a multi-file edit we'll match all of them. Empty when
  // the turn's diff isn't loaded yet (e.g. during streaming) or when the
  // entry didn't touch files. Memo deps reference `workEntry.changedFiles`
  // directly (stable identity from the entry) rather than a defaulted
  // local — defaulting to `[]` would re-create the array each render and
  // bust the memo. `workspaceRoot` is threaded through so absolute paths
  // from the activity payload normalize to workspace-relative for matching
  // against parsed-diff file names.
  const inlineDiffFiles = useMemo(
    () =>
      parsedTurnDiff
        ? filterParsedFilesByPaths(parsedTurnDiff.files, changedFilesForRender, workspaceRoot)
        : [],
    [parsedTurnDiff, changedFilesForRender, workspaceRoot],
  );
  const entryInlineDiffFiles = useMemo(() => {
    if (!workEntry.inlineDiffPatch) {
      return [];
    }
    return parseInlineUnifiedDiffFiles(workEntry.inlineDiffPatch, `work-entry:${workEntry.id}`);
  }, [workEntry.id, workEntry.inlineDiffPatch]);
  const inlineDiffFilesForRender =
    inlineDiffFiles.length > 0
      ? inlineDiffFiles
      : entryInlineDiffFiles.length > 0
        ? entryInlineDiffFiles
        : parsedTurnDiff?.files.length === 1
          ? parsedTurnDiff.files
          : inlineDiffFiles;

  const card = (
    <div
      data-verbose-file-change-card={isFileChange ? "true" : undefined}
      className={cn("verbose-card-enter border-l-2 bg-background/60 px-2.5 py-1.5", accentBorder)}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn("flex size-5 shrink-0 items-center justify-center", iconConfig.className)}
        >
          <EntryIcon className="size-3.5" />
        </span>
        <p
          className={cn(
            "min-w-0 flex-1 truncate text-xs leading-5 text-foreground/90",
            workToneClass(workEntry.tone),
          )}
        >
          <span className="font-medium text-foreground/95">{displayHeading}</span>
          {displayPreview ? (
            <span className="text-muted-foreground/65"> — {displayPreview}</span>
          ) : null}
        </p>
      </div>

      {rawCommand ? (
        <pre
          className={cn(
            "mt-1.5 ml-7 max-h-48 overflow-x-auto overflow-y-auto rounded-none border border-border/40 bg-[var(--cg-inset)] px-2 py-1.5",
            "whitespace-pre-wrap break-all font-mono text-[11px] leading-[1.45] text-foreground/85",
          )}
        >
          {rawCommand}
        </pre>
      ) : null}

      {detail && detail !== rawCommand ? (
        <p className="mt-1 ml-7 whitespace-pre-wrap break-words text-[11px] leading-[1.45] text-muted-foreground/75">
          {detail}
        </p>
      ) : null}

      {changedFilesForRender && changedFilesForRender.length > 0 ? (
        <div className="mt-1.5 ml-7 flex flex-wrap gap-1">
          {changedFilesForRender.map((filePath) => {
            const displayPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
            return (
              <span
                key={`${workEntry.id}:${filePath}`}
                className="border border-border/60 bg-background/75 px-1.5 py-0.5 font-mono text-[10px] text-foreground/80"
                title={displayPath}
              >
                {displayPath}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  if (!isFileChange) {
    return card;
  }

  return (
    <div data-verbose-file-change-block="true" className="verbose-card-enter">
      {card}
      <VerboseFileChangeDiffBlock
        changedFiles={changedFilesForRender}
        inlineDiffFiles={inlineDiffFilesForRender}
        parsedTurnDiff={parsedTurnDiff}
        turnIdForDiff={turnIdForDiff}
        activeTurnInProgress={activeTurnInProgress}
        resolvedTheme={resolvedTheme}
        diffWordWrap={diffWordWrap}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    </div>
  );
});

const VerboseFileChangeDiffBlock = memo(function VerboseFileChangeDiffBlock(props: {
  changedFiles: ReadonlyArray<string> | undefined;
  inlineDiffFiles: ReadonlyArray<FileDiffMetadata>;
  parsedTurnDiff: ParsedTurnDiffResult | null;
  turnIdForDiff: TurnId | null;
  activeTurnInProgress: boolean;
  resolvedTheme: "light" | "dark";
  diffWordWrap: boolean;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const {
    changedFiles,
    inlineDiffFiles,
    parsedTurnDiff,
    turnIdForDiff,
    activeTurnInProgress,
    resolvedTheme,
    diffWordWrap,
    onOpenTurnDiff,
  } = props;
  const hasChangedFiles = (changedFiles?.length ?? 0) > 0;

  if (!hasChangedFiles || turnIdForDiff === null) {
    return null;
  }

  const firstChangedFile = changedFiles?.[0];
  const statusAction =
    firstChangedFile !== undefined ? (
      <Button
        type="button"
        size="xs"
        variant="outline"
        onClick={() => onOpenTurnDiff(turnIdForDiff, firstChangedFile)}
      >
        View diff
      </Button>
    ) : null;

  let content: ReactNode = null;
  if (inlineDiffFiles.length > 0) {
    content = (
      <InlineFileDiffsList
        files={inlineDiffFiles}
        resolvedTheme={resolvedTheme}
        diffWordWrap={diffWordWrap}
        turnId={turnIdForDiff}
        onOpenTurnDiff={onOpenTurnDiff}
      />
    );
  } else if (parsedTurnDiff?.isLoading) {
    content = <VerboseDiffStatusRow label="Diff loading..." />;
  } else if (
    activeTurnInProgress &&
    parsedTurnDiff?.source !== "live" &&
    !parsedTurnDiff?.hasLiveDiff
  ) {
    content = <VerboseDiffStatusRow label="Waiting for live diff update..." />;
  } else if ((parsedTurnDiff?.files.length ?? 0) > 0) {
    content = (
      <VerboseDiffStatusRow label="Diff available in full turn view" action={statusAction} />
    );
  } else if (parsedTurnDiff?.error) {
    content = <VerboseDiffStatusRow label="Unable to render inline diff" action={statusAction} />;
  } else if (activeTurnInProgress) {
    content = <VerboseDiffStatusRow label="Waiting for diff update..." />;
  }

  if (!content) {
    return null;
  }

  return (
    <div
      data-verbose-file-change-diff-block="true"
      className="ml-7 border-l border-dashed border-warning/45 pl-3 pt-1"
    >
      {content}
    </div>
  );
});

function VerboseDiffStatusRow({ label, action }: { label: string; action?: ReactNode }) {
  return (
    <div className="mt-2 flex items-center justify-between gap-2 border border-dashed border-border/55 bg-card/35 px-2 py-1.5 text-[11px] text-muted-foreground/75">
      <span>{label}</span>
      {action}
    </div>
  );
}
