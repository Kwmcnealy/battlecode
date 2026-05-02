# Symphony Codex Cloud Linear Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Symphony cloud launches create real Codex Cloud work from Linear, with repository-aware delegation, detectable acceptance/failure states, and sidebar UI that defaults collapsed and uses red working dots for active Symphony runs.

**Architecture:** Keep local Symphony on the existing T3 Code app-server orchestration path. Treat Codex Cloud as a separate Linear/GitHub/Codex integration path: resolve the GitHub repository from the project checkout, write a repo-pinned `@Codex` Linear comment, then refresh Linear comments/activity for Codex replies and task links. Move cloud prompt construction and GitHub remote parsing into small testable helpers instead of keeping it inline in `SymphonyService.ts`.

**Tech Stack:** TypeScript, Effect, Effect Schema, Linear GraphQL, Codex Cloud via official Linear integration, React 18, Zustand, Tailwind, Vitest browser/component tests, Bun/Turborepo.

---

## Evidence Summary

- `/Users/caladyne/symphony` does not send tasks to Codex Cloud. Its Elixir runner creates a per-issue workspace and starts `codex app-server` locally or over SSH: `/Users/caladyne/symphony/elixir/lib/symphony_elixir/agent_runner.ex:79-88`, `/Users/caladyne/symphony/elixir/lib/symphony_elixir/codex/app_server.ex:189-220`.
- The Elixir app-server session passes `cwd`, approval/sandbox policy, and a client-side `linear_graphql` dynamic tool into `thread/start`, then sends the issue prompt through `turn/start`: `/Users/caladyne/symphony/elixir/lib/symphony_elixir/codex/app_server.ex:280-320`.
- The Elixir `linear_graphql` dynamic tool is useful for local/SSH app-server sessions, but it is not a Codex Cloud dispatch mechanism: `/Users/caladyne/symphony/elixir/lib/symphony_elixir/codex/dynamic_tool.ex:8-65`.
- Current T3 Code cloud launch only posts a Linear comment and immediately marks the run `cloud-submitted`: `apps/server/src/symphony/Layers/SymphonyService.ts:695-719`, `apps/server/src/symphony/Layers/SymphonyService.ts:884-982`.
- That comment includes local filesystem paths (`Project root`, `Workflow file`) but no GitHub `owner/repo`, which Codex Cloud can use. Official OpenAI docs say `@Codex` comments create cloud tasks from Linear and recommend pinning a specific repo in the comment, for example `@Codex fix this in openai/codex`.
- Current status refresh scans all issue comments for any `https://codex.openai.com/...` link, with no delegation timestamp filter, so it can miss non-link setup replies or detect stale links from older attempts: `apps/server/src/symphony/linear.ts:266-301`.
- Current sidebar defaults Symphony expanded because the selector and toggle fallback use `?? true`: `apps/web/src/uiStateStore.ts:668-684`, `apps/web/src/components/Sidebar.tsx:1351`.
- Current active Symphony treatment is a purple animated text gradient: `apps/web/src/components/Sidebar.tsx:444`, `apps/web/src/index.css:1036-1068`.
- Existing working dots already live in `MessagesTimeline` and are animated by `.verbose-dot`: `apps/web/src/components/chat/MessagesTimeline.tsx:548-550`, `apps/web/src/index.css:1049-1059`.

## Non-Goals

- Do not build a fake OpenAI API runner for cloud mode.
- Do not change non-Symphony chats to full access.
- Do not port Elixir SSH workers into T3 Code in this pass.
- Do not make cloud model enforcement stronger than Codex Cloud exposes through Linear. The comment can request GPT-5.5 high, but UI should still call cloud execution "Cloud managed" unless an enforceable cloud model API exists.

## File Map

