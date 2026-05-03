import { Effect } from "effect";
import {
  SymphonyError,
  SymphonyIssue,
  SymphonyIssueId,
  type SymphonyWorkflowConfig,
} from "@t3tools/contracts";

import { classifyCodexCloudReply } from "./codexCloud.ts";

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

const LINEAR_UPDATE_COMMENT_MUTATION = `
mutation SymphonyUpdateComment($commentId: String!, $body: String!) {
  commentUpdate(id: $commentId, input: { body: $body }) {
    success
    comment {
      id
      url
      body
      updatedAt
    }
  }
}
`;

const LINEAR_ISSUE_COMMENTS_QUERY = `
query SymphonyIssueComments($issueId: String!) {
  issue(id: $issueId) {
    comments(first: 100) {
      nodes {
        id
        url
        body
        createdAt
        updatedAt
        user { id name displayName }
      }
    }
  }
}
`;

const LINEAR_ISSUES_BY_IDS_QUERY = `
query SymphonyIssuesByIds($ids: [String!]) {
  issues(first: 100, filter: { id: { in: $ids } }) {
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
      team { id name key }
      state { id name }
      labels { nodes { name } }
      relations { nodes { type relatedIssue { id identifier state { name } } } }
    }
  }
}
`;

const LINEAR_WORKFLOW_STATES_QUERY = `
query SymphonyWorkflowStates($teamId: String!) {
  workflowStates(first: 100, filter: { team: { id: { eq: $teamId } } }) {
    nodes {
      id
      name
      team { id name key }
    }
  }
}
`;

const LINEAR_UPDATE_ISSUE_STATE_MUTATION = `
mutation SymphonyUpdateIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue {
      id
      identifier
      state { id name }
    }
  }
}
`;

export interface LinearCommentResult {
  readonly id: string;
  readonly url: string | null;
}

export interface LinearIssueComment {
  readonly id: string;
  readonly url: string | null;
  readonly body: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly userName: string | null;
}

export interface LinearWorkflowTeam {
  readonly id: string;
  readonly name: string | null;
  readonly key: string | null;
}

export interface LinearWorkflowState {
  readonly id: string;
  readonly name: string;
}

export interface LinearIssueWorkflowContext {
  readonly issue: SymphonyIssue;
  readonly team: LinearWorkflowTeam;
  readonly state: LinearWorkflowState;
}

export interface LinearIssueStateUpdateResult {
  readonly changed: boolean;
  readonly stateId: string;
  readonly stateName: string;
}

