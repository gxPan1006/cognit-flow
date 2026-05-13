import { describe, expect, it } from "vitest";
import { parse } from "../../src/workflow/loader.js";

describe("workflow loader", () => {
  it("parses front matter and prompt body", () => {
    const content = `---
tracker:
  kind: linear
  project_slug: PROJ
---

You are working on {{ issue.identifier }}.
`;
    const result = parse(content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toEqual({
      tracker: { kind: "linear", project_slug: "PROJ" },
    });
    expect(result.value.prompt).toBe("You are working on {{ issue.identifier }}.");
    expect(result.value.promptTemplate).toBe(result.value.prompt);
  });

  it("returns empty config when no front matter is present", () => {
    const result = parse("# Just markdown\nbody text\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toEqual({});
    expect(result.value.prompt).toBe("# Just markdown\nbody text");
  });

  it("returns empty prompt when only front matter is present", () => {
    const result = parse("---\ntracker:\n  kind: linear\n---\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe("");
  });

  it("rejects non-map front matter", () => {
    const result = parse("---\n- 1\n- 2\n---\nbody\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.value).toBe(undefined as unknown as never);
    expect(result.error.kind).toBe("workflow_front_matter_not_a_map");
  });

  it("flags parse errors as workflow_parse_error", () => {
    const result = parse("---\n: : :\n---\nbody\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("workflow_parse_error");
  });

  it("handles missing closing fence by treating remaining as front matter", () => {
    const result = parse("---\ntracker:\n  kind: linear\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.config).toEqual({ tracker: { kind: "linear" } });
    expect(result.value.prompt).toBe("");
  });
});
