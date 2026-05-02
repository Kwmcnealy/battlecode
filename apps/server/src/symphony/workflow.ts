import path from "node:path";

import {
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

export function parseWorkflowMarkdown(markdown: string): ParsedSymphonyWorkflow {
  const { configSource, body } = parseFrontMatter(markdown);
  const parsedConfig = configSource.trim().length > 0 ? parseYaml(configSource) : {};
  const promptTemplate = body.trim();

  if (promptTemplate.length === 0) {
    throw new Error("WORKFLOW.md must include a prompt body after front matter.");
  }

  const config = Schema.decodeUnknownSync(SymphonyWorkflowConfig)(
    normalizeWorkflowKeys(isRecord(parsedConfig) ? parsedConfig : {}),
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
  project_slug: ""
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Closed
    - Canceled
  review_states:
    - In Review
  done_states:
    - Done
    - Closed
  canceled_states:
    - Canceled
  transition_states:
    started: In Progress
    review: In Review
    done: Done
    canceled: Canceled
polling:
  interval_ms: 30000
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

Work only inside the provided issue workspace. Keep changes focused, validate them, commit them,
push the branch, and open or update a pull request when the work is ready for review.
`;