export interface LinearCodexTaskDetection {
  readonly status: "detected" | "failed" | "unknown";
  readonly taskUrl: string | null;
  readonly linearCommentId: string | null;
  readonly message: string | null;
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

function normalizeLinearWorkflowTeam(value: unknown): LinearWorkflowTeam | null {
  const team = readRecord(value);
  const id = team ? readString(team.id) : null;
  if (!team || !id) {
    return null;
  }
  return {
    id,
    name: readString(team.name),
    key: readString(team.key),
  };
}

function normalizeLinearWorkflowState(value: unknown): LinearWorkflowState | null {
  const state = readRecord(value);
  const id = state ? readString(state.id) : null;
  const name = state ? readString(state.name) : null;
  if (!state || !id || !name) {
    return null;
  }
  return { id, name };
}

function normalizeLinearIssueWorkflowContext(
  node: Record<string, unknown>,
): LinearIssueWorkflowContext | null {
  const issue = normalizeLinearIssue(node);
  const team = normalizeLinearWorkflowTeam(node.team);
  const state = normalizeLinearWorkflowState(node.state);
  if (!issue || !team || !state) {
    return null;
  }
  return {
    issue,
    team,
    state,
  };
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

export function updateLinearComment(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly commentId: string;
  readonly body: string;
}): Effect.Effect<LinearCommentResult, SymphonyError> {
  return linearGraphql({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    query: LINEAR_UPDATE_COMMENT_MUTATION,
    variables: {
      commentId: input.commentId,
      body: input.body,
    },
  }).pipe(
    Effect.flatMap((body) =>
      Effect.try({
        try: () => {
          const data = readNestedRecord(body, "data");
          const commentUpdate = data ? readNestedRecord(data, "commentUpdate") : null;
          if (commentUpdate?.success !== true) {
            throw new Error("Linear did not update the Symphony managed progress comment.");
          }
          const comment = readRecord(commentUpdate.comment);
          const id = comment ? readString(comment.id) : null;
          if (!id) {
            throw new Error("Linear comment update response did not include a comment id.");
          }
          return {
            id,
            url: comment ? readString(comment.url) : null,
          };
        },
        catch: (cause) =>
          new SymphonyError({
            message:
              cause instanceof Error
                ? cause.message
                : "Failed to parse Linear comment update response.",
            cause,
          }),
      }),
    ),
  );
}

function normalizeLinearIssueComment(value: unknown): LinearIssueComment | null {
  const comment = readRecord(value);
  const id = comment ? readString(comment.id) : null;
  if (!comment || !id) {
    return null;
  }
  const user = readRecord(comment.user);
  const userName = user ? (readString(user.displayName) ?? readString(user.name)) : null;
  return {
    id,
    url: readString(comment.url),
    body: readString(comment.body),
    createdAt: readString(comment.createdAt),
    updatedAt: readString(comment.updatedAt),
    userName,
  };
}

export function fetchLinearIssueComments(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly issueId: string;
}): Effect.Effect<readonly LinearIssueComment[], SymphonyError> {
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
      return nodes.flatMap((node) => {
        const normalized = normalizeLinearIssueComment(node);
        return normalized ? [normalized] : [];
      });
    }),
  );
}

function parseValidDateMillis(value: string | null): number | null {
  if (!value) return null;
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : millis;
}

function shouldSkipComment(input: {
  readonly commentCreatedAt: string | null;
  readonly delegatedAfter: string | null | undefined;
}): boolean {
  const delegatedAfterMillis = parseValidDateMillis(input.delegatedAfter ?? null);
  const commentCreatedAtMillis = parseValidDateMillis(input.commentCreatedAt);

  return (
    delegatedAfterMillis !== null &&
    commentCreatedAtMillis !== null &&
    commentCreatedAtMillis < delegatedAfterMillis
  );
}

export function detectLinearCodexTask(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly issueId: string;
  readonly delegatedAfter?: string | null;
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
      let firstFailedReply: LinearCodexTaskDetection | null = null;
      for (const entry of nodes) {
        const comment = readRecord(entry);
        if (!comment) continue;
        if (
          shouldSkipComment({
            commentCreatedAt: readString(comment.createdAt),
            delegatedAfter: input.delegatedAfter,
          })
        ) {
          continue;
        }
        const classification = classifyCodexCloudReply(readString(comment.body));
        if (classification.status === "detected") {
          return {
            status: "detected",
            taskUrl: classification.taskUrl,
            linearCommentId: readString(comment.id),
            message: classification.message,
          };
        }
        if (classification.status === "failed" && !firstFailedReply) {
          firstFailedReply = {
            status: "failed",
            taskUrl: classification.taskUrl,
            linearCommentId: readString(comment.id),
            message: classification.message,
          };
        }
      }
      if (firstFailedReply) {
        return firstFailedReply;
      }
      return {
        status: "unknown",
        taskUrl: null,
        linearCommentId: null,
        message: null,
      };
    }),
  );
}

export function fetchLinearIssuesByIds(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly issueIds: readonly string[];
}): Effect.Effect<readonly LinearIssueWorkflowContext[], SymphonyError> {
  const issueIds = [...new Set(input.issueIds.filter((id) => id.trim().length > 0))];
  if (issueIds.length === 0) {
    return Effect.succeed([]);
  }

  return linearGraphql({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    query: LINEAR_ISSUES_BY_IDS_QUERY,
    variables: {
      ids: issueIds,
    },
  }).pipe(
    Effect.map((body) => {
      const data = readNestedRecord(body, "data");
      const issues = data ? readNestedRecord(data, "issues") : null;
      const nodes = issues ? readArray(issues.nodes) : [];
      return nodes.flatMap((node) => {
        const record = readRecord(node);
        const normalized = record ? normalizeLinearIssueWorkflowContext(record) : null;
        return normalized ? [normalized] : [];
      });
    }),
  );
}

