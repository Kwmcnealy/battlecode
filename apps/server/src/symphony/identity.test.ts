import { ProjectId, SymphonyIssueId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { isSymphonyThreadId, runId, threadId } from "./identity.ts";

describe("Symphony identity", () => {
  it("only treats Symphony-owned thread ids as Symphony work", () => {
    expect(isSymphonyThreadId(ThreadId.make("symphony-thread-abc123"))).toBe(true);
    expect(isSymphonyThreadId(ThreadId.make("thread-normal-chat"))).toBe(false);
    expect(isSymphonyThreadId(ThreadId.make("symphony-message-abc123"))).toBe(false);
  });

  it("derives stable run and thread ids for a project issue pair", () => {
    const projectId = ProjectId.make("project-symphony");
    const issueId = SymphonyIssueId.make("issue-123");

    expect(runId(projectId, issueId)).toBe(runId(projectId, issueId));
    expect(threadId(projectId, issueId)).toBe(threadId(projectId, issueId));
    expect(isSymphonyThreadId(threadId(projectId, issueId))).toBe(true);
  });
});
