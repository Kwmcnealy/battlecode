import { describe, expect, it } from "vitest";

import {
  filterParsedFilesByPaths,
  parseInlineUnifiedDiffFiles,
  selectInlineUnifiedDiffPatch,
} from "./VerboseInlineFileDiffs";

describe("VerboseInlineFileDiffs", () => {
  const patch = [
    "diff --git a/apps/web/src/old-name.ts b/apps/web/src/new-name.ts",
    "similarity index 80%",
    "rename from apps/web/src/old-name.ts",
    "rename to apps/web/src/new-name.ts",
    "index 1111111..2222222 100644",
    "--- a/apps/web/src/old-name.ts",
    "+++ b/apps/web/src/new-name.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
  ].join("\n");

  it("parses live unified diff files", () => {
    const files = parseInlineUnifiedDiffFiles(patch, "live-test");

    expect(files).toHaveLength(1);
    expect(files[0]?.name).toContain("apps/web/src/new-name.ts");
  });

  it("prefers checkpoint patches when both checkpoint and live patches exist", () => {
    const selection = selectInlineUnifiedDiffPatch({
      checkpointPatch: "diff --git a/checkpoint.ts b/checkpoint.ts\n+checkpoint\n",
      livePatch: "diff --git a/live.ts b/live.ts\n+live\n",
    });

    expect(selection.source).toBe("checkpoint");
    expect(selection.patch).toContain("checkpoint.ts");
  });

  it("falls back to live patches when checkpoint patches are unavailable", () => {
    const selection = selectInlineUnifiedDiffPatch({
      checkpointPatch: null,
      livePatch: "diff --git a/live.ts b/live.ts\n+live\n",
    });

    expect(selection.source).toBe("live");
    expect(selection.patch).toContain("live.ts");
  });

  it("filters parsed files by workspace-relative and absolute paths", () => {
    const files = parseInlineUnifiedDiffFiles(patch, "filter-test");

    expect(
      filterParsedFilesByPaths(files, ["apps/web/src/new-name.ts"], "/Users/caladyne/battlecode"),
    ).toHaveLength(1);
    expect(
      filterParsedFilesByPaths(
        files,
        ["/Users/caladyne/battlecode/apps/web/src/new-name.ts"],
        "/Users/caladyne/battlecode",
      ),
    ).toHaveLength(1);
  });

  it("filters parsed renamed files by previous names", () => {
    const files = parseInlineUnifiedDiffFiles(patch, "rename-test");

    expect(filterParsedFilesByPaths(files, ["apps/web/src/old-name.ts"])).toHaveLength(1);
  });
});
