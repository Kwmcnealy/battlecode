# Sidebar Thread Provider Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a small provider icon (Codex/OpenAI, Claude, Cursor, OpenCode) on the left edge of every chat row in the sidebar, mirroring the same icons used by the composer model picker rail. Hovering the icon shows a tooltip with the exact provider + model.

**Architecture:** Each thread shell already carries a `modelSelection: { provider, model, options? }` from the orchestration server, but `SidebarThreadSummary` does not surface it. We extend the summary to include `modelSelection`, render a provider icon in `SidebarThreadRow` using the existing `PROVIDER_ICON_BY_PROVIDER` map (the source of truth for the composer rail icons), and look up the human-readable model name from `useServerProviders()` to build the tooltip. Pure-logic helpers live in `Sidebar.logic.ts` and are unit tested; the JSX wiring is added to `Sidebar.tsx`.

**Tech Stack:** React 19, Zustand, Effect Schema (contracts), TypeScript, Tailwind, Base UI tooltip primitives, Vitest. Workspace built with Bun + Turborepo. No new dependencies.

---

## Files

- Modify: `apps/web/src/types.ts` — add `modelSelection` to `SidebarThreadSummary`.
- Modify: `apps/web/src/store.ts` — populate `modelSelection` when mapping thread shells to summaries; extend `sidebarThreadSummariesEqual` to compare it cheaply.
- Modify: `apps/web/src/components/chat/providerIconUtils.ts` — add a small `getProviderModelTooltip` helper that builds the tooltip string from `(provider, slug, providers[])` so the row never has to know about server data shapes.
- Create: `apps/web/src/components/chat/providerIconUtils.test.ts` — Vitest unit tests for `getProviderModelTooltip` (no test file currently exists for this module).
- Modify: `apps/web/src/components/Sidebar.logic.ts` — add `resolveSidebarThreadProviderBadge(summary, providers)` that returns `{ provider, tooltip }` (pure, no React). Re-exports the icon component lookup.
- Modify: `apps/web/src/components/Sidebar.logic.test.ts` — unit tests for `resolveSidebarThreadProviderBadge`.
- Modify: `apps/web/src/components/Sidebar.tsx` — render the icon at the left of each row inside `SidebarThreadRow`, wrapped in the existing `Tooltip` primitive. Subscribe to `useServerProviders()` once at the parent and pass the array down (avoid per-row resubscribe).
- Modify: `apps/web/src/environmentGrouping.test.ts` — update the `makeSidebarThreadSummary` helper to include a default `modelSelection` (so tests still type-check).

One new file (`providerIconUtils.test.ts`). All other changes are surgical edits to existing files.

---

## Self-test commands (run after each task)

- Type check: `bun typecheck`
- Lint: `bun lint`
- Format: `bun fmt`
- Tests for the touched packages: `bun run test --filter @t3tools/web`

The repo guideline (AGENTS.md) requires `bun fmt`, `bun lint`, and `bun typecheck` to pass before considering a task done. **Never** run `bun test` directly — always `bun run test`.

---

## Task 1: Extend `SidebarThreadSummary` with `modelSelection`

**Files:**
- Modify: `apps/web/src/types.ts:141-158`

- [ ] **Step 1: Read the file**

Open `apps/web/src/types.ts`. Confirm the existing `SidebarThreadSummary` interface starts at line 141 with the fields shown in the plan context.

- [ ] **Step 2: Add the `modelSelection` field**

Edit the interface so that immediately below `interactionMode: ProviderInteractionMode;` (line 146) there is a new line:

```ts
  modelSelection: ModelSelection;
```

`ModelSelection` is already imported at the top of the file (line 3). No new import needed.

- [ ] **Step 3: Run the type checker**

Run: `bun typecheck`

