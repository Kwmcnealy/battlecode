import { describe, expect, it } from "vitest";
import type { ServerProvider } from "@t3tools/contracts";
import { getProviderModelTooltip } from "./providerIconUtils";

const providers: ReadonlyArray<ServerProvider> = [
  {
    provider: "codex",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { state: "authenticated" } as ServerProvider["auth"],
    checkedAt: "2026-04-29T00:00:00.000Z",
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
  },
];

describe("getProviderModelTooltip", () => {
  it("returns 'Provider · Display Name' when the model is found", () => {
    expect(getProviderModelTooltip("codex", "gpt-5.4", providers)).toBe("Codex · GPT-5.4");
  });

  it("falls back to the slug when the model is missing from the provider list", () => {
    expect(getProviderModelTooltip("codex", "unknown-slug", providers)).toBe("Codex · unknown-slug");
  });

  it("uses the provider display name even with no providers", () => {
    expect(getProviderModelTooltip("claudeAgent", "claude-sonnet-4-6", [])).toBe(
      "Claude · claude-sonnet-4-6",
    );
  });
});
