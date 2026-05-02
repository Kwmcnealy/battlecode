import { SymphonyIssueId, type SymphonyIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildCodexCloudDelegationComment,
  classifyCodexCloudReply,
  parseGitHubRepositoryFromRemoteUrl,
  type CodexCloudRepositoryContext,
} from "./codexCloud.ts";

function makeIssue(overrides: Partial<SymphonyIssue> = {}): SymphonyIssue {
  return {
    id: SymphonyIssueId.make("issue-1"),
    identifier: "APP-1",
    title: "Fix the dashboard",
    description: "Dashboard fails under load",
    priority: 1,
    state: "Todo",
    branchName: null,
    url: "https://linear.app/t3/issue/APP-1/fix-the-dashboard",
    labels: [],
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

describe("Codex Cloud Symphony helpers", () => {
  it.each([
    ["git@github.com:openai/codex.git", "openai/codex", "https://github.com/openai/codex"],
    ["git@github.com/openai/codex.git", "openai/codex", "https://github.com/openai/codex"],
    ["https://github.com/openai/codex.git", "openai/codex", "https://github.com/openai/codex"],
    ["https://github.com/openai/codex.GIT", "openai/codex", "https://github.com/openai/codex"],
    ["ssh://git@github.com/openai/codex", "openai/codex", "https://github.com/openai/codex"],
  ])("parses GitHub repository remote %s", (remoteUrl, nameWithOwner, httpsUrl) => {
    expect(parseGitHubRepositoryFromRemoteUrl(remoteUrl)).toEqual({
      nameWithOwner,
      httpsUrl,
      remoteUrl,
    });
  });

  it.each(["", "not a url", "git@gitlab.com:openai/codex.git", "https://github.com/openai"])(
    "rejects invalid GitHub repository remote %s",
    (remoteUrl) => {
      expect(parseGitHubRepositoryFromRemoteUrl(remoteUrl)).toBeNull();
    },
  );

  it("builds a Codex Cloud delegation comment without local absolute paths", () => {
    const repository: CodexCloudRepositoryContext = {
      nameWithOwner: "openai/codex",
      httpsUrl: "https://github.com/openai/codex",
      remoteUrl: "git@github.com:openai/codex.git",
    };

    const comment = buildCodexCloudDelegationComment({
      issue: makeIssue(),
      repository,
      branchName: "symphony/app-1-fix-dashboard",
      workflowPath: "/Users/caladyne/workspace/WORKFLOW.md",
      requestedModel: "GPT-5.5",
      requestedReasoning: "high",
    });

    expect(comment).toContain("@Codex");
    expect(comment).toContain("openai/codex");
    expect(comment).toContain("Repository: https://github.com/openai/codex");
    expect(comment).toContain("Issue: APP-1 - Fix the dashboard");
    expect(comment).toContain("Issue URL: https://linear.app/t3/issue/APP-1/fix-the-dashboard");
    expect(comment).toContain("Dashboard fails under load");
    expect(comment).toContain("Requested runtime: GPT-5.5, reasoning high.");
    expect(comment).toContain("Suggested branch: symphony/app-1-fix-dashboard");
    expect(comment).toContain("Workflow: Follow WORKFLOW.md in the repository root.");
    expect(comment).not.toContain("/Users/");
  });

  it("classifies Codex Cloud replies with task links", () => {
    expect(
      classifyCodexCloudReply("Created task https://codex.openai.com/tasks/task_123)"),
    ).toEqual({
      status: "detected",
      taskUrl: "https://codex.openai.com/tasks/task_123",
      message: null,
    });

    expect(classifyCodexCloudReply("Track it at https://codex.openai.com/tasks/task_123.")).toEqual(
      {
        status: "detected",
        taskUrl: "https://codex.openai.com/tasks/task_123",
        message: null,
      },
    );
  });

  it.each([".", ",", ";", ":", "!", "?"])(
    "trims trailing sentence punctuation from task links: %s",
    (punctuation) => {
      expect(
        classifyCodexCloudReply(
          `Track it at https://codex.openai.com/tasks/task_123/a.b-c_d${punctuation}`,
        ),
      ).toEqual({
        status: "detected",
        taskUrl: "https://codex.openai.com/tasks/task_123/a.b-c_d",
        message: null,
      });
    },
  );

  it("preserves valid punctuation inside task link paths", () => {
    expect(
      classifyCodexCloudReply("Track https://codex.openai.com/tasks/task_123/a.b-c_d."),
    ).toEqual({
      status: "detected",
      taskUrl: "https://codex.openai.com/tasks/task_123/a.b-c_d",
      message: null,
    });
  });

  it.each([
    "No suitable environment was found for this repository.",
    "Please connect your account before continuing.",
    "Couldn't confirm your Linear connection.",
    "Could not confirm your Linear connection.",
    "Install Codex for Linear to delegate this task.",
    "Make sure the repository is available to Codex Cloud.",
  ])("classifies Codex Cloud setup failures: %s", (message) => {
    expect(classifyCodexCloudReply(message)).toEqual({
      status: "failed",
      taskUrl: null,
      message,
    });
  });

  it.each([null, "", "I'll take a look when I can."])(
    "classifies empty or unrelated replies as unknown",
    (message) => {
      expect(classifyCodexCloudReply(message)).toEqual({
        status: "unknown",
        taskUrl: null,
        message: null,
      });
    },
  );
});
