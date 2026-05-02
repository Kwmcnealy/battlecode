import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLinearComment,
  detectLinearCodexTask,
  fetchLinearCandidates,
  normalizeLinearIssue,
} from "./linear.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Symphony Linear helpers", () => {
  it("normalizes Linear issue nodes into Symphony issues", () => {
    const issue = normalizeLinearIssue({
      id: "linear-issue-1",
      identifier: "APP-1",
      title: "Fix dashboard",
      description: "The dashboard is slow.",
      priority: 2,
      url: "https://linear.app/t3/issue/APP-1",
      branchName: "symphony/app-1",
      state: { name: "Todo" },
      labels: { nodes: [{ name: "Bug" }, { name: "Symphony" }] },
      relations: {
        nodes: [
          {
            type: "blocks",
            relatedIssue: {
              id: "linear-issue-0",
              identifier: "APP-0",
              state: { name: "Done" },
            },
          },
          { type: "relates" },
        ],
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:10:00.000Z",
    });

    expect(issue?.identifier).toBe("APP-1");
    expect(issue?.labels).toEqual(["bug", "symphony"]);
    expect(issue?.blockedBy).toEqual([
      {
        id: "linear-issue-0",
        identifier: "APP-0",
        state: "Done",
      },
    ]);
  });

  it("paginates candidate issue reads", async () => {
    const fetchMock = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body)) as {
        readonly variables?: { readonly after?: string | null };
      };
      const after = requestBody.variables?.after ?? null;
      const page =
        after === null
          ? {
              nodes: [
                {
                  id: "linear-issue-1",
                  identifier: "APP-1",
                  title: "First issue",
                  state: { name: "Todo" },
                  labels: { nodes: [] },
                  relations: { nodes: [] },
                  description: null,
                  priority: null,
                  url: null,
                  branchName: null,
                  createdAt: null,
                  updatedAt: null,
                },
              ],
              pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
            }
          : {
              nodes: [
                {
                  id: "linear-issue-2",
                  identifier: "APP-2",
                  title: "Second issue",
                  state: { name: "In Progress" },
                  labels: { nodes: [] },
                  relations: { nodes: [] },
                  description: null,
                  priority: null,
                  url: null,
                  branchName: null,
                  createdAt: null,
                  updatedAt: null,
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            };

      return new Response(JSON.stringify({ data: { issues: page } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const issues = await Effect.runPromise(
      fetchLinearCandidates({
        endpoint: "https://linear.example/graphql",
        apiKey: "lin_api_key",
        config: {
          tracker: {
            kind: "linear",
            endpoint: "https://linear.example/graphql",
            projectSlug: "battlecode",
            activeStates: ["Todo", "In Progress"],
            terminalStates: ["Done"],
          },
          polling: { intervalMs: 30_000 },
          workspace: { root: "" },
          hooks: { timeoutMs: 60_000 },
          agent: {
            maxConcurrentAgents: 3,
            maxTurns: 20,
            maxRetryBackoffMs: 300_000,
          },
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).query).toContain("slugId");
    expect(issues.map((issue) => issue.identifier)).toEqual(["APP-1", "APP-2"]);
  });

  it("creates Linear comments for Codex Cloud delegation", async () => {
    const fetchMock = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              commentCreate: {
                success: true,
                comment: {
                  id: "comment-1",
                  url: "https://linear.app/t3/issue/APP-1#comment-comment-1",
                },
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const comment = await Effect.runPromise(
      createLinearComment({
        endpoint: "https://linear.example/graphql",
        apiKey: "lin_api_key",
        issueId: "linear-issue-1",
        body: "@Codex please work this issue.",
      }),
    );

    expect(comment).toEqual({
      id: "comment-1",
      url: "https://linear.app/t3/issue/APP-1#comment-comment-1",
    });
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly variables: { readonly issueId: string; readonly body: string };
    };
    expect(requestBody.variables).toEqual({
      issueId: "linear-issue-1",
      body: "@Codex please work this issue.",
    });
  });

  it("detects Codex Cloud task links from Linear comments", async () => {
    const fetchMock = vi.fn(
      async (_url: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            data: {
              issue: {
                comments: {
                  nodes: [
                    { id: "comment-1", body: "No task here." },
                    {
                      id: "comment-2",
                      body: "Codex task: https://codex.openai.com/tasks/task-123)",
                    },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const detected = await Effect.runPromise(
      detectLinearCodexTask({
        endpoint: "https://linear.example/graphql",
        apiKey: "lin_api_key",
        issueId: "linear-issue-1",
      }),
    );

    expect(detected).toEqual({
      taskUrl: "https://codex.openai.com/tasks/task-123",
      linearCommentId: "comment-2",
    });
  });
});
