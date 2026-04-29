import { EnvironmentId, MessageId, TurnId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRef, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { LegendListRef } from "@legendapp/list/react";

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    _ref: React.ForwardedRef<LegendListRef>,
  ) {
    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name?: string | null; prevName?: string | null } }) => (
    <pre data-testid="file-diff">{fileDiff.name ?? fileDiff.prevName}</pre>
  ),
}));

function matchMedia() {
  return {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

beforeAll(() => {
  const classList = {
    add: () => {},
    remove: () => {},
    toggle: () => {},
    contains: () => false,
  };

  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", {
    documentElement: {
      classList,
      offsetHeight: 0,
    },
  });
});

const ACTIVE_THREAD_ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: () => {},
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ACTIVE_THREAD_ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light" as const,
    timestampFormat: "locale" as const,
    workspaceRoot: undefined,
    verboseChatMode: false,
    diffWordWrap: false,
    activeThreadId: null,
    turnDiffSummaryByTurnId: new Map(),
    liveUnifiedDiffByTurnId: new Map(),
    inferredCheckpointTurnCountByTurnId: {},
    onIsAtEndChange: () => {},
  };
}

function renderWithQueryClient(element: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>{element}</QueryClientProvider>,
  );
}

const LIVE_DIFF = [
  "diff --git a/src/file.ts b/src/file.ts",
  "index 1111111..2222222 100644",
  "--- a/src/file.ts",
  "+++ b/src/file.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
].join("\n");

const LIVE_DIFF_TWO_FILES = [
  LIVE_DIFF,
  "diff --git a/src/another.ts b/src/another.ts",
  "index 3333333..4444444 100644",
  "--- a/src/another.ts",
  "+++ b/src/another.ts",
  "@@ -1 +1 @@",
  "-before",
  "+after",
].join("\n");

describe("MessagesTimeline", () => {
  it("renders inline terminal labels with the composer chip UI", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "message",
            createdAt: "2026-03-17T19:12:28.000Z",
            message: {
              id: MessageId.make("message-2"),
              role: "user",
              text: [
                "yoo what's @terminal-1:1-5 mean",
                "",
                "<terminal_context>",
                "- Terminal 1 lines 1-5:",
                "  1 | julius@mac effect-http-ws-cli % bun i",
                "  2 | bun install v1.3.9 (cf6cdbbb)",
                "</terminal_context>",
              ].join("\n"),
              createdAt: "2026-03-17T19:12:28.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Terminal 1 lines 1-5");
    expect(markup).toContain("lucide-terminal");
    expect(markup).toContain("yoo what&#x27;s ");
  }, 20_000);

  it("renders context compaction entries in the normal work log", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Context compacted",
              tone: "info",
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Context compacted");
    expect(markup).toContain("Work log");
  });

  it("formats changed file paths from the workspace root", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-1",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Updated files",
              tone: "tool",
              changedFiles: ["C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts"],
            },
          },
        ]}
        workspaceRoot="C:/Users/mike/dev-stuff/t3code"
      />,
    );

    expect(markup).toContain("t3code/apps/web/src/session-logic.ts");
    expect(markup).not.toContain("C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts");
  });

  it("renders verbose file-change rows with the diff block outside the card", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderWithQueryClient(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        verboseChatMode
        liveUnifiedDiffByTurnId={new Map([[turnId, LIVE_DIFF]])}
        timelineEntries={[
          {
            id: "entry-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Edited file",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["src/file.ts"],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("File change");
    expect(markup).toContain('data-verbose-file-change-card="true"');
    expect(markup).toContain('data-verbose-file-change-diff-block="true"');
    expect(markup).toContain("src/file.ts");
    expect(markup.indexOf('data-verbose-file-change-card="true"')).toBeLessThan(
      markup.indexOf('data-verbose-file-change-diff-block="true"'),
    );
  });

  it("renders an immediate file-change hunk before live turn diffs arrive", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderWithQueryClient(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        verboseChatMode
        timelineEntries={[
          {
            id: "entry-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Edited file",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["src/file.ts"],
              inlineDiffPatch: LIVE_DIFF,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("src/file.ts");
    expect(markup).toContain('data-testid="file-diff"');
    expect(markup).not.toContain("Waiting for live diff update...");
  });

  it("keeps non-verbose file-change rows compact", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderToStaticMarkup(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "entry-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Edited file",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["src/file.ts"],
            },
          },
          {
            id: "entry-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "Done",
              turnId,
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).not.toContain('data-verbose-file-change-diff-block="true"');
  });

  it("renders a waiting state for active verbose file changes before live diffs arrive", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderWithQueryClient(
      <MessagesTimeline
        {...buildProps()}
        isWorking
        activeTurnInProgress
        activeTurnId={turnId}
        verboseChatMode
        timelineEntries={[
          {
            id: "entry-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Edited file",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["src/file.ts"],
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Waiting for live diff update...");
  });

  it("links to the full turn diff when live diff files do not match the work entry path", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const markup = renderWithQueryClient(
      <MessagesTimeline
        {...buildProps()}
        activeTurnInProgress
        activeTurnId={turnId}
        verboseChatMode
        liveUnifiedDiffByTurnId={new Map([[turnId, LIVE_DIFF_TWO_FILES]])}
        timelineEntries={[
          {
            id: "entry-work",
            kind: "work",
            createdAt: "2026-03-17T19:12:28.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-03-17T19:12:28.000Z",
              label: "Edited other file",
              tone: "tool",
              itemType: "file_change",
              changedFiles: ["src/other.ts"],
            },
          },
          {
            id: "entry-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: MessageId.make("assistant-1"),
              role: "assistant",
              text: "Done",
              turnId,
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Diff available in full turn view");
    expect(markup).toContain("View diff");
  });

  it("keeps assistant changed files as a summary section", async () => {
    const { MessagesTimeline } = await import("./MessagesTimeline");
    const turnId = TurnId.make("turn-1");
    const assistantMessageId = MessageId.make("assistant-1");
    const markup = renderWithQueryClient(
      <MessagesTimeline
        {...buildProps()}
        verboseChatMode
        turnDiffSummaryByAssistantMessageId={
          new Map([
            [
              assistantMessageId,
              {
                turnId,
                completedAt: "2026-03-17T19:12:32.000Z",
                assistantMessageId,
                checkpointTurnCount: 1,
                files: [{ path: "src/file.ts", kind: "modified", additions: 1, deletions: 1 }],
              },
            ],
          ])
        }
        timelineEntries={[
          {
            id: "entry-assistant",
            kind: "message",
            createdAt: "2026-03-17T19:12:30.000Z",
            message: {
              id: assistantMessageId,
              role: "assistant",
              text: "Done",
              turnId,
              createdAt: "2026-03-17T19:12:30.000Z",
              streaming: false,
            },
          },
        ]}
      />,
    );

    expect(markup).toContain("Changed files (1)");
    expect(markup).not.toContain('data-verbose-file-change-diff-block="true"');
  });
});
