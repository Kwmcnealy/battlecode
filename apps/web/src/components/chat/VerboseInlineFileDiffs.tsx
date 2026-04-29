import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, type FileDiffMetadata } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import type { EnvironmentId, ThreadId, TurnId } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { Button } from "../ui/button";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import {
  buildPatchCacheKey,
  DIFF_PANEL_UNSAFE_CSS,
  resolveDiffThemeName,
} from "~/lib/diffRendering";
import { cn } from "~/lib/utils";

/**
 * Verbose-mode inline diff infrastructure.
 *
 * The fetch + parse work is split out into the `useParsedTurnDiff` hook so a
 * single subscription per turn (lifted into `WorkGroupSection`) can feed
 * many per-entry renders cheaply. The render component (`InlineFileDiffsList`)
 * is pure — it takes already-parsed files and renders them with the same
 * `<FileDiff>` from `@pierre/diffs/react` that `DiffPanel` uses, so theming
 * and parsing stay perfectly consistent with the side panel view.
 *
 * Cache scope is `turn:<turnId>` so the inline view, the per-entry view,
 * and the side `DiffPanel` all share a single fetched patch.
 */

/**
 * Default cap on inline file rendering. `<FileDiff>` does syntax highlighting
 * and DOM-heavy rendering per file, so for huge changesets we surface a
 * "View full diff" affordance instead of inlining everything.
 */
export const DEFAULT_INLINE_FILE_CAP = 5;

export interface ParsedTurnDiffInput {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  turnId: TurnId | null;
  /**
   * checkpointTurnCount of the assistant turn whose diff we're rendering.
   * Together with `checkpointTurnCount - 1` this forms the [from, to] range
   * passed to `checkpointDiffQueryOptions`. When undefined (or any of the
   * other inputs are null), the hook reports
   * `{ files: [], isLoading: false, error: null }`.
   */
  checkpointTurnCount: number | undefined;
}

export interface ParsedTurnDiffResult {
  files: FileDiffMetadata[];
  isLoading: boolean;
  error: unknown;
}

/**
 * Fetch + parse a turn's checkpoint diff. Returns the unified list of
 * FileDiffMetadata (one per changed file in the patch). Designed to be
 * called once per work group (or per turn) and have its result fanned
 * out to many per-entry render sites — the underlying tanstack-query
 * cache dedupes identical scopes anyway, so calling it multiple times
 * is also safe.
 */
export function useParsedTurnDiff(input: ParsedTurnDiffInput): ParsedTurnDiffResult {
  const enabled =
    typeof input.checkpointTurnCount === "number" &&
    input.environmentId !== null &&
    input.threadId !== null &&
    input.turnId !== null;
  const cacheScope = enabled ? `turn:${input.turnId}` : "turn:disabled";

  const diffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId: input.environmentId,
      threadId: input.threadId,
      fromTurnCount: enabled ? Math.max(0, input.checkpointTurnCount! - 1) : null,
      toTurnCount: enabled ? input.checkpointTurnCount! : null,
      cacheScope,
      enabled,
    }),
  );

  const patch = diffQuery.data?.diff;
  const files = useMemo<FileDiffMetadata[]>(() => {
    if (!patch || patch.trim().length === 0) return [];
    try {
      const parsedPatches = parsePatchFiles(
        patch.trim(),
        buildPatchCacheKey(patch.trim(), cacheScope),
      );
      return parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    } catch {
      return [];
    }
  }, [patch, cacheScope]);

  return {
    files,
    isLoading: enabled && diffQuery.isLoading,
    error: diffQuery.error,
  };
}

/**
 * Pure-render list of inline `<FileDiff>` cards. Caller passes in already
 * parsed files (typically a slice filtered to a specific work entry's
 * `changedFiles`). Animations gate on prefers-reduced-motion via the
 * `verbose-card-enter` class.
 */
