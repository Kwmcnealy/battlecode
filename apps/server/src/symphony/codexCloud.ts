import { basename, isAbsolute } from "node:path";

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

const GITHUB_HOST = "github.com";
const GITHUB_TASK_URL_PATTERN = /https:\/\/codex\.openai\.com\/[^\s)]+/i;
const TRAILING_SENTENCE_PUNCTUATION_PATTERN = /[.,;:!?]+$/;
const FAILURE_MESSAGES = [
  "no suitable environment",
  "connect your account",
  "couldn't confirm your linear connection",
  "could not confirm your linear connection",
  "install codex for linear",
  "repository is available",
] as const;

function normalizeGitHubPath(pathname: string): { owner: string; repo: string } | null {
  const parts = pathname.replace(/^\/+/, "").split("/").filter(Boolean);

  if (parts.length !== 2) {
    return null;
  }

  const owner = parts[0];
  const rawRepo = parts[1];

  if (!owner || !rawRepo) {
    return null;
  }

  const repo = rawRepo.toLowerCase().endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;

  if (!repo) {
    return null;
  }

  return { owner, repo };
}

function trimTrailingSentencePunctuation(url: string): string {
  return url.replace(TRAILING_SENTENCE_PUNCTUATION_PATTERN, "");
}

export function parseGitHubRepositoryFromRemoteUrl(
  remoteUrl: string,
): CodexCloudRepositoryContext | null {
  const trimmedRemoteUrl = remoteUrl.trim();

  if (!trimmedRemoteUrl) {
    return null;
  }

  const scpLikeMatch = /^git@github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i.exec(trimmedRemoteUrl);
  if (scpLikeMatch) {
    const remotePath = scpLikeMatch[1];

    if (!remotePath) {
      return null;
    }

    const repositoryPath = normalizeGitHubPath(remotePath);

    if (!repositoryPath) {
      return null;
    }

    const nameWithOwner = `${repositoryPath.owner}/${repositoryPath.repo}`;
    return {
      nameWithOwner,
      httpsUrl: `https://github.com/${nameWithOwner}`,
      remoteUrl: trimmedRemoteUrl,
    };
  }

  try {
    const parsedUrl = new URL(trimmedRemoteUrl);

    if (parsedUrl.hostname.toLowerCase() !== GITHUB_HOST) {
      return null;
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "ssh:") {
      return null;
    }

    if (parsedUrl.protocol === "ssh:" && parsedUrl.username !== "git") {
      return null;
    }

    const repositoryPath = normalizeGitHubPath(parsedUrl.pathname);
    if (!repositoryPath) {
      return null;
    }

    const nameWithOwner = `${repositoryPath.owner}/${repositoryPath.repo}`;
    return {
      nameWithOwner,
      httpsUrl: `https://github.com/${nameWithOwner}`,
      remoteUrl: trimmedRemoteUrl,
    };
  } catch {
    return null;
  }
}

export function buildCodexCloudDelegationComment(input: CodexCloudDelegationInput): string {
  const workflowName = isAbsolute(input.workflowPath)
    ? basename(input.workflowPath)
    : input.workflowPath;
  const lines = [
    `@Codex please work on this Linear issue in ${input.repository.nameWithOwner}.`,
    "",
    `Repository: ${input.repository.httpsUrl}`,
    `Issue: ${input.issue.identifier} - ${input.issue.title}`,
  ];

  if (input.issue.url) {
    lines.push(`Issue URL: ${input.issue.url}`);
  }

  if (input.issue.description) {
    lines.push("", "Issue description:", input.issue.description);
  }

  lines.push(
    "",
    `Requested runtime: ${input.requestedModel}, reasoning ${input.requestedReasoning}. If Codex Cloud manages model selection for this integration, use the best available cloud coding model.`,
    `Suggested branch: ${input.branchName}`,
    `Workflow: Follow ${workflowName || "WORKFLOW.md"} in the repository root. Validate changes, push the branch, and open or update a pull request when ready.`,
  );

  return lines.join("\n");
}

export function classifyCodexCloudReply(text: string | null): CodexCloudReplyClassification {
  const trimmedText = text?.trim() ?? "";

  if (!trimmedText) {
    return { status: "unknown", taskUrl: null, message: null };
  }

  const taskUrlMatch = GITHUB_TASK_URL_PATTERN.exec(trimmedText);
  if (taskUrlMatch) {
    return {
      status: "detected",
      taskUrl: trimTrailingSentencePunctuation(taskUrlMatch[0]),
      message: null,
    };
  }

  const lowerText = trimmedText.toLowerCase();
  if (FAILURE_MESSAGES.some((message) => lowerText.includes(message))) {
    return { status: "failed", taskUrl: null, message: trimmedText };
  }

  return { status: "unknown", taskUrl: null, message: null };
}
