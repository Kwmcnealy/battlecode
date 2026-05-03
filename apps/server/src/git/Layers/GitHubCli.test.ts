import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import { afterEach, expect, vi } from "vitest";

vi.mock("../../processRunner", () => ({
  runProcess: vi.fn(),
}));

import { runProcess } from "../../processRunner.ts";
import { GitHubCli } from "../Services/GitHubCli.ts";
import { GitHubCliLive } from "./GitHubCli.ts";

const mockedRunProcess = vi.mocked(runProcess);
const layer = it.layer(GitHubCliLive);

const pullRequestViewOutput = {
  number: 42,
  title: "Add PR thread creation",
  url: "https://github.com/pingdotgg/codething-mvp/pull/42",
  baseRefName: "main",
  headRefName: "feature/pr-threads",
  state: "OPEN",
  mergedAt: null,
};

function processResult(stdout: unknown) {
  return {
    stdout: `${typeof stdout === "string" ? stdout : (JSON.stringify(stdout) ?? "")}\n`,
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
  };
}

function mockFeedbackSignalResponses(input: {
  reviews?: readonly unknown[];
  issueComments?: readonly unknown[];
  reviewComments?: readonly unknown[];
}) {
  mockedRunProcess.mockImplementation((_command, args) => {
    if (args[0] === "pr" && args[1] === "view") {
      return Promise.resolve(processResult(pullRequestViewOutput));
    }

    if (args[0] === "api" && args[1] === "repos/pingdotgg/codething-mvp/pulls/42/reviews") {
      return Promise.resolve(processResult(input.reviews ?? []));
    }

    if (args[0] === "api" && args[1] === "repos/pingdotgg/codething-mvp/issues/42/comments") {
      return Promise.resolve(processResult(input.issueComments ?? []));
    }

    if (args[0] === "api" && args[1] === "repos/pingdotgg/codething-mvp/pulls/42/comments") {
      return Promise.resolve(processResult(input.reviewComments ?? []));
    }

    return Promise.reject(new Error(`Unexpected gh args: ${args.join(" ")}`));
  });
}

function expectFeedbackApiCalls() {
  expect(mockedRunProcess).toHaveBeenCalledWith(
    "gh",
    ["api", "repos/pingdotgg/codething-mvp/pulls/42/reviews", "--paginate"],
    expect.objectContaining({ cwd: "/repo" }),
  );
  expect(mockedRunProcess).toHaveBeenCalledWith(
    "gh",
    ["api", "repos/pingdotgg/codething-mvp/issues/42/comments", "--paginate"],
    expect.objectContaining({ cwd: "/repo" }),
  );
  expect(mockedRunProcess).toHaveBeenCalledWith(
    "gh",
    ["api", "repos/pingdotgg/codething-mvp/pulls/42/comments", "--paginate"],
    expect.objectContaining({ cwd: "/repo" }),
  );
}

afterEach(() => {
  mockedRunProcess.mockReset();
});