- Create: `apps/server/src/symphony/codexCloud.ts` - pure helpers for GitHub repo parsing, cloud comment building, and Codex reply classification.
- Create: `apps/server/src/symphony/codexCloud.test.ts` - unit tests for the helper module.
- Modify: `packages/contracts/src/symphony.ts` - add optional cloud diagnostics to `SymphonyCloudTask`.
- Modify: `packages/contracts/src/symphony.test.ts` - schema coverage for optional cloud diagnostics.
- Modify: `apps/server/src/symphony/linear.ts` - fetch comment author/timestamps, detect task links only after the current delegation, classify Codex setup/failure replies.
- Modify: `apps/server/src/symphony/linear.test.ts` - tests for timestamp-filtered task detection and setup reply detection.
- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts` - resolve GitHub repo context, build repo-pinned comments, store comment URL/repo diagnostics, and refresh cloud status more accurately.
- Modify: `apps/server/src/symphony/runModel.test.ts` if queue grouping expectations need new cloud diagnostics.
- Modify: `apps/web/src/uiStateStore.ts` - make Symphony collapsed by default.
- Modify: `apps/web/src/uiStateStore.test.ts` - prove default toggle expands from collapsed.
- Modify: `apps/web/src/components/Sidebar.tsx` - replace purple animated text with static active red label plus red animated dots.
- Modify: `apps/web/src/index.css` - remove unused Symphony gradient keyframes/classes, keep shared `.verbose-dot`.
- Modify: `apps/web/src/components/symphony/IssueQueueTable.tsx` - surface cloud setup/failure message and refresh action where the run has no task link.
- Modify: `apps/web/src/components/symphony/IssueQueueTable.browser.tsx` - browser coverage for cloud submitted, detected, and setup-blocked rows.

## Task 1: Add Cloud Helper Module And Tests

**Files:**

- Create: `apps/server/src/symphony/codexCloud.ts`
- Create: `apps/server/src/symphony/codexCloud.test.ts`

- [ ] **Step 1: Write failing tests for GitHub remote parsing**

Create `apps/server/src/symphony/codexCloud.test.ts` with tests covering SSH, HTTPS, `.git`, non-GitHub, and malformed remotes.

```ts
import { describe, expect, it } from "vitest";

import {
  buildCodexCloudDelegationComment,
  classifyCodexCloudReply,
  parseGitHubRepositoryFromRemoteUrl,
} from "./codexCloud.ts";

