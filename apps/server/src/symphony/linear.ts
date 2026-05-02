import { Effect } from "effect";
import {
  SymphonyError,
  SymphonyIssue,
  SymphonyIssueId,
  type SymphonyWorkflowConfig,
} from "@t3tools/contracts";

export const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function readArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNestedRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  return readRecord(value[key]);
}

function labelsFromNode(node: Record<string, unknown>): string[] {
  const labels = readNestedRecord(node, "labels");
  const nodes = labels ? readArray(labels.nodes) : [];
  return nodes
    .map((entry) => readString(readRecord(entry)?.name))
    .filter((label): label is string => label !== null)
    .map((label) => label.toLowerCase());
}

function blockersFromNode(node: Record<string, unknown>): SymphonyIssue["blockedBy"] {
  const relations = readNestedRecord(node, "relations");
  const nodes = relations ? readArray(relations.nodes) : [];
  return nodes.flatMap((entry) => {
    const relation = readRecord(entry);
    if (!relation || relation.type !== "blocks") {
      return [];
    }
    const relatedIssue = readNestedRecord(relation, "relatedIssue");
    if (!relatedIssue) {
      return [];
    }
    const state = readNestedRecord(relatedIssue, "state");
    return [
      {
        id: readString(relatedIssue.id),
        identifier: readString(relatedIssue.identifier),
        state: state ? readString(state.name) : null,
      },
    ];
  });
}

export function normalizeLinearIssue(node: Record<string, unknown>): SymphonyIssue | null {
  const id = readString(node.id);
  const identifier = readString(node.identifier);
  const title = readString(node.title);
  const state = readNestedRecord(node, "state");
  const stateName = state ? readString(state.name) : null;
  if (!id || !identifier || !title || !stateName) {
    return null;
  }

  return {
    id: SymphonyIssueId.make(id),
    identifier,
    title,
    description: readString(node.description),
    priority: readNumber(node.priority),
    state: stateName,
    branchName: readString(node.branchName),
    url: readString(node.url),
    labels: labelsFromNode(node),
    blockedBy: blockersFromNode(node),
    createdAt: readString(node.createdAt),
    updatedAt: readString(node.updatedAt),
  };
}

const LINEAR_CANDIDATES_QUERY = `
query SymphonyCandidateIssues($projectSlug: String!, $states: [String!], $after: String) {
  issues(
    first: 50
    after: $after
    filter: {
      project: { slugId: { eq: $projectSlug } }
      state: { name: { in: $states } }
    }
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      url
      branchName
      createdAt
      updatedAt
      state { name }
      labels { nodes { name } }
      relations { nodes { type relatedIssue { id identifier state { name } } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
`;

const LINEAR_TEST_QUERY = `query SymphonyViewer { viewer { id name } }`;

const LINEAR_CREATE_COMMENT_MUTATION = `
mutation SymphonyCreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment {
      id
      url
      body
      createdAt
    }
  }
}
`;

const LINEAR_ISSUE_COMMENTS_QUERY = `
query SymphonyIssueComments($issueId: String!) {
  issue(id: $issueId) {
    comments(first: 50) {
      nodes {
        id
        url
        body
        createdAt
      }
    }
  }
}
`;

export interface LinearCommentResult {
  readonly id: string;
  readonly url: string | null;
}

export interface LinearCodexTaskDetection {
  readonly taskUrl: string | null;
  readonly linearCommentId: string | null;
}

function linearGraphql(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly query: string;
  readonly variables?: Record<string, unknown>;
}): Effect.Effect<Record<string, unknown>, SymphonyError> {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(input.endpoint, {
        method: "POST",
        headers: {
          authorization: input.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: input.query,
          variables: input.variables ?? {},
        }),
      });
      const body = (await response.json()) as unknown;
      if (!response.ok) {
        throw new Error(`Linear request failed with HTTP ${response.status}.`);
      }
      if (!isRecord(body)) {
        throw new Error("Linear returned a non-object GraphQL response.");
      }
      if (Array.isArray(body.errors) && body.errors.length > 0) {
        throw new Error(JSON.stringify(body.errors));
      }
      return body;
    },
    catch: (cause) =>
      new SymphonyError({
        message: cause instanceof Error ? cause.message : "Linear request failed.",
        cause,
      }),
  });
}

