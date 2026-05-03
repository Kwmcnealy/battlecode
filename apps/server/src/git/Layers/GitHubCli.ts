import { Effect, Layer, Result, Schema, SchemaIssue } from "effect";
import { TrimmedNonEmptyString } from "@t3tools/contracts";

import { runProcess } from "../../processRunner.ts";
import { GitHubCliError } from "@t3tools/contracts";
import {
  GitHubCli,
  type GitHubPullRequestFeedbackSignal,
  type GitHubRepositoryCloneUrls,
  type GitHubCliShape,
} from "../Services/GitHubCli.ts";
import {
  decodeGitHubPullRequestJson,
  decodeGitHubPullRequestListJson,
  formatGitHubJsonDecodeError,
} from "../githubPullRequests.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

function normalizeGitHubCliError(operation: "execute" | "stdout", error: unknown): GitHubCliError {
  if (error instanceof Error) {
    if (error.message.includes("Command not found: gh")) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI (`gh`) is required but not available on PATH.",
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("gh auth login") ||
      lower.includes("no oauth token")
    ) {
      return new GitHubCliError({
        operation,
        detail: "GitHub CLI is not authenticated. Run `gh auth login` and retry.",
        cause: error,
      });
    }

    if (
      lower.includes("could not resolve to a pullrequest") ||
      lower.includes("repository.pullrequest") ||
      lower.includes("no pull requests found for branch") ||
      lower.includes("pull request not found")
    ) {
      return new GitHubCliError({
        operation,
        detail: "Pull request not found. Check the PR number or URL and try again.",
        cause: error,
      });
    }

    return new GitHubCliError({
      operation,
      detail: `GitHub CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitHubCliError({
    operation,
    detail: "GitHub CLI command failed.",
    cause: error,
  });
}

const RawGitHubRepositoryCloneUrlsSchema = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});

const RawGitHubPullRequestFeedbackRecordSchema = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  state: Schema.optional(Schema.NullOr(Schema.String)),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        login: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  created_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  submitted_at: Schema.optional(Schema.NullOr(Schema.String)),
  html_url: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
});

type RawGitHubPullRequestFeedbackRecord = Schema.Schema.Type<
  typeof RawGitHubPullRequestFeedbackRecordSchema
>;

interface GitHubPullRequestUrlParts {
  readonly owner: string;
  readonly repository: string;
  readonly number: string;
}

function normalizeRepositoryCloneUrls(
  raw: Schema.Schema.Type<typeof RawGitHubRepositoryCloneUrlsSchema>,
): GitHubRepositoryCloneUrls {
  return {
    nameWithOwner: raw.nameWithOwner,
    url: raw.url,
    sshUrl: raw.sshUrl,
  };
}

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFeedbackId(id: string | number | undefined): string | null {
  if (typeof id === "number") {
    return Number.isFinite(id) ? String(id) : null;
  }
  return trimOptionalString(id);
}

function parsePullRequestUrl(url: string): GitHubPullRequestUrlParts | null {
  const match = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
    url.trim(),
  );
  const owner = match?.[1]?.trim() ?? "";
  const repository = match?.[2]?.trim() ?? "";
  const number = match?.[3]?.trim() ?? "";

  if (owner.length === 0 || repository.length === 0 || number.length === 0) {
    return null;
  }

  return { owner, repository, number };
}

function normalizeFeedbackSignal(
  kind: GitHubPullRequestFeedbackSignal["kind"],
  raw: RawGitHubPullRequestFeedbackRecord,
): GitHubPullRequestFeedbackSignal | null {
  const id = normalizeFeedbackId(raw.id);
  const body = trimOptionalString(raw.body);
  if (!id || !body) {
    return null;
  }

  const submittedAt = kind === "review" ? trimOptionalString(raw.submitted_at) : null;
  const createdAt = trimOptionalString(raw.created_at) ?? submittedAt;
  const updatedAt = trimOptionalString(raw.updated_at) ?? submittedAt ?? createdAt;

  return {
    kind,
    id,
    state: trimOptionalString(raw.state),
    body,
    authorLogin: trimOptionalString(raw.user?.login),
    createdAt,
    updatedAt,
    url: trimOptionalString(raw.html_url) ?? trimOptionalString(raw.url),
  };
}

function compareFeedbackSignals(
  left: GitHubPullRequestFeedbackSignal,
  right: GitHubPullRequestFeedbackSignal,
): number {
  const leftTimestamp = Date.parse(left.updatedAt ?? left.createdAt ?? "");
  const rightTimestamp = Date.parse(right.updatedAt ?? right.createdAt ?? "");
  const leftSortValue = Number.isFinite(leftTimestamp) ? leftTimestamp : 0;
  const rightSortValue = Number.isFinite(rightTimestamp) ? rightTimestamp : 0;
  if (leftSortValue !== rightSortValue) {
    return leftSortValue - rightSortValue;
  }

  return left.id.localeCompare(right.id);
}

type GitHubJsonDecodeOperation =
  | "listOpenPullRequests"
  | "getPullRequest"
  | "getRepositoryCloneUrls"
  | "listPullRequestFeedbackSignals";

function decodeGitHubJson<S extends Schema.Top>(
  raw: string,
  schema: S,
  operation: GitHubJsonDecodeOperation,
  invalidDetail: string,
): Effect.Effect<S["Type"], GitHubCliError, S["DecodingServices"]> {
  return Schema.decodeEffect(Schema.fromJsonString(schema))(raw).pipe(
    Effect.mapError(
      (error) =>
        new GitHubCliError({
          operation,
          detail: `${invalidDetail}: ${SchemaIssue.makeFormatterDefault()(error.issue)}`,
          cause: error,
        }),
    ),
  );
}

const makeGitHubCli = Effect.sync(() => {
  const execute: GitHubCliShape["execute"] = (input) =>
    Effect.tryPromise({
      try: () =>
        runProcess("gh", input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        }),
      catch: (error) => normalizeGitHubCliError("execute", error),
    });

  const getPullRequest: GitHubCliShape["getPullRequest"] = (input) =>
    execute({
      cwd: input.cwd,
      args: [
        "pr",
        "view",
        input.reference,
        "--json",
        "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
      ],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) =>
        Effect.sync(() => decodeGitHubPullRequestJson(raw)).pipe(
          Effect.flatMap((decoded) => {
            if (!Result.isSuccess(decoded)) {
              return Effect.fail(
                new GitHubCliError({
                  operation: "getPullRequest",
                  detail: `GitHub CLI returned invalid pull request JSON: ${formatGitHubJsonDecodeError(decoded.failure)}`,
                  cause: decoded.failure,
                }),
              );
            }

            return Effect.succeed(decoded.success);
          }),
        ),
      ),
    );

  const decodeFeedbackSignals = (raw: string, kind: GitHubPullRequestFeedbackSignal["kind"]) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return Effect.succeed([]);
    }

    return decodeGitHubJson(
      trimmed,
      Schema.Array(RawGitHubPullRequestFeedbackRecordSchema),
      "listPullRequestFeedbackSignals",
      "GitHub CLI returned invalid pull request feedback JSON.",
    ).pipe(
      Effect.map((records) =>
        records
          .map((record) => normalizeFeedbackSignal(kind, record))
          .filter((signal): signal is GitHubPullRequestFeedbackSignal => signal !== null),
      ),
    );
  };

  const listPullRequestFeedbackSignals: GitHubCliShape["listPullRequestFeedbackSignals"] = (
    input,
  ) =>
    getPullRequest(input).pipe(
      Effect.flatMap((summary) => {
        const pullRequest = parsePullRequestUrl(summary.url);
        if (!pullRequest) {
          return Effect.fail(
            new GitHubCliError({
              operation: "listPullRequestFeedbackSignals",
              detail: `Could not parse GitHub pull request URL: ${summary.url}`,
            }),
          );
        }

        const pullRequestApiBase = `repos/${pullRequest.owner}/${pullRequest.repository}`;
        const fetchSignals = (kind: GitHubPullRequestFeedbackSignal["kind"], path: string) =>
          execute({
            cwd: input.cwd,
            args: ["api", path, "--paginate"],
          }).pipe(
            Effect.map((result) => result.stdout),
            Effect.flatMap((raw) => decodeFeedbackSignals(raw, kind)),
          );

        return Effect.all(
          [
            fetchSignals("review", `${pullRequestApiBase}/pulls/${pullRequest.number}/reviews`),
            fetchSignals(
              "issue-comment",
              `${pullRequestApiBase}/issues/${pullRequest.number}/comments`,
            ),
            fetchSignals(
              "review-comment",
              `${pullRequestApiBase}/pulls/${pullRequest.number}/comments`,
            ),
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.map(([reviews, issueComments, reviewComments]) =>
            [...reviews, ...issueComments, ...reviewComments].toSorted(compareFeedbackSignals),
          ),
        );
      }),
    );

  const service = {
    execute,
    listOpenPullRequests: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headSelector,
          "--state",
          input.state ?? "open",
          "--limit",
          String(input.limit ?? 1),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt,isCrossRepository,headRepository,headRepositoryOwner",
        ],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          raw.length === 0
            ? Effect.succeed([])
            : Effect.sync(() => decodeGitHubPullRequestListJson(raw)).pipe(
                Effect.flatMap((decoded) => {
                  if (!Result.isSuccess(decoded)) {
                    return Effect.fail(
                      new GitHubCliError({
                        operation: "listOpenPullRequests",
                        detail: `GitHub CLI returned invalid PR list JSON: ${formatGitHubJsonDecodeError(decoded.failure)}`,
                        cause: decoded.failure,
                      }),
                    );
                  }

                  return Effect.succeed(decoded.success);
                }),
              ),
        ),
      ),
    getPullRequest,
    listPullRequestFeedbackSignals,
    getRepositoryCloneUrls: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", input.repository, "--json", "nameWithOwner,url,sshUrl"],
      }).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.flatMap((raw) =>
          decodeGitHubJson(
            raw,
            RawGitHubRepositoryCloneUrlsSchema,
            "getRepositoryCloneUrls",
            "GitHub CLI returned invalid repository JSON.",
          ),
        ),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    createPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headSelector,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.asVoid),
    getDefaultBranch: (input) =>
      execute({
        cwd: input.cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((value) => {
          const trimmed = value.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
    checkoutPullRequest: (input) =>
      execute({
        cwd: input.cwd,
        args: ["pr", "checkout", input.reference, ...(input.force ? ["--force"] : [])],
      }).pipe(Effect.asVoid),
  } satisfies GitHubCliShape;

  return service;
});

export const GitHubCliLive = Layer.effect(GitHubCli, makeGitHubCli);
