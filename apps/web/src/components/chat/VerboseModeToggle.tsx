import { memo, useCallback } from "react";
import { SparklesIcon } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { useSettings, useUpdateSettings } from "~/hooks/useSettings";

/**
 * Verbose chat mode toggle — lives in the BranchToolbar (below the chat
 * composer), to the left of the worktree selector.
 *
 * Off (default): the timeline renders bash/edit entries as truncated lines
 * with hover tooltips and caps the work log at MAX_VISIBLE_WORK_LOG_ENTRIES.
 *
 * On: the timeline expands those entries into richer cards (full command
 * visible, all changed files listed, tone-coloured borders, **inline diff
 * hunks per file edit**) and removes the work-log cap. Preference persists
 * in ClientSettings.verboseChatMode.
 *
 * Self-contained: reads its own state via useSettings and writes via
 * useUpdateSettings, so the parent toolbar doesn't need any extra prop
 * plumbing. Sized at `xs` to match the BranchToolbar's other controls.
 */
export const VerboseModeToggle = memo(function VerboseModeToggle() {
  const verboseChatMode = useSettings((s) => s.verboseChatMode);
  const { updateSettings } = useUpdateSettings();
  const onToggle = useCallback(() => {
    updateSettings({ verboseChatMode: !verboseChatMode });
  }, [updateSettings, verboseChatMode]);

  const title = verboseChatMode
    ? "Verbose chat: ON — click to switch to compact view"
    : "Verbose chat: OFF — click to expand bash, edits, and live activity";

  return (
    <Button
      variant="ghost"
      size="xs"
      type="button"
      onClick={onToggle}
      title={title}
      aria-pressed={verboseChatMode}
      className={cn(
        "shrink-0 whitespace-nowrap font-medium",
        verboseChatMode
          ? "text-info hover:text-info-foreground"
          : "text-muted-foreground/70 hover:text-foreground/80",
      )}
    >
      <SparklesIcon className="size-3" />
      <span>Verbose</span>
    </Button>
  );
});
