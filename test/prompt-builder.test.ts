import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "../src/config/index.js";
import { makeIssue } from "../src/linear/issue.js";
import { buildPrompt } from "../src/prompt-builder.js";
import { workflowStore } from "../src/workflow/store.js";

describe("prompt builder", () => {
  beforeEach(() => {
    workflowStore.reset();
    setLanguage(null);
  });

  afterEach(() => {
    workflowStore.reset();
    setLanguage(null);
  });

  it("renders issue identifier into a basic template", async () => {
    workflowStore.set({
      config: {},
      prompt: "Ticket: {{ issue.identifier }}, title: {{ issue.title }}",
      promptTemplate: "Ticket: {{ issue.identifier }}, title: {{ issue.title }}",
    });

    const issue = makeIssue({
      id: "id-1",
      identifier: "ABC-1",
      title: "Hello",
      state: "Todo",
    });

    const rendered = await buildPrompt(issue);
    expect(rendered).toBe("Ticket: ABC-1, title: Hello");
  });

  it("includes attempt context when provided", async () => {
    workflowStore.set({
      config: {},
      prompt: "{% if attempt %}retry-{{ attempt }}{% else %}first{% endif %}",
      promptTemplate: "{% if attempt %}retry-{{ attempt }}{% else %}first{% endif %}",
    });
    const issue = makeIssue({ id: "x", identifier: "X-1", title: "T", state: "Todo" });

    expect(await buildPrompt(issue)).toBe("first");
    expect(await buildPrompt(issue, { attempt: 2 })).toBe("retry-2");
  });

  it("exposes language for templates", async () => {
    setLanguage("中文");
    workflowStore.set({
      config: {},
      prompt: "{% if language %}lang={{ language }}{% endif %}",
      promptTemplate: "{% if language %}lang={{ language }}{% endif %}",
    });
    const issue = makeIssue({ id: "x", identifier: "X-1", title: "T", state: "Todo" });

    expect(await buildPrompt(issue)).toBe("lang=中文");
  });

  it("fails the render when the template references unknown variables", async () => {
    workflowStore.set({
      config: {},
      prompt: "Hello {{ unknown_var }}",
      promptTemplate: "Hello {{ unknown_var }}",
    });
    const issue = makeIssue({ id: "x", identifier: "X-1", title: "T", state: "Todo" });

    await expect(buildPrompt(issue)).rejects.toThrow();
  });
});