export const InlineFileDiffsList = memo(function InlineFileDiffsList(props: {
  files: ReadonlyArray<FileDiffMetadata>;
  resolvedTheme: "light" | "dark";
  diffWordWrap: boolean;
  /** Files beyond this count get folded into a "+N more" link. Defaults to 5. */
  capCount?: number;
  /** When the cap kicks in, the link routes here. */
  turnId: TurnId;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
}) {
  const { files, resolvedTheme, diffWordWrap, capCount, turnId, onOpenTurnDiff } = props;
  const cap = capCount ?? DEFAULT_INLINE_FILE_CAP;
  const visibleFiles = files.slice(0, cap);
  const hiddenCount = files.length - visibleFiles.length;

  if (files.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {visibleFiles.map((fileDiff) => {
        const filePath = resolveFileDiffPath(fileDiff);
        const fileKey = buildFileDiffRenderKey(fileDiff);
        return (
          <div
            key={`${fileKey}:${resolvedTheme}`}
            data-diff-file-path={filePath}
            className={cn(
              "diff-render-file overflow-hidden rounded-none border border-border/60",
              "verbose-card-enter",
            )}
          >
            <FileDiff
              fileDiff={fileDiff}
              options={{
                diffStyle: "unified",
                lineDiffType: "none",
                overflow: diffWordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                themeType: resolvedTheme,
                unsafeCSS: DIFF_PANEL_UNSAFE_CSS,
              }}
            />
          </div>
        );
      })}
      {hiddenCount > 0 ? (
        <div className="flex items-center justify-between gap-2 border border-dashed border-border/55 bg-card/35 px-2 py-1.5 text-[11px] text-muted-foreground/75">
          <span>
            +{hiddenCount} more file{hiddenCount === 1 ? "" : "s"} not shown inline
          </span>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => onOpenTurnDiff(turnId, files[cap]?.name)}
          >
            View full diff
          </Button>
        </div>
      ) : null}
    </div>
  );
});

/**
 * Filter parsed turn diff files down to a specific list of paths (a work
 * entry's `changedFiles`).
 *
 * The two sides this matches across come from different sources and are
 * formatted differently:
 *
 * - `paths`: usually absolute (e.g. `/Users/.../repo/apps/web/src/foo.ts`)
 *   because they're harvested from orchestration activity payloads with
 *   absolute file paths. May also be Windows-style (`C:\repo\...`) or
 *   workspace-relative depending on the provider.
 * - `files[i].name` / `prevName`: unified-diff-header form like
 *   `b/apps/web/src/foo.ts` (workspace-relative with `a/`/`b/` prefix).
 *
 * To match these robustly we normalize both sides through
 * `normalizePathForDiffMatch` (separators, Windows drive canonicalization,
 * workspace-root strip, `a/`/`b/` strip, leading-slash / `./` strip), then
 * accept either exact equality OR a "/-aware suffix match" (one is a
 * suffix of the other after a path separator). The suffix fallback covers
 * the case where `workspaceRoot` is not known to the caller — we'd still
 * match `apps/web/src/foo.ts` against `/Users/.../repo/apps/web/src/foo.ts`.
 */
export function filterParsedFilesByPaths(
  files: ReadonlyArray<FileDiffMetadata>,
  paths: ReadonlyArray<string> | undefined,
  workspaceRoot?: string,
): FileDiffMetadata[] {
  if (!paths || paths.length === 0) return [];
  const wanted = paths
    .map((p) => normalizePathForDiffMatch(p, workspaceRoot))
    .filter((p) => p.length > 0);
  if (wanted.length === 0) return [];
  const wantedSet = new Set(wanted);
  return files.filter((file) => {
    const candidates: string[] = [];
    if (file.name) candidates.push(normalizePathForDiffMatch(file.name, workspaceRoot));
    if (file.prevName) candidates.push(normalizePathForDiffMatch(file.prevName, workspaceRoot));
    for (const candidate of candidates) {
      if (candidate.length === 0) continue;
      if (wantedSet.has(candidate)) return true;
      for (const w of wanted) {
        if (candidate.endsWith(`/${w}`)) return true;
        if (w.endsWith(`/${candidate}`)) return true;
      }
    }
    return false;
  });
}

/**
 * Canonicalize a path for cross-source equality / suffix comparison.
 * Idempotent. Lowercases the workspace prefix only for the strip check
 * (preserves case in the returned path) so case-insensitive filesystems
 * (macOS/Windows) don't drop true matches.
 */
function normalizePathForDiffMatch(path: string, workspaceRoot: string | undefined): string {
  let result = path.replaceAll("\\", "/");
  // Canonicalize Windows drive paths like `/C:/foo` → `C:/foo`
  if (/^\/[A-Za-z]:\//.test(result)) result = result.slice(1);
  // Strip git unified-diff `a/`/`b/` prefix
  if (result.startsWith("a/") || result.startsWith("b/")) result = result.slice(2);
  // Strip workspace root prefix when known
  if (workspaceRoot) {
    let ws = workspaceRoot.replaceAll("\\", "/").replace(/[/\\]+$/, "");
    if (/^\/[A-Za-z]:\//.test(ws)) ws = ws.slice(1);
    const wsLower = ws.toLowerCase();
    const resultLower = result.toLowerCase();
    if (resultLower === wsLower) {
      result = "";
    } else if (wsLower.length > 0 && resultLower.startsWith(`${wsLower}/`)) {
      result = result.slice(ws.length + 1);
    }
  }
  // Strip leading `./` and `/`
  result = result.replace(/^\.\/+/, "").replace(/^\/+/, "");
  return result;
}

function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return stripGitPathPrefix(fileDiff.name ?? fileDiff.prevName ?? "");
}

function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

function stripGitPathPrefix(raw: string): string {
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}