function namesMatch(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

export function resolveLinearWorkflowStateId(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly teamId: string;
  readonly stateName: string;
}): Effect.Effect<LinearWorkflowState, SymphonyError> {
  const targetStateName = input.stateName.trim();
  if (targetStateName.length === 0) {
    return Effect.fail(new SymphonyError({ message: "Linear workflow state name is required." }));
  }

  return linearGraphql({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    query: LINEAR_WORKFLOW_STATES_QUERY,
    variables: {
      teamId: input.teamId,
    },
  }).pipe(
    Effect.flatMap((body) =>
      Effect.try({
        try: () => {
          const data = readNestedRecord(body, "data");
          const workflowStates = data ? readNestedRecord(data, "workflowStates") : null;
          const nodes = workflowStates ? readArray(workflowStates.nodes) : [];
          const states = nodes.flatMap((node) => {
            const record = readRecord(node);
            const state = record ? normalizeLinearWorkflowState(record) : null;
            return state ? [state] : [];
          });
          const matchedState = states.find((state) => namesMatch(state.name, targetStateName));
          if (!matchedState) {
            throw new Error(`Linear workflow state "${targetStateName}" was not found.`);
          }
          return matchedState;
        },
        catch: (cause) =>
          new SymphonyError({
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to resolve Linear workflow state "${targetStateName}".`,
            cause,
          }),
      }),
    ),
  );
}

export function updateLinearIssueState(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly issue: LinearIssueWorkflowContext;
  readonly stateName: string;
}): Effect.Effect<LinearIssueStateUpdateResult, SymphonyError, never> {
  const targetStateName = input.stateName.trim();
  if (targetStateName.length === 0) {
    return Effect.fail(new SymphonyError({ message: "Linear workflow state name is required." }));
  }
  if (namesMatch(input.issue.state.name, targetStateName)) {
    const result: LinearIssueStateUpdateResult = {
      changed: false,
      stateId: input.issue.state.id,
      stateName: input.issue.state.name,
    };
    return Effect.succeed(result);
  }

  return resolveLinearWorkflowStateId({
    endpoint: input.endpoint,
    apiKey: input.apiKey,
    teamId: input.issue.team.id,
    stateName: targetStateName,
  }).pipe(
    Effect.flatMap(
      (targetState): Effect.Effect<LinearIssueStateUpdateResult, SymphonyError, never> => {
        if (targetState.id === input.issue.state.id) {
          const result: LinearIssueStateUpdateResult = {
            changed: false,
            stateId: targetState.id,
            stateName: targetState.name,
          };
          return Effect.succeed(result);
        }
        return linearGraphql({
          endpoint: input.endpoint,
          apiKey: input.apiKey,
          query: LINEAR_UPDATE_ISSUE_STATE_MUTATION,
          variables: {
            issueId: input.issue.issue.id,
            stateId: targetState.id,
          },
        }).pipe(
          Effect.flatMap((body) =>
            Effect.try({
              try: () => {
                const data = readNestedRecord(body, "data");
                const issueUpdate = data ? readNestedRecord(data, "issueUpdate") : null;
                if (issueUpdate?.success !== true) {
                  throw new Error("Linear did not update the issue state.");
                }
                const issue = issueUpdate ? readNestedRecord(issueUpdate, "issue") : null;
                const state = issue ? normalizeLinearWorkflowState(issue.state) : null;
                const result: LinearIssueStateUpdateResult = {
                  changed: true,
                  stateId: state?.id ?? targetState.id,
                  stateName: state?.name ?? targetState.name,
                };
                return result;
              },
              catch: (cause) =>
                new SymphonyError({
                  message:
                    cause instanceof Error
                      ? cause.message
                      : "Failed to parse Linear issue state update response.",
                  cause,
                }),
            }),
          ),
        );
      },
    ),
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
