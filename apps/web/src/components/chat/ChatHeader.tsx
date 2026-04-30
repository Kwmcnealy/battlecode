import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { DiffIcon, MessageSquareIcon, TerminalSquareIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { ToggleGroup, Toggle as ToggleGroupItem } from "../ui/toggle-group";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import type { ThreadContentView } from "~/uiStateStore";

const TERMINAL_UNAVAILABLE_MESSAGE =
  "Terminal is unavailable until this thread has an active project.";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  activeContentView: ThreadContentView;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onContentViewChange: (view: ThreadContentView) => void;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  activeContentView,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onContentViewChange,
  onToggleTerminal,
  onToggleDiff,
}: ChatHeaderProps) {
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <ToggleGroup
          className="shrink-0 rounded-lg border border-border/70 bg-[color-mix(in_srgb,var(--cg-inset)_78%,var(--theme-primary)_7%)] p-0.5 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--theme-primary)_16%,transparent),0_1px_8px_color-mix(in_srgb,var(--cg-shell-bg)_72%,transparent)] [-webkit-app-region:no-drag]"
          variant="default"
          size="xs"
          value={[activeContentView]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "chat" || next === "terminal") {
              onContentViewChange(next);
            }
          }}
        >
          <ToggleGroupItem
            aria-label="Show chat view"
            className="h-7 min-w-7 rounded-md border border-transparent px-2.5 text-[11px] text-muted-foreground/85 shadow-none hover:bg-[color-mix(in_srgb,var(--theme-primary)_8%,var(--cg-card))] hover:text-foreground data-pressed:border-[color-mix(in_srgb,var(--theme-primary)_32%,var(--border))] data-pressed:bg-[color-mix(in_srgb,var(--theme-primary)_18%,var(--cg-card))] data-pressed:text-foreground data-pressed:shadow-[inset_0_1px_0_color-mix(in_srgb,var(--theme-primary)_20%,transparent),0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_12%,transparent)] sm:min-w-[4.75rem]"
            value="chat"
          >
            <MessageSquareIcon className="size-3.5" />
            <span className="hidden text-[11px] sm:inline">Chat</span>
          </ToggleGroupItem>
          <Tooltip>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  aria-label="Show terminal view"
                  className="h-7 min-w-7 rounded-md border border-transparent px-2.5 text-[11px] text-muted-foreground/85 shadow-none hover:bg-[color-mix(in_srgb,var(--theme-primary)_8%,var(--cg-card))] hover:text-foreground data-pressed:border-[color-mix(in_srgb,var(--theme-primary)_32%,var(--border))] data-pressed:bg-[color-mix(in_srgb,var(--theme-primary)_18%,var(--cg-card))] data-pressed:text-foreground data-pressed:shadow-[inset_0_1px_0_color-mix(in_srgb,var(--theme-primary)_20%,transparent),0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_12%,transparent)] sm:min-w-[5.75rem]"
                  value="terminal"
                  disabled={!terminalAvailable}
                >
                  <TerminalSquareIcon className="size-3.5" />
                  <span className="hidden text-[11px] sm:inline">Terminal</span>
                </ToggleGroupItem>
              }
            />
            <TooltipPopup side="bottom">
              {terminalAvailable ? "Show terminal view" : TERMINAL_UNAVAILABLE_MESSAGE}
            </TooltipPopup>
          </Tooltip>
        </ToggleGroup>
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground/95"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 rounded-lg border border-border/55 bg-[color-mix(in_srgb,var(--cg-inset)_64%,transparent)] px-1.5 py-1 shadow-[inset_0_1px_0_color-mix(in_srgb,var(--theme-primary)_10%,transparent)] @3xl/header-actions:gap-2.5">
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? TERMINAL_UNAVAILABLE_MESSAGE
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