Expected: failures in `apps/web/src/store.ts` (the `mapThreadShell` summary object missing `modelSelection`) and in `apps/web/src/environmentGrouping.test.ts` (the `makeSidebarThreadSummary` fixture missing the field). Those are intentional and addressed in Tasks 2 and 6.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/types.ts
git commit -m "feat(web): add modelSelection to SidebarThreadSummary"
```

---

## Task 2: Populate `modelSelection` in `mapThreadShell` summary and equality check

**Files:**
- Modify: `apps/web/src/store.ts:283-307` (the summary literal)
- Modify: `apps/web/src/store.ts:380-402` (the `sidebarThreadSummariesEqual` function)

- [ ] **Step 1: Add `modelSelection` to the summary literal**

In `mapThreadShell`, the shell already does `modelSelection: normalizeModelSelection(thread.modelSelection)`. Compute it once and reuse:

Find this block (around line 262):

```ts
  const shell: ThreadShell = {
    id: thread.id,
    environmentId,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: normalizeModelSelection(thread.modelSelection),
```

Replace the inline normalization with a hoisted local. The new code:

```ts
  const modelSelection = normalizeModelSelection(thread.modelSelection);
  const shell: ThreadShell = {
    id: thread.id,
    environmentId,
    codexThreadId: null,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection,
```

Then in the `summary` literal (line 283), insert immediately below `interactionMode: thread.interactionMode,`:

```ts
    modelSelection,
```

- [ ] **Step 2: Compare `modelSelection` in `sidebarThreadSummariesEqual`**

Find the existing comparison body (the `return` block at line 383). Add three new conjuncts after the existing `interactionMode` check, comparing only the meaningful fields (provider, model, options reference):

```ts
    left.modelSelection.provider === right.modelSelection.provider &&
    left.modelSelection.model === right.modelSelection.model &&
    left.modelSelection.options === right.modelSelection.options &&
```

Reference equality on `options` is intentional and matches the existing equality style (e.g. `latestTurn` compared by reference of nested fields). The store already calls `normalizeModelSelection` once per shell update, so identical shells produce identical references.

- [ ] **Step 3: Run the type checker**

Run: `bun typecheck`

Expected: only the test-fixture failure in `apps/web/src/environmentGrouping.test.ts` should remain.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/store.ts
git commit -m "feat(web): plumb modelSelection through SidebarThreadSummary mapping"
```

---

## Task 3: Update test fixture for `SidebarThreadSummary`

**Files:**
- Modify: `apps/web/src/environmentGrouping.test.ts:59-78`

- [ ] **Step 1: Add a default `modelSelection` to `makeSidebarThreadSummary`**

In the helper, insert a `modelSelection` default before the `...overrides` spread, using the canonical `codex` defaults so the value is valid against the `ModelSelection` schema without importing schema runtime helpers:

```ts
    modelSelection: { provider: "codex", model: "gpt-5.4" },
```

Note: `ModelSelection` is a discriminated union; the `codex` member only requires `{ provider, model }` (`options` is optional). No new imports.

- [ ] **Step 2: Run the type checker**

Run: `bun typecheck`

Expected: PASS (no remaining errors).

- [ ] **Step 3: Run tests for the fixture-using suite**

Run: `bun run test --filter @t3tools/web -- environmentGrouping`

Expected: existing tests still PASS — the new field is structural only.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/environmentGrouping.test.ts
git commit -m "test(web): default modelSelection in sidebar thread summary fixture"
```

---

## Task 4: Add `getProviderModelTooltip` helper

**Files:**
- Modify: `apps/web/src/components/chat/providerIconUtils.ts`

- [ ] **Step 1: Write the failing test**

There is no existing test file for `providerIconUtils.ts` (verified during planning). Create a new file at `apps/web/src/components/chat/providerIconUtils.test.ts` with the following content:

```ts
import { describe, expect, it } from "vitest";
import type { ServerProvider } from "@t3tools/contracts";
import { getProviderModelTooltip } from "./providerIconUtils";

const providers: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { state: "authenticated" } as ServerProvider["auth"],
    checkedAt: "2026-04-29T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  },
];

describe("getProviderModelTooltip", () => {
  it("returns 'Provider · Display Name' when the model is found", () => {
    expect(getProviderModelTooltip("codex", "gpt-5.4", providers)).toBe("Codex · GPT-5.4");
  });

  it("falls back to the slug when the model is missing from the provider list", () => {
    expect(getProviderModelTooltip("codex", "unknown-slug", providers)).toBe("Codex · unknown-slug");
  });

  it("uses the provider display name even with no providers", () => {
    expect(getProviderModelTooltip("claudeAgent", "claude-sonnet-4-6", [])).toBe(
      "Claude · claude-sonnet-4-6",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test --filter @t3tools/web -- providerIconUtils`

Expected: FAIL with `getProviderModelTooltip` undefined / module export missing.

- [ ] **Step 3: Implement `getProviderModelTooltip`**

Open `apps/web/src/components/chat/providerIconUtils.ts`. At the top, add the missing import:

```ts
import type { ServerProvider } from "@t3tools/contracts";
```

At the bottom of the file, add:

```ts
export function getProviderModelTooltip(
  provider: ProviderKind,
  modelSlug: string,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  const liveProvider = providers.find((candidate) => candidate.provider === provider);
  const model = liveProvider?.models.find((candidate) => candidate.slug === modelSlug);
  const modelLabel = model?.name ?? modelSlug;
  return `${providerLabel} · ${modelLabel}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test --filter @t3tools/web -- providerIconUtils`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/chat/providerIconUtils.ts apps/web/src/components/chat/providerIconUtils.test.ts
git commit -m "feat(web): add getProviderModelTooltip helper for sidebar provider badges"
```

---

## Task 5: Add `resolveSidebarThreadProviderBadge` to Sidebar logic

**Files:**
- Modify: `apps/web/src/components/Sidebar.logic.ts`
- Modify: `apps/web/src/components/Sidebar.logic.test.ts`

- [ ] **Step 1: Write the failing test**

Edit `apps/web/src/components/Sidebar.logic.test.ts`:

a) Inside the existing destructured import from `./Sidebar.logic` (lines 3-22), add `resolveSidebarThreadProviderBadge` (alphabetically after `resolveProjectStatusIndicator`).

b) Extend the existing `@t3tools/contracts` import (line 23) to also import the `ServerProvider` type:

```ts
import {
  EnvironmentId,
  OrchestrationLatestTurn,
  ProjectId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
```

c) Append the new `describe` block to the bottom of the file:

```ts
describe("resolveSidebarThreadProviderBadge", () => {
  const providers: ReadonlyArray<ServerProvider> = [
    {
      provider: "claudeAgent",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { state: "authenticated" } as ServerProvider["auth"],
      checkedAt: "2026-04-29T00:00:00.000Z",
      models: [
        {
          slug: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          isCustom: false,
          capabilities: null,
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ];

  it("returns the thread's modelSelection provider plus a polished tooltip", () => {
    const badge = resolveSidebarThreadProviderBadge(
      {
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      },
      providers,
    );
    expect(badge.provider).toBe("claudeAgent");
    expect(badge.tooltip).toBe("Claude · Claude Sonnet 4.6");
  });

  it("falls back to the slug when the providers array is empty", () => {
    const badge = resolveSidebarThreadProviderBadge(
      { modelSelection: { provider: "codex", model: "gpt-5.4" } },
      [],
    );
    expect(badge.provider).toBe("codex");
    expect(badge.tooltip).toBe("Codex · gpt-5.4");
  });
});
```

Add the import at the top of the test file (group with the existing `Sidebar.logic` import):

```ts
import { resolveSidebarThreadProviderBadge } from "./Sidebar.logic";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test --filter @t3tools/web -- Sidebar.logic`

Expected: FAIL — `resolveSidebarThreadProviderBadge` undefined.

- [ ] **Step 3: Implement `resolveSidebarThreadProviderBadge`**

In `apps/web/src/components/Sidebar.logic.ts`:

Add the imports near the top (group with the existing `import type { SidebarThreadSummary, Thread }`):

```ts
import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import { getProviderModelTooltip } from "../chat/providerIconUtils";
```

At the end of the file, add:

```ts
export interface SidebarThreadProviderBadge {
  provider: ProviderKind;
  tooltip: string;
}

export function resolveSidebarThreadProviderBadge(
  summary: Pick<SidebarThreadSummary, "modelSelection">,
  providers: ReadonlyArray<ServerProvider>,
): SidebarThreadProviderBadge {
  const { provider, model } = summary.modelSelection;
  return {
    provider,
    tooltip: getProviderModelTooltip(provider, model, providers),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test --filter @t3tools/web -- Sidebar.logic`

Expected: PASS (both new cases plus all existing cases).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Sidebar.logic.ts apps/web/src/components/Sidebar.logic.test.ts
git commit -m "feat(web): add resolveSidebarThreadProviderBadge selector"
```

---

## Task 6: Render the provider icon in `SidebarThreadRow`

**Files:**
- Modify: `apps/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Subscribe to `useServerProviders` once at the list level**

Find `SidebarProjectThreadList` (line 752). Near the top of its body (after the destructure block, around line 790), import and call `useServerProviders`:

At the top of the file, add to the existing `serverState` import:

```ts
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";
```

(There is already an `import { useServerKeybindings } from "../rpc/serverState";` at line 170 — just add `useServerProviders` next to it.)

Inside `SidebarProjectThreadList`, after the destructure, add:

```ts
  const providers = useServerProviders();
```

Then in the `<SidebarThreadRow ... />` JSX (around line 812), pass it through:

```tsx
              providers={providers}
```

- [ ] **Step 2: Add the `providers` prop to `SidebarThreadRowProps`**

In the `SidebarThreadRowProps` interface (line 260), add (near the other readonly inputs, after `appSettingsConfirmThreadArchive`):

```ts
  providers: ReadonlyArray<ServerProvider>;
```

Add to the existing contracts import at the top of the file (line 47):

```ts
import {
  type ContextMenuItem,
  type DesktopUpdateState,
  ProjectId,
  type ScopedThreadRef,
  type ServerProvider,
  type SidebarProjectGroupingMode,
  type ThreadEnvMode,
  ThreadId,
} from "@t3tools/contracts";
```

Also add `providers` to the destructure inside `SidebarThreadRow`:

Find:

```ts
  const {
    orderedProjectThreadKeys,
    isActive,
    jumpLabel,
    appSettingsConfirmThreadArchive,
    ...
```

Add `providers` near the top of the destructure (after `appSettingsConfirmThreadArchive`):

```ts
    providers,
```

- [ ] **Step 3: Compute the badge and import the icon registry**

Add to the existing imports at the top of `Sidebar.tsx`:

```ts
import { PROVIDER_ICON_BY_PROVIDER } from "./chat/providerIconUtils";
```

Update the existing logic import (around line 156–163) to also import the new selector:

```ts
import {
  getSidebarThreadIdsToPrewarm,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveSidebarThreadProviderBadge,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  useThreadJumpHintVisibility,
  ThreadStatusPill,
} from "./Sidebar.logic";
```

Inside `SidebarThreadRow`, near the other derived values (right after `const threadStatus = resolveThreadStatusPill(...)`, around line 367), add:

```ts
  const providerBadge = useMemo(
    () => resolveSidebarThreadProviderBadge(thread, providers),
    [thread, providers],
  );
  const ProviderBadgeIcon = PROVIDER_ICON_BY_PROVIDER[providerBadge.provider];
```

- [ ] **Step 4: Insert the icon at the left of the row content**

Find the row content block in the JSX (around line 549):

```tsx
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus && (
            ...
          )}
```

Insert the provider badge as the first child of that flex row (so it sits to the left of the PR icon, status pill, and thread title). The badge must:

- Use `size-3.5` (slightly larger than the size-3 PR/terminal indicators because this is the chat's primary identity marker).
- Be wrapped in `Tooltip` / `TooltipTrigger` / `TooltipPopup`, matching the existing PR-icon tooltip pattern.
- Not steal click events from the row — render the trigger as a plain `<span>` (not a `<button>`) so clicking still selects the thread.
- Mark the icon `aria-hidden="true"` since the visible label lives in the `aria-label` of the wrapper span and in the tooltip popup.

The Base UI `<TooltipTrigger render={…} />` element is self-closing and the icon goes **inside the rendered element** (just like the existing PR icon at `Sidebar.tsx:551-565`), not as a child of `<TooltipTrigger>` itself.

Insert this JSX immediately inside the `<div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">` opener (before the `{prStatus && (...)}` block):

```tsx
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  aria-label={providerBadge.tooltip}
                  className="inline-flex shrink-0 items-center justify-center text-muted-foreground/70"
                >
                  <ProviderBadgeIcon className="size-3.5" aria-hidden="true" />
                </span>
              }
            />
            <TooltipPopup side="top">{providerBadge.tooltip}</TooltipPopup>
          </Tooltip>
```

- [ ] **Step 5: Add `providers` to `SidebarProjectThreadListProps`**

Search for `interface SidebarProjectThreadListProps` (line 705). Add to the interface (alongside the other readonly inputs):

```ts
  providers: ReadonlyArray<ServerProvider>;
```

Wait — Step 1 derived `providers` *inside* `SidebarProjectThreadList` via `useServerProviders()`. That avoids prop drilling. Keep it that way: do **not** add `providers` to `SidebarProjectThreadListProps`. The hook lives inside the list component; the row receives `providers` via the existing `<SidebarThreadRow providers={providers} ... />` prop only.

If you discover the list component is itself memo-ized and skipping rerenders when providers change, the right fix is to subscribe inside the row instead — but only do that if a real render bug appears, since per-row hooks in long lists are more expensive.

- [ ] **Step 6: Run type check + lint + format**

Run: `bun typecheck && bun lint && bun fmt`

Expected: all PASS. If `bun fmt` rewrites whitespace, re-run `bun lint` after.

- [ ] **Step 7: Run the full web test suite**

Run: `bun run test --filter @t3tools/web`

Expected: PASS. The render code is JSX-only with no logic-only tests; the unit-tested helpers (Tasks 4 & 5) provide the safety net.

- [ ] **Step 8: Manual smoke test**

Start the dev server (`bun dev` or your usual flow) and verify visually:
- Each chat row shows a provider icon at the far left.
- Codex threads show the OpenAI icon; Claude threads show the Claude icon; Cursor and OpenCode show their icons.
- Hovering the icon shows a tooltip in the format `Codex · GPT-5.4` (provider · model display name).
- Tooltip text reflects the *current* `modelSelection` for the thread (verify by switching a thread's model in the composer, then re-hovering — wait until the next thread shell sync).
- Clicking the icon area still selects/opens the thread (no swallowed click).
- Active row, selected row, and the existing trailing badges (PR, terminal, archive button on hover) still render correctly with no layout shift.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx
git commit -m "feat(web): show provider icon on sidebar chat rows"
```

---

## Task 7: Final verification

- [ ] **Step 1: Run the canonical project gates**

Run, in order:
1. `bun fmt`
2. `bun lint`
3. `bun typecheck`
4. `bun run test`

Expected: every command exits 0.

- [ ] **Step 2: Inspect the diff**

Run: `git log --oneline origin/main..HEAD` and `git diff origin/main..HEAD --stat`

Confirm: ~6 commits (one per task), affecting only the files listed in the plan header. No stray changes outside `apps/web/src/components/`, `apps/web/src/types.ts`, `apps/web/src/store.ts`, `apps/web/src/components/chat/providerIconUtils*`, `apps/web/src/environmentGrouping.test.ts`.

- [ ] **Step 3: (Optional) Open a draft PR**

Only on explicit user request. Title: `feat(web): show provider icon on sidebar chat rows`. Body should call out: extends `SidebarThreadSummary` with `modelSelection`, reuses composer rail icons, tooltip carries `Provider · Model name`.
