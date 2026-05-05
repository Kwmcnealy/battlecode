import { describe, expect, it } from "vitest";

import { parsePlanFromOutput, parsePRUrlFromOutput } from "./threadOutputParser.ts";

// ---------------------------------------------------------------------------
// parsePlanFromOutput
// ---------------------------------------------------------------------------

describe("parsePlanFromOutput", () => {
  it("returns items when SYMPHONY_PLAN_BEGIN/END markers are present", () => {
    const text = [
      "Some preamble",
      "SYMPHONY_PLAN_BEGIN",
      "- [ ] First step",
      "- [ ] Second step",
      "SYMPHONY_PLAN_END",
      "Some epilogue",
    ].join("\n");

    expect(parsePlanFromOutput(text)).toEqual(["First step", "Second step"]);
  });

  it("returns null when SYMPHONY_PLAN_BEGIN is missing", () => {
    const text = ["- [ ] First step", "- [ ] Second step", "SYMPHONY_PLAN_END"].join("\n");

    expect(parsePlanFromOutput(text)).toBeNull();
  });

  it("returns null when SYMPHONY_PLAN_END is missing (partial block)", () => {
    const text = ["SYMPHONY_PLAN_BEGIN", "- [ ] First step", "- [ ] Second step"].join("\n");

    expect(parsePlanFromOutput(text)).toBeNull();
  });

  it("returns null when the block contains no checklist items", () => {
    const text = ["SYMPHONY_PLAN_BEGIN", "Some text without items", "SYMPHONY_PLAN_END"].join("\n");

    expect(parsePlanFromOutput(text)).toBeNull();
  });

  it("returns the first plan when multiple SYMPHONY_PLAN_BEGIN/END blocks appear", () => {
    const text = [
      "SYMPHONY_PLAN_BEGIN",
      "- [ ] Step from first plan",
      "SYMPHONY_PLAN_END",
      "SYMPHONY_PLAN_BEGIN",
      "- [ ] Step from second plan",
      "SYMPHONY_PLAN_END",
    ].join("\n");

    expect(parsePlanFromOutput(text)).toEqual(["Step from first plan"]);
  });

  it("accepts completed items with - [x] checkbox form", () => {
    const text = [
      "SYMPHONY_PLAN_BEGIN",
      "- [x] Already done",
      "- [ ] Still pending",
      "SYMPHONY_PLAN_END",
    ].join("\n");

    expect(parsePlanFromOutput(text)).toEqual(["Already done", "Still pending"]);
  });

  it("strips leading/trailing whitespace from item text", () => {
    const text = ["SYMPHONY_PLAN_BEGIN", "  - [ ]   Trimmed item   ", "SYMPHONY_PLAN_END"].join(
      "\n",
    );

    expect(parsePlanFromOutput(text)).toEqual(["Trimmed item"]);
  });

  it("ignores non-checklist lines inside the plan block", () => {
    const text = [
      "SYMPHONY_PLAN_BEGIN",
      "Some description text",
      "- [ ] Real step",
      "More description",
      "- [x] Another real step",
      "SYMPHONY_PLAN_END",
    ].join("\n");

    expect(parsePlanFromOutput(text)).toEqual(["Real step", "Another real step"]);
  });

  it("handles content nested inside the plan block markers on same line", () => {
    // The markers appear alone on their own lines in the prompt template,
    // so anything after the marker name on the same line is inside the block.
    const text = [
      "SYMPHONY_PLAN_BEGIN anything extra here is ignored",
      "- [ ] Only step",
      "SYMPHONY_PLAN_END",
    ].join("\n");

    // indexOf finds SYMPHONY_PLAN_BEGIN, slices from after that, so the step is still found
    expect(parsePlanFromOutput(text)).toEqual(["Only step"]);
  });

  it("returns null for an empty string", () => {
    expect(parsePlanFromOutput("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parsePRUrlFromOutput
// ---------------------------------------------------------------------------

describe("parsePRUrlFromOutput", () => {
  it("returns the GitHub URL from a SYMPHONY_PR_URL line", () => {
    const text = [
      "Implementation complete.",
      "SYMPHONY_PR_URL: https://github.com/org/repo/pull/42",
    ].join("\n");

    expect(parsePRUrlFromOutput(text)).toBe("https://github.com/org/repo/pull/42");
  });

  it("returns null when no SYMPHONY_PR_URL line is present", () => {
    const text = "Implementation complete. No PR line here.";

    expect(parsePRUrlFromOutput(text)).toBeNull();
  });

  it("returns the first GitHub URL when multiple SYMPHONY_PR_URL lines appear", () => {
    const text = [
      "SYMPHONY_PR_URL: https://github.com/org/repo/pull/1",
      "SYMPHONY_PR_URL: https://github.com/org/repo/pull/2",
    ].join("\n");

    expect(parsePRUrlFromOutput(text)).toBe("https://github.com/org/repo/pull/1");
  });

  it("rejects non-GitHub URLs (returns null)", () => {
    const text = "SYMPHONY_PR_URL: https://gitlab.com/org/repo/merge_requests/5";

    expect(parsePRUrlFromOutput(text)).toBeNull();
  });

  it("trims whitespace around the URL", () => {
    const text = "SYMPHONY_PR_URL:    https://github.com/org/repo/pull/99   ";

    expect(parsePRUrlFromOutput(text)).toBe("https://github.com/org/repo/pull/99");
  });

  it("returns null when the SYMPHONY_PR_URL line has no URL", () => {
    const text = "SYMPHONY_PR_URL:   ";

    expect(parsePRUrlFromOutput(text)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parsePRUrlFromOutput("")).toBeNull();
  });

  it("ignores SYMPHONY_PR_URL that is not on its own line (embedded mid-line)", () => {
    // The implementation splits on newlines and checks each line; a URL
    // embedded mid-sentence on the same line as other text will still be
    // detected because trimmed.startsWith(PR_URL_PREFIX) checks the trimmed
    // line — this test verifies the actual behavior.
    const text = "Some text SYMPHONY_PR_URL: https://github.com/org/repo/pull/5 more text";

    // The trimmed line does NOT start with SYMPHONY_PR_URL: so it is skipped.
    expect(parsePRUrlFromOutput(text)).toBeNull();
  });
});
