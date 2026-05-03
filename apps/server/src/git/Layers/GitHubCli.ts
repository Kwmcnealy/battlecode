import { Effect, Layer, Result, Schema, SchemaIssue } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { parseGitHubRepositoryNameWithOwnerFromRemoteUrl } from "@t3tools/shared/git";

import { runProcess } from "../../processRunner.ts";
import { GitHubCliError } from "@t3tools/contracts";
import {
  GitHubCli,
  type GitHubPullRequestSummary,
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

const RawGitHubRestPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged_at: Schema.optional(Schema.NullOr(Schema.String)),
  updated_at: Schema.optional(Schema.NullOr(Schema.String)),
  base: Schema.Struct({
    ref: TrimmedNonEmptyString,
  }),
  head: Schema.Struct({
    ref: TrimmedNonEmptyString,
    repo: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          full_name: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
    user: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          login: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
});

type RawGitHubRestPullRequest = Schema.Schema.Type<typeof RawGitHubRestPullRequestSchema>;

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

function parsePullRequestReference(reference: string): number | null {
  const trimmed = reference.trim().replace(/^#/, "");
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeRestPullRequestState(
  raw: RawGitHubRestPullRequest,
): NonNullable<GitHubPullRequestSummary["state"]> {
  if (trimOptionalString(raw.merged_at)) {
    return "merged";
  }
  return raw.state?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

function normalizeRestPullRequest(raw: RawGitHubRestPullRequest): GitHubPullRequestSummary {
  const headRepositoryNameWithOwner = trimOptionalString(raw.head.repo?.full_name);
  const headRepositoryOwnerLogin =
    trimOptionalString(raw.head.user?.login) ??
    (headRepositoryNameWithOwner?.includes("/")
      ? (headRepositoryNameWithOwner.split("/")[0] ?? null)
      : null);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    baseRefName: raw.base.ref,
    headRefName: raw.head.ref,
    state: normalizeRestPullRequestState(raw),
    updatedAt: trimOptionalString(raw.updated_at),
    ...(headRepositoryNameWithOwner ? { headRepositoryNameWithOwner } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

function parseNameWithOwner(value: string): {
  readonly owner: string;
  readonly repository: string;
} {
  const [owner, repository] = value.split("/");
  if (!owner || !repository) {
    throw new Error(`Invalid GitHub repository identifier: ${value}`);
  }
  return { owner, repository };
}

type GitHubJsonDecodeOperation =
  | "listOpenPullRequests"
  | "getPullRequest"
  | "getRepositoryCloneUrls";

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

  const readOriginRepositoryNameWithOwner = (cwd: string) =>
    Effect.tryPromise({
      try: async () => {
        const result = await runProcess("git", ["config", "--get", "remote.origin.url"], {
          cwd,
          timeoutMs: DEFAULT_TIMEOUT_MS,
        });
        const nameWithOwner = parseGitHubRepositoryNameWithOwnerFromRemoteUrl(result.stdout.trim());
        if (!nameWithOwner) {
          throw new Error("remote.origin.url is not a GitHub repository.");
        }
        return nameWithOwner;
      },
      catch: (error) =>
        new GitHubCliError({
          operation: "resolveRepository",
          detail: `Could not resolve GitHub repository from remote.origin.url: ${
            error instanceof Error ? error.message : String(error)
          }`,
          cause: error,
        }),
    });

  const readOriginRepositoryParts = (cwd: string) =>
    readOriginRepositoryNameWithOwner(cwd).pipe(
      Effect.flatMap((nameWithOwner) =>
        Effect.try({
          try: () => parseNameWithOwner(nameWithOwner),
          catch: (error) =>
            new GitHubCliError({
              operation: "resolveRepository",
              detail: `Could not parse GitHub repository from remote.origin.url: ${
                error instanceof Error ? error.message : String(error)
              }`,
              cause: error,
            }),
        }),
      ),
    );

  const decodeRestPullRequest = (raw: string, operation: GitHubJsonDecodeOperation) =>
    decodeGitHubJson(
      raw,
      RawGitHubRestPullRequestSchema,
      operation,
      "GitHub REST API returned invalid pull request JSON.",
    ).pipe(Effect.map(normalizeRestPullRequest));

  const decodeRestPullRequestList = (raw: string) =>
    decodeGitHubJson(
      raw,
      Schema.Array(RawGitHubRestPullRequestSchema),
      "listOpenPullRequests",
      "GitHub REST API returned invalid pull request list JSON.",
    ).pipe(Effect.map((records) => records.map(normalizeRestPullRequest)));

  const restPullRequestByParts = (input: {
    readonly cwd: string;
    readonly owner: string;
    readonly repository: string;
    readonly number: string | number;
  }) =>
    execute({
      cwd: input.cwd,
      args: ["api", `repos/${input.owner}/${input.repository}/pulls/${input.number}`],
    }).pipe(
      Effect.map((result) => result.stdout.trim()),
      Effect.flatMap((raw) => decodeRestPullRequest(raw, "getPullRequest")),
    );

  const getPullRequestViaRest: GitHubCliShape["getPullRequest"] = (input) => {
    const parsedUrl = parsePullRequestUrl(input.reference);
    if (parsedUrl) {
      return restPullRequestByParts({
        cwd: input.cwd,
        owner: parsedUrl.owner,
        repository: parsedUrl.repository,
        number: parsedUrl.number,
      });
    }

    const number = parsePullRequestReference(input.reference);
    if (!number) {
      return Effect.fail(
        new GitHubCliError({
          operation: "getPullRequest",
          detail: "REST fallback requires a pull request URL or number.",
        }),
      );
    }

    return readOriginRepositoryParts(input.cwd).pipe(
      Effect.flatMap(({ owner, repository }) =>
        restPullRequestByParts({
          cwd: input.cwd,
          owner,
          repository,
          number,
        }),
      ),
    );
  };

  const getPullRequestFromGh: GitHubCliShape["getPullRequest"] = (input) =>
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

  const getPullRequest: GitHubCliShape["getPullRequest"] = (input) =>
    getPullRequestFromGh(input).pipe(
      Effect.catch((primaryError) =>
        getPullRequestViaRest(input).pipe(
          Effect.mapError(
            (fallbackError) =>
              new GitHubCliError({
                operation: "getPullRequest",
                detail: `${primaryError.message}; REST fallback failed: ${fallbackError.message}`,
                cause: fallbackError,
              }),
          ),
        ),
      ),
    );

  const listOpenPullRequestsFromGh: GitHubCliShape["listOpenPullRequests"] = (input) =>
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
    );

  const listOpenPullRequestsViaRest: GitHubCliShape["listOpenPullRequests"] = (input) =>
    readOriginRepositoryParts(input.cwd).pipe(
      Effect.flatMap(({ owner, repository }) => {
        const params = new URLSearchParams({
          state: input.state ?? "open",
          head: `${owner}:${input.headSelector}`,
          per_page: String(input.limit ?? 1),
        });
        return execute({
          cwd: input.cwd,
          args: ["api", `repos/${owner}/${repository}/pulls?${params.toString()}`],
        }).pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.flatMap(decodeRestPullRequestList),
        );
      }),
    );

  const service = {
    execute,
    listOpenPullRequests: (input) =>
      listOpenPullRequestsFromGh(input).pipe(
        Effect.catch((primaryError) =>
          listOpenPullRequestsViaRest(input).pipe(
            Effect.mapError(
              (fallbackError) =>
                new GitHubCliError({
                  operation: "listOpenPullRequests",
                  detail: `${primaryError.message}; REST fallback failed: ${fallbackError.message}`,
                  cause: fallbackError,
                }),
            ),
          ),
        ),
      ),
    getPullRequest,
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