export function testLinearConnection(input: {
  readonly endpoint: string;
  readonly apiKey: string;
}): Effect.Effect<Record<string, unknown>, SymphonyError> {
  return linearGraphql({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    query: LINEAR_TEST_QUERY,
  });
}

export function createLinearComment(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly issueId: string;
  readonly body: string;
}): Effect.Effect<LinearCommentResult, SymphonyError> {
  return linearGraphql({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    query: LINEAR_CREATE_COMMENT_MUTATION,
    variables: {
      issueId: input.issueId,
      body: input.body,
    },
  }).pipe(
    Effect.flatMap((body) =>
      Effect.try({
        try: () => {
          const data = readNestedRecord(body, "data");
          const commentCreate = data ? readNestedRecord(data, "commentCreate") : null;
          if (commentCreate?.success !== true) {
            throw new Error("Linear did not create the Symphony cloud delegation comment.");
          }
          const comment = readRecord(commentCreate.comment);
          const id = comment ? readString(comment.id) : null;
          if (!id) {
            throw new Error("Linear comment response did not include a comment id.");
          }
          return {
            id,
            url: comment ? readString(comment.url) : null,
          };
        },
        catch: (cause) =>
          new SymphonyError({
            message:
              cause instanceof Error ? cause.message : "Failed to parse Linear comment response.",
            cause,
          }),
      }),
    ),
  );
}

function detectCodexTaskUrl(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/https:\/\/codex\.openai\.com\/[^\s)]+/i);
  return match?.[0] ?? null;
}

export function detectLinearCodexTask(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly issueId: string;
}): Effect.Effect<LinearCodexTaskDetection, SymphonyError> {
  return linearGraphql({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    query: LINEAR_ISSUE_COMMENTS_QUERY,
    variables: {
      issueId: input.issueId,
    },
  }).pipe(
    Effect.map((body) => {
      const data = readNestedRecord(body, "data");
      const issue = data ? readNestedRecord(data, "issue") : null;
      const comments = issue ? readNestedRecord(issue, "comments") : null;
      const nodes = comments ? readArray(comments.nodes) : [];
      for (const entry of nodes) {
        const comment = readRecord(entry);
        if (!comment) continue;
        const taskUrl = detectCodexTaskUrl(readString(comment.body));
        if (taskUrl) {
          return {
            taskUrl,
            linearCommentId: readString(comment.id),
          };
        }
      }
      return {
        taskUrl: null,
        linearCommentId: null,
      };
    }),
  );
}

export function fetchLinearCandidates(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly config: SymphonyWorkflowConfig;
}): Effect.Effect<readonly SymphonyIssue[], SymphonyError> {
  const fetchPage = (
    after: string | null,
    accumulated: readonly SymphonyIssue[],
  ): Effect.Effect<readonly SymphonyIssue[], SymphonyError> =>
    linearGraphql({
      endpoint: input.endpoint,
      apiKey: input.apiKey,
      query: LINEAR_CANDIDATES_QUERY,
      variables: {
        projectSlug: input.config.tracker.projectSlug,
        states: input.config.tracker.activeStates,
        after,
      },
    }).pipe(
      Effect.flatMap((body) => {
        const data = readNestedRecord(body, "data");
        const issues = data ? readNestedRecord(data, "issues") : null;
        const nodes = issues ? readArray(issues.nodes) : [];
        const pageInfo = issues ? readNestedRecord(issues, "pageInfo") : null;
        const nextIssues = [
          ...accumulated,
          ...nodes.flatMap((node) => {
            const record = readRecord(node);
            const normalized = record ? normalizeLinearIssue(record) : null;
            return normalized ? [normalized] : [];
          }),
        ];
        const hasNextPage = pageInfo?.hasNextPage === true;
        const endCursor = pageInfo ? readString(pageInfo.endCursor) : null;
        return hasNextPage && endCursor
          ? fetchPage(endCursor, nextIssues)
          : Effect.succeed(nextIssues);
      }),
    );

  return fetchPage(null, []);
}
