import path from "node:path";

import {
  DEFAULT_SYMPHONY_REVIEW_PROMPT,
  DEFAULT_SYMPHONY_SIMPLIFICATION_PROMPT,
  SymphonyWorkflowConfig,
  type SymphonyWorkflowConfig as WorkflowConfig,
} from "@t3tools/contracts";
import { Schema } from "effect";
import { parse as parseYaml } from "yaml";

export interface ParsedSymphonyWorkflow {
  readonly config: WorkflowConfig;
  readonly promptTemplate: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function normalizeWorkflowKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeWorkflowKeys(item));
  }
  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [toCamelKey(key), normalizeWorkflowKeys(nested)]),
  );
}

function parseFrontMatter(markdown: string): {
  readonly configSource: string;
  readonly body: string;
} {
  const normalized = markdown.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return {
      configSource: "",
      body: normalized,
    };
  }

  const endMarkerIndex = normalized.indexOf("\n---", 4);
  if (endMarkerIndex === -1) {
    throw new Error("WORKFLOW.md front matter is missing a closing --- marker.");
  }

  const afterMarkerIndex = normalized.indexOf("\n", endMarkerIndex + 4);
  return {
    configSource: normalized.slice(4, endMarkerIndex),
    body: afterMarkerIndex === -1 ? "" : normalized.slice(afterMarkerIndex + 1),
  };
}

function assertNoLegacyProjectSlug(raw: Record<string, unknown>): void {
  const tracker = raw["tracker"];
  if (isRecord(tracker) && "project_slug" in tracker && !("project_slug_id" in tracker)) {
    throw new Error(
      "WORKFLOW.md uses the deprecated `project_slug` key. " +
        "Rename it to `project_slug_id`. " +
        "Run the setup wizard (`Symphony → Settings → Reconfigure`) to update your configuration.",
    );
  }
}

export function parseWorkflowMarkdown(markdown: string): ParsedSymphonyWorkflow {
  const { configSource, body } = parseFrontMatter(markdown);
  const parsedConfig = configSource.trim().length > 0 ? parseYaml(configSource) : {};
  const promptTemplate = body.trim();

  if (promptTemplate.length === 0) {
    throw new Error("WORKFLOW.md must include a prompt body after front matter.");
  }

  const rawRecord = isRecord(parsedConfig) ? parsedConfig : {};
  assertNoLegacyProjectSlug(rawRecord);

  const config = Schema.decodeUnknownSync(SymphonyWorkflowConfig)(
    normalizeWorkflowKeys(rawRecord),
  );

  return {
    config,
    promptTemplate,
  };
}

export function resolveWorkflowPath(projectRoot: string, requestedPath: string): string {
  const root = path.resolve(projectRoot);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(root, requestedPath);
  const relative = path.relative(root, candidate);

  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return candidate;
  }

  throw new Error(
    `Workflow file must stay inside the project root. root=${root} candidate=${candidate}`,
  );
}

export function defaultWorkflowPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), "WORKFLOW.md");
}

export const STARTER_WORKFLOW_TEMPLATE = `---
tracker:
  kind: linear
  project_slug_id: ""
  intake_states:
    - To Do
    - Todo
  active_states:
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Canceled
    - Cancelled
  review_states:
    - In Review
    - Review
  done_states:
    - Done
    - Closed
  canceled_states:
    - Canceled
    - Cancelled
  transition_states:
    started: In Progress
    review: In Review
    done: Done
    canceled: Canceled
pull_request:
  base_branch: development
quality:
  max_review_fix_loops: 1
  simplification_prompt: "${DEFAULT_SYMPHONY_SIMPLIFICATION_PROMPT}"
  review_prompt: "${DEFAULT_SYMPHONY_REVIEW_PROMPT}"
polling:
  scheduler_interval_ms: 30000
  reconciler_interval_ms: 60000
  jitter: 0.1
concurrency:
  max: 3
stall:
  timeout_ms: 300000
agent:
  max_concurrent_agents: 3
  max_turns: 20
codex:
  runtime_mode: full-access
---

You are working on Linear ticket {{ issue.identifier }}.

Issue title: {{ issue.title }}
Issue state: {{ issue.state }}
Issue URL: {{ issue.url }}

Symphony owns Linear status updates and the issue progress comment for this run.

Work only inside the provided issue workspace. Keep changes focused, validate them, commit them,
push the branch, and open or update a pull request when the work is ready for review.
`;