describe("parseGitHubRepositoryFromRemoteUrl", () => {
  it.each([
    ["git@github.com:openai/codex.git", "openai/codex", "https://github.com/openai/codex"],
    ["https://github.com/openai/codex.git", "openai/codex", "https://github.com/openai/codex"],
    ["ssh://git@github.com/openai/codex", "openai/codex", "https://github.com/openai/codex"],
  ])("parses %s", (remoteUrl, nameWithOwner, httpsUrl) => {
    expect(parseGitHubRepositoryFromRemoteUrl(remoteUrl)).toEqual({
      nameWithOwner,
      httpsUrl,
      remoteUrl,
    });
  });

  it.each(["", "not a url", "git@gitlab.com:openai/codex.git", "https://github.com/openai"])(
    "rejects %s",
    (remoteUrl) => {
      expect(parseGitHubRepositoryFromRemoteUrl(remoteUrl)).toBeNull();
    },
  );
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `bun run test apps/server/src/symphony/codexCloud.test.ts`

Expected: FAIL because `apps/server/src/symphony/codexCloud.ts` does not exist.

- [ ] **Step 3: Implement GitHub remote parsing**

Create `apps/server/src/symphony/codexCloud.ts` with this public shape:

```ts
import type { SymphonyIssue } from "@t3tools/contracts";

export interface CodexCloudRepositoryContext {
  readonly nameWithOwner: string;
  readonly httpsUrl: string;
  readonly remoteUrl: string;
}

export interface CodexCloudDelegationInput {
  readonly issue: SymphonyIssue;
  readonly repository: CodexCloudRepositoryContext;
  readonly branchName: string;
  readonly workflowPath: string;
  readonly requestedModel: string;
  readonly requestedReasoning: string;
}

export interface CodexCloudReplyClassification {
  readonly status: "detected" | "failed" | "unknown";
  readonly taskUrl: string | null;
  readonly message: string | null;
}
```

Implement `parseGitHubRepositoryFromRemoteUrl(remoteUrl: string): CodexCloudRepositoryContext | null` with these rules:

```ts
const parsePath = (path: string): { owner: string; repo: string } | null => {
  const parts = path
    .replace(/^\/+/, "")
    .replace(/\.git$/i, "")
    .split("/");
  const [owner, repo] = parts;
  if (!owner || !repo || parts.length !== 2) return null;
  return { owner, repo };
};
```

Support:

- `git@github.com:owner/repo.git`
- `git@github.com/owner/repo.git`
- `ssh://git@github.com/owner/repo.git`
- `https://github.com/owner/repo.git`

Return `null` for non-GitHub hosts and incomplete paths.

- [ ] **Step 4: Add failing tests for the delegation comment**

Append to `codexCloud.test.ts`:

```ts
describe("buildCodexCloudDelegationComment", () => {
  it("pins Codex to the GitHub repository and avoids local filesystem paths", () => {
    const comment = buildCodexCloudDelegationComment({
      issue: {
        id: "linear-issue-1",
        identifier: "APP-123",
        title: "Fix cloud launch",
        description: "Cloud mode is not creating a Codex task.",
        priority: null,
        state: "Todo",
        branchName: null,
        url: "https://linear.app/example/issue/APP-123",
        labels: [],
        blockedBy: [],
        createdAt: null,
        updatedAt: null,
      },
      repository: {
        nameWithOwner: "openai/codex",
        httpsUrl: "https://github.com/openai/codex",
        remoteUrl: "git@github.com:openai/codex.git",
      },
      branchName: "symphony/app-123-fix-cloud-launch",
      workflowPath: "WORKFLOW.md",
      requestedModel: "GPT-5.5",
      requestedReasoning: "high",
    });

    expect(comment).toContain("@Codex");
    expect(comment).toContain("openai/codex");
    expect(comment).toContain("https://github.com/openai/codex");
    expect(comment).toContain("APP-123 - Fix cloud launch");
    expect(comment).toContain("GPT-5.5");
    expect(comment).toContain("high");
    expect(comment).not.toContain("/Users/");
  });
});
```

- [ ] **Step 5: Implement comment builder**

Add `buildCodexCloudDelegationComment(input: CodexCloudDelegationInput): string` to `codexCloud.ts`.

The comment must start with:

```text
@Codex please work on this Linear issue in <owner/repo>.
```

It must include:

- `Repository: <httpsUrl>`
- `Issue: <identifier> - <title>`
- issue URL when present
- issue description when present
- `Requested runtime: GPT-5.5, reasoning high. If Codex Cloud manages model selection for this integration, use the best available cloud coding model.`
- `Suggested branch: <branchName>`
- `Workflow: Follow WORKFLOW.md in the repository root. Validate changes, push the branch, and open or update a pull request when ready.`

It must not include local absolute paths. `workflowPath` should be reduced to the basename for display if it is absolute.

- [ ] **Step 6: Add reply classification tests**

Append:

```ts
describe("classifyCodexCloudReply", () => {
  it("detects task links", () => {
    expect(classifyCodexCloudReply("Track it at https://codex.openai.com/tasks/task_123.")).toEqual(
      {
        status: "detected",
        taskUrl: "https://codex.openai.com/tasks/task_123",
        message: null,
      },
    );
  });

  it("classifies setup failures", () => {
    expect(classifyCodexCloudReply("No suitable environment or repository is available.")).toEqual({
      status: "failed",
      taskUrl: null,
      message: "No suitable environment or repository is available.",
    });
  });
});
```

- [ ] **Step 7: Implement reply classification**

Add `classifyCodexCloudReply(text: string | null): CodexCloudReplyClassification`.

Detect task URLs with:

```ts
/https:\/\/codex\.openai\.com\/[^\s)]+/i;
```

Return `failed` when the lower-cased text contains any of:

- `no suitable environment`
- `connect your account`
- `couldn't confirm your linear connection`
- `could not confirm your linear connection`
- `install codex for linear`
- `repository is available`

Return `unknown` for empty or unrelated text.

- [ ] **Step 8: Run helper tests**

Run: `bun run test apps/server/src/symphony/codexCloud.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/symphony/codexCloud.ts apps/server/src/symphony/codexCloud.test.ts
git commit -m "feat(symphony): add Codex Cloud delegation helpers"
```

## Task 2: Extend Cloud Task Diagnostics

**Files:**

- Modify: `packages/contracts/src/symphony.ts`
- Modify: `packages/contracts/src/symphony.test.ts`

- [ ] **Step 1: Add failing contract test**

In `packages/contracts/src/symphony.test.ts`, extend the existing cloud task schema test to include:

```ts
linearCommentUrl: "https://linear.app/t3/issue/APP-1#comment-comment-1",
repository: "openai/codex",
repositoryUrl: "https://github.com/openai/codex",
lastMessage: "No suitable environment or repository is available.",
```

Add a second decode assertion for an old cloud task payload without those fields to prove backward compatibility:

```ts
expect(
  Schema.decodeUnknownSync(SymphonyCloudTask)({
    provider: "codex-cloud-linear",
    status: "submitted",
    taskUrl: null,
    linearCommentId: "comment-1",
    delegatedAt: "2026-04-30T12:00:00.000Z",
    lastCheckedAt: "2026-04-30T12:00:00.000Z",
  }).linearCommentUrl,
).toBeNull();
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `bun run test packages/contracts/src/symphony.test.ts`

Expected: FAIL because `linearCommentUrl`, `repository`, `repositoryUrl`, and `lastMessage` do not decode yet.

- [ ] **Step 3: Update `SymphonyCloudTask` schema**

In `packages/contracts/src/symphony.ts`, extend `SymphonyCloudTask`:

```ts
linearCommentUrl: Schema.NullOr(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
),
repository: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
repositoryUrl: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
lastMessage: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
```

Keep these fields optional-through-default so existing `cloud_task_json` rows decode without a migration.

- [ ] **Step 4: Run contract tests**

Run: `bun run test packages/contracts/src/symphony.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/symphony.ts packages/contracts/src/symphony.test.ts
git commit -m "feat(contracts): store Symphony Codex Cloud diagnostics"
```

## Task 3: Improve Linear Cloud Status Detection

**Files:**

- Modify: `apps/server/src/symphony/linear.ts`
- Modify: `apps/server/src/symphony/linear.test.ts`

- [ ] **Step 1: Write failing tests for timestamp-filtered detection**

In `apps/server/src/symphony/linear.test.ts`, update `detects Codex Cloud task links from Linear comments` so the fake response includes:

- an old comment before `delegatedAfter` with `https://codex.openai.com/tasks/old`
- a newer comment after `delegatedAfter` with `https://codex.openai.com/tasks/new`

Call:

```ts
detectLinearCodexTask({
  endpoint: "https://linear.example/graphql",
  apiKey: "lin_api_key",
  issueId: "linear-issue-1",
  delegatedAfter: "2026-05-01T10:00:00.000Z",
});
```

Expected result:

```ts
{
  taskUrl: "https://codex.openai.com/tasks/new",
  linearCommentId: "comment-new",
  status: "detected",
  message: null,
}
```

- [ ] **Step 2: Add failing setup-reply test**

Add a test where the only new comment body is `No suitable environment or repository is available.`.

Expected result:

```ts
{
  taskUrl: null,
  linearCommentId: "comment-setup",
  status: "failed",
  message: "No suitable environment or repository is available.",
}
```

- [ ] **Step 3: Run Linear tests and verify they fail**

Run: `bun run test apps/server/src/symphony/linear.test.ts`

Expected: FAIL because `delegatedAfter`, `status`, and `message` are not implemented.

- [ ] **Step 4: Update Linear comments query**

In `apps/server/src/symphony/linear.ts`, update `LINEAR_ISSUE_COMMENTS_QUERY` to include enough metadata for safe filtering:

```graphql
comments(first: 100) {
  nodes {
    id
    url
    body
    createdAt
    user { id name displayName }
  }
}
```

- [ ] **Step 5: Update detection result types**

Change `LinearCodexTaskDetection` to:

```ts
export interface LinearCodexTaskDetection {
  readonly status: "detected" | "failed" | "unknown";
  readonly taskUrl: string | null;
  readonly linearCommentId: string | null;
  readonly message: string | null;
}
```

Change `detectLinearCodexTask` input to accept:

```ts
readonly delegatedAfter?: string | null;
```

- [ ] **Step 6: Use the cloud helper classifier**

Import `classifyCodexCloudReply` from `./codexCloud.ts`.

When scanning comments:

- Skip comments with `createdAt < delegatedAfter` when `delegatedAfter` is present and both values parse as valid dates.
- Classify each remaining comment body.
- Return the first `detected`.
- If no detected link exists, return the first `failed`.
- Otherwise return `unknown`.

Keep scanning all comments because Linear may not expose the Codex actor in the same shape for every workspace.

- [ ] **Step 7: Run Linear tests**

Run: `bun run test apps/server/src/symphony/linear.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/symphony/linear.ts apps/server/src/symphony/linear.test.ts
git commit -m "fix(symphony): detect Codex Cloud Linear replies safely"
```

## Task 4: Use Repository-Aware Cloud Delegation In SymphonyService

**Files:**

- Modify: `apps/server/src/symphony/Layers/SymphonyService.ts`
- Modify: `apps/server/src/symphony/runModel.test.ts` only if queue expectations require diagnostic fields

- [ ] **Step 1: Add a helper to resolve the project GitHub repo**

Inside `makeSymphonyService`, add:

```ts
const resolveCodexCloudRepository = (
  projectRoot: string,
): Effect.Effect<CodexCloudRepositoryContext, SymphonyError> =>
  Effect.gen(function* () {
    const originUrl = yield* git
      .readConfigValue(projectRoot, "remote.origin.url")
      .pipe(Effect.mapError(toSymphonyError("Failed to read project Git remote.")));
    if (!originUrl) {
      return yield* new SymphonyError({
        message: "Codex Cloud requires a GitHub origin remote for this project.",
      });
    }
    const repository = parseGitHubRepositoryFromRemoteUrl(originUrl);
    if (!repository) {
      return yield* new SymphonyError({
        message: `Codex Cloud requires a GitHub repository remote. Found: ${originUrl}`,
      });
    }
    return repository;
  });
```

Import `CodexCloudRepositoryContext`, `buildCodexCloudDelegationComment`, and `parseGitHubRepositoryFromRemoteUrl` from `../codexCloud.ts`.

- [ ] **Step 2: Replace inline `buildCloudDelegationComment`**

Delete the existing `buildCloudDelegationComment` function from `SymphonyService.ts`.

In `launchCodexCloudRun`, before `createLinearComment`, compute:

```text
const repositoryContext = yield* resolveCodexCloudRepository(input.projectRoot);
const branchName = input.run.branchName ?? branchNameForIssue(input.run.issue.identifier);
const body = buildCodexCloudDelegationComment({
  issue: input.run.issue,
  repository: repositoryContext,
  branchName,
  workflowPath: input.workflowPath,
  requestedModel: "GPT-5.5",
  requestedReasoning: "high",
});
```

Pass `body` into `createLinearComment`.

- [ ] **Step 3: Store diagnostics on `cloudTask`**

When building `nextRun.cloudTask`, include:

```ts
linearCommentUrl: comment.url,
repository: repositoryContext.nameWithOwner,
repositoryUrl: repositoryContext.httpsUrl,
lastMessage: null,
```

Do the same in the failure path, preserving existing values from `input.run.cloudTask`.

- [ ] **Step 4: Refresh with delegation timestamp**

In `refreshCloudRunStatus`, pass:

```ts
delegatedAfter: input.run.cloudTask?.delegatedAt ?? null,
```

Map detection into `cloudTask`:

```ts
status: detected.status === "unknown" ? currentTask.status : detected.status,
taskUrl: detected.taskUrl ?? currentTask.taskUrl,
linearCommentId: currentTask.linearCommentId ?? detected.linearCommentId,
lastMessage: detected.message ?? currentTask.lastMessage,
```

If `detected.status === "failed"`, set `lastError` to `detected.message` and emit `cloud.failed`.

- [ ] **Step 5: Preserve local behavior**

Do not change `launchLocalRun`. It should continue using `defaultSymphonyLocalModelSelection()` and `runtimeMode: "full-access"` for both `thread.create` and `thread.turn.start`.

- [ ] **Step 6: Run targeted server tests**

Run:

```bash
bun run test apps/server/src/symphony/codexCloud.test.ts apps/server/src/symphony/linear.test.ts apps/server/src/symphony/runModel.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/symphony/Layers/SymphonyService.ts apps/server/src/symphony/runModel.test.ts
git commit -m "fix(symphony): pin Codex Cloud delegation to GitHub repo"
```

## Task 5: Surface Cloud Setup And Failure State In The Symphony Panel

**Files:**

- Modify: `apps/web/src/components/symphony/IssueQueueTable.tsx`
- Modify: `apps/web/src/components/symphony/IssueQueueTable.browser.tsx`
- Modify: `apps/web/src/components/symphony/symphonyDisplay.ts` if a distinct failed cloud badge is needed

- [ ] **Step 1: Add browser test for failed cloud reply**

In `IssueQueueTable.browser.tsx`, add a cloud row with:

```ts
status: "cloud-submitted",
executionTarget: "codex-cloud",
cloudTask: {
  provider: "codex-cloud-linear",
  status: "failed",
  taskUrl: null,
  linearCommentId: "comment-setup",
  linearCommentUrl: "https://linear.app/t3/issue/APP-1#comment-comment-setup",
  repository: "openai/codex",
  repositoryUrl: "https://github.com/openai/codex",
  delegatedAt: "2026-05-01T10:00:00.000Z",
  lastCheckedAt: "2026-05-01T10:01:00.000Z",
  lastMessage: "No suitable environment or repository is available.",
},
```

Assert the row shows:

- `Codex Cloud`
- `No suitable environment or repository is available.`
- `Open Linear Issue`
- `Refresh Cloud Status`

- [ ] **Step 2: Run the browser test and verify it fails**

Run: `bun run test apps/web/src/components/symphony/IssueQueueTable.browser.tsx`

Expected: FAIL because the new message is not rendered.

- [ ] **Step 3: Render cloud diagnostics**

In `IssueQueueTable.tsx`, when `run.executionTarget === "codex-cloud"` and `run.cloudTask?.lastMessage` is present, render that message in the existing row metadata/status area with muted text. Keep the row density compact.

Use existing actions:

- `Open Codex Task` when `cloudTask.taskUrl` exists.
- `Open Linear Issue` when no task URL exists and `run.issue.url` exists.
- `Refresh Cloud Status` for `cloud-submitted` rows.

- [ ] **Step 4: Run the browser test**

Run: `bun run test apps/web/src/components/symphony/IssueQueueTable.browser.tsx`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/symphony/IssueQueueTable.tsx apps/web/src/components/symphony/IssueQueueTable.browser.tsx apps/web/src/components/symphony/symphonyDisplay.ts
git commit -m "feat(web): show Symphony Codex Cloud diagnostics"
```

## Task 6: Default Sidebar Symphony Sections Collapsed

**Files:**

- Modify: `apps/web/src/uiStateStore.ts`
- Modify: `apps/web/src/uiStateStore.test.ts`
- Modify: `apps/web/src/components/Sidebar.tsx`

- [ ] **Step 1: Add failing store test**

In `apps/web/src/uiStateStore.test.ts`, add:

```ts
it("defaults Symphony sidebar groups to collapsed", () => {
  const initialState = makeUiState();
  const expanded = toggleSymphonyExpanded(initialState, "project-1");

  expect(expanded.symphonyExpandedByProjectKey["project-1"]).toBe(true);
});
```

This proves the first click expands from the default collapsed state.

- [ ] **Step 2: Run the store test and verify it fails**

Run: `bun run test apps/web/src/uiStateStore.test.ts`

Expected: FAIL because `toggleSymphonyExpanded` currently treats missing state as expanded and first click collapses.

- [ ] **Step 3: Change defaults from expanded to collapsed**

In `apps/web/src/uiStateStore.ts`, change:

```ts
state.symphonyExpandedByProjectKey[projectKey] ?? true;
```

to:

```ts
state.symphonyExpandedByProjectKey[projectKey] ?? false;
```

in both `setSymphonyExpanded` and `toggleSymphonyExpanded`.

In `apps/web/src/components/Sidebar.tsx`, change the selector fallback:

```ts
state.symphonyExpandedByProjectKey[project.projectKey] ?? false;
```

- [ ] **Step 4: Run store and sidebar logic tests**

Run:

```bash
bun run test apps/web/src/uiStateStore.test.ts apps/web/src/components/Sidebar.logic.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/uiStateStore.ts apps/web/src/uiStateStore.test.ts apps/web/src/components/Sidebar.tsx
git commit -m "fix(web): default Symphony sidebar groups collapsed"
```

## Task 7: Replace Purple Active Text With Red Working Dots

**Files:**

- Modify: `apps/web/src/components/Sidebar.tsx`
- Modify: `apps/web/src/index.css`

- [ ] **Step 1: Update the Sidebar active label**

In `SidebarSymphonySection`, replace:

```tsx
hasActiveSymphony ? "symphony-sidebar-active-text" : "text-primary";
```

with:

```tsx
hasActiveSymphony ? "text-destructive" : "text-primary";
```

- [ ] **Step 2: Add red dots next to the row count**

Immediately before the count span, render:

```text
{hasActiveSymphony ? (
  <span
    className="inline-flex shrink-0 items-center gap-[3px]"
    aria-label="Symphony running"
  >
    <span className="verbose-dot verbose-dot-1 h-1.5 w-1.5 rounded-full bg-destructive/80" />
    <span className="verbose-dot verbose-dot-2 h-1.5 w-1.5 rounded-full bg-destructive/80" />
    <span className="verbose-dot verbose-dot-3 h-1.5 w-1.5 rounded-full bg-destructive/80" />
  </span>
) : null}
```

This reuses the existing `.verbose-dot` keyframes and keeps reduced-motion behavior unchanged.

- [ ] **Step 3: Remove purple CSS**

In `apps/web/src/index.css`, delete:

- `@keyframes symphony-sidebar-gradient`
- the `.symphony-sidebar-active-text` animation block inside the media query
- the `.symphony-sidebar-active-text` class

Do not change `.verbose-dot` or `verbose-pulse`.

- [ ] **Step 4: Run web tests**

Run:

```bash
bun run test apps/web/src/uiStateStore.test.ts apps/web/src/components/Sidebar.logic.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/Sidebar.tsx apps/web/src/index.css
git commit -m "feat(web): show active Symphony runs with red working dots"
```

## Task 8: End-To-End Manual Cloud Verification

**Files:**

- No code files. This is validation against real services.

- [ ] **Step 1: Confirm setup prerequisites**

In the target project:

```bash
git remote get-url origin
```

Expected: a GitHub URL for the repo that is connected to Codex Cloud.

In Codex web:

- GitHub account connected.
- Codex Cloud environment exists for the repo.
- Environment repo map includes the target repo.
- Codex for Linear installed.
- Linear account linked by mentioning `@Codex` once manually if needed.

- [ ] **Step 2: Start T3 Code locally**

Run:

```bash
npm run dev
```

Open the app on the reported web port.

- [ ] **Step 3: Use Symphony cloud action**

In the Symphony panel:

- Click `Refresh Issues`.
- Pick one `target-pending` issue.
- Click `Send to Cloud`.

Expected:

- Linear receives a comment starting with `@Codex please work on this Linear issue in owner/repo`.
- The comment includes GitHub repo URL, issue identifier/title, requested GPT-5.5 high, suggested branch, and workflow instruction.
- No local worktree is created for this run.
- The run status becomes `cloud-submitted`.

- [ ] **Step 4: Refresh cloud status**

Click `Refresh Cloud Status` after Codex replies in Linear.

Expected:

- If Codex created a task, `cloudTask.status` becomes `detected` and `Open Codex Task` opens the `codex.openai.com` task link.
- If setup is missing, the row shows Codex's setup message and `Open Linear Issue`.
- Old task links from earlier comments are not used.

- [ ] **Step 5: Record result**

Add a short manual validation note to the PR description:

```text
Manual cloud validation:
- Linear issue: <identifier>
- Repository comment included owner/repo: yes/no
- Codex task detected: yes/no
- Task URL or setup reply: <value>
```

## Task 9: Final Validation

**Files:**

- No code files.

- [ ] **Step 1: Format**

Run: `bun fmt`

Expected: PASS.

- [ ] **Step 2: Lint**

Run: `bun lint`

Expected: PASS.

- [ ] **Step 3: Typecheck**

Run: `bun typecheck`

Expected: PASS.

- [ ] **Step 4: Targeted tests**

Run:

```bash
bun run test packages/contracts/src/symphony.test.ts apps/server/src/symphony/codexCloud.test.ts apps/server/src/symphony/linear.test.ts apps/server/src/symphony/runModel.test.ts apps/web/src/uiStateStore.test.ts apps/web/src/components/Sidebar.logic.test.ts apps/web/src/components/symphony/IssueQueueTable.browser.tsx
```

Expected: PASS.

- [ ] **Step 5: npm validation required by user-provided instructions**

Run:

```bash
npm run typecheck
npm run lint
```

Expected: PASS.

- [ ] **Step 6: Do not run `bun test`**

The repo instructions require `bun run test`, not `bun test`.

## Implementation Notes

- The TypeScript "version" of the Elixir source for cloud should not copy the local/SSH app-server runner. T3 Code already has local app-server orchestration. The useful TypeScript port is the explicit Linear GraphQL handling and the clear separation between local runner state and tracker mutations.
- The key cloud fix is repo identity. Codex Cloud cannot use `/Users/caladyne/...` paths from a Linear comment. It needs a connected GitHub repo/environment and, when ambiguity exists, a pinned `owner/repo` in the comment.
- Treat a Linear comment ID as "request submitted to Linear", not "Codex Cloud task created". Only a Codex reply or task URL should move the run from submitted toward detected or failed.
- Keep cloud status polling best-effort. Linear replies may lag; `submitted` is valid while waiting.
- Keep old cloud task JSON readable by adding defaults, not a migration.