layer("GitHubCliLive", (it) => {
  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "Add PR thread creation",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42",
          baseRefName: "main",
          headRefName: "feature/pr-threads",
          state: "OPEN",
          mergedAt: null,
          isCrossRepository: true,
          headRepository: {
            nameWithOwner: "octocat/codething-mvp",
          },
          headRepositoryOwner: {
            login: "octocat",
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        updatedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
      expect(mockedRunProcess).toHaveBeenCalledWith(
        "gh",
        [
          "pr",
          "view",
          "#42",
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
        expect.objectContaining({ cwd: "/repo" }),
      );
    }),
  );

  it.effect("trims pull request fields decoded from gh json", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: "  Add PR thread creation  \n",
          url: " https://github.com/pingdotgg/codething-mvp/pull/42 ",
          baseRefName: " main ",
          headRefName: "\tfeature/pr-threads\t",
          state: "OPEN",
          mergedAt: null,
          isCrossRepository: true,
          headRepository: {
            nameWithOwner: " octocat/codething-mvp ",
          },
          headRepositoryOwner: {
            login: " octocat ",
          },
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, {
        number: 42,
        title: "Add PR thread creation",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseRefName: "main",
        headRefName: "feature/pr-threads",
        state: "open",
        updatedAt: null,
        isCrossRepository: true,
        headRepositoryNameWithOwner: "octocat/codething-mvp",
        headRepositoryOwnerLogin: "octocat",
      });
    }),
  );

  it.effect("skips invalid entries when parsing pr lists", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 0,
            title: "invalid",
            url: "https://github.com/pingdotgg/codething-mvp/pull/0",
            baseRefName: "main",
            headRefName: "feature/invalid",
          },
          {
            number: 43,
            title: "  Valid PR  ",
            url: " https://github.com/pingdotgg/codething-mvp/pull/43 ",
            baseRefName: " main ",
            headRefName: " feature/pr-list ",
            headRepository: {
              nameWithOwner: "   ",
            },
            headRepositoryOwner: {
              login: "   ",
            },
          },
        ]),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listOpenPullRequests({
          cwd: "/repo",
          headSelector: "feature/pr-list",
        });
      });

      assert.deepStrictEqual(result, [
        {
          number: 43,
          title: "Valid PR",
          url: "https://github.com/pingdotgg/codething-mvp/pull/43",
          baseRefName: "main",
          headRefName: "feature/pr-list",
          state: "open",
          updatedAt: null,
        },
      ]);
    }),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockResolvedValueOnce({
        stdout: JSON.stringify({
          nameWithOwner: "octocat/codething-mvp",
          url: "https://github.com/octocat/codething-mvp",
          sshUrl: "git@github.com:octocat/codething-mvp.git",
        }),
        stderr: "",
        code: 0,
        signal: null,
        timedOut: false,
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getRepositoryCloneUrls({
          cwd: "/repo",
          repository: "octocat/codething-mvp",
        });
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "octocat/codething-mvp",
        url: "https://github.com/octocat/codething-mvp",
        sshUrl: "git@github.com:octocat/codething-mvp.git",
      });
    }),
  );

  it.effect("lists CHANGES_REQUESTED reviews as pull request feedback signals", () =>
    Effect.gen(function* () {
      mockFeedbackSignalResponses({
        reviews: [
          {
            id: 9001,
            state: "CHANGES_REQUESTED",
            body: "Please tighten the validation path.",
            user: {
              login: "reviewer",
            },
            submitted_at: "2026-05-01T10:00:00Z",
            html_url: "https://github.com/pingdotgg/codething-mvp/pull/42#pullrequestreview-9001",
          },
        ],
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listPullRequestFeedbackSignals({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, [
        {
          kind: "review",
          id: "9001",
          state: "CHANGES_REQUESTED",
          body: "Please tighten the validation path.",
          authorLogin: "reviewer",
          createdAt: "2026-05-01T10:00:00Z",
          updatedAt: "2026-05-01T10:00:00Z",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42#pullrequestreview-9001",
        },
      ]);
      expectFeedbackApiCalls();
    }),
  );

  it.effect("lists PR issue comments as pull request feedback signals", () =>
    Effect.gen(function* () {
      mockFeedbackSignalResponses({
        issueComments: [
          {
            id: 8101,
            body: "Can we cover the failure mode here?",
            user: {
              login: "commenter",
            },
            created_at: "2026-05-01T09:00:00Z",
            updated_at: "2026-05-01T11:00:00Z",
            html_url: "https://github.com/pingdotgg/codething-mvp/pull/42#issuecomment-8101",
          },
          {
            id: 8102,
            body: "   ",
            user: {
              login: "commenter",
            },
          },
          {
            body: "Missing IDs are ignored.",
          },
        ],
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listPullRequestFeedbackSignals({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, [
        {
          kind: "issue-comment",
          id: "8101",
          state: null,
          body: "Can we cover the failure mode here?",
          authorLogin: "commenter",
          createdAt: "2026-05-01T09:00:00Z",
          updatedAt: "2026-05-01T11:00:00Z",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42#issuecomment-8101",
        },
      ]);
      expectFeedbackApiCalls();
    }),
  );

  it.effect("lists inline review comments as pull request feedback signals", () =>
    Effect.gen(function* () {
      mockFeedbackSignalResponses({
        reviewComments: [
          {
            id: "7201",
            body: "This branch should be configurable.",
            user: {
              login: "inline-reviewer",
            },
            created_at: "2026-05-01T08:00:00Z",
            updated_at: "2026-05-01T08:30:00Z",
            html_url: "https://github.com/pingdotgg/codething-mvp/pull/42#discussion_r7201",
          },
        ],
      });

      const result = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.listPullRequestFeedbackSignals({
          cwd: "/repo",
          reference: "#42",
        });
      });

      assert.deepStrictEqual(result, [
        {
          kind: "review-comment",
          id: "7201",
          state: null,
          body: "This branch should be configurable.",
          authorLogin: "inline-reviewer",
          createdAt: "2026-05-01T08:00:00Z",
          updatedAt: "2026-05-01T08:30:00Z",
          url: "https://github.com/pingdotgg/codething-mvp/pull/42#discussion_r7201",
        },
      ]);
      expectFeedbackApiCalls();
    }),
  );

  it.effect("surfaces a friendly error when the pull request is not found", () =>
    Effect.gen(function* () {
      mockedRunProcess.mockRejectedValueOnce(
        new Error(
          "GraphQL: Could not resolve to a PullRequest with the number of 4888. (repository.pullRequest)",
        ),
      );

      const error = yield* Effect.gen(function* () {
        const gh = yield* GitHubCli;
        return yield* gh.getPullRequest({
          cwd: "/repo",
          reference: "4888",
        });
      }).pipe(Effect.flip);

      assert.equal(error.message.includes("Pull request not found"), true);
    }),
  );
});
