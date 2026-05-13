import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("cli", () => {
  const originalExit = process.exit;
  let tmpDir: string;
  let exitCalls: number[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-cli-"));
    exitCalls = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error(`__exit_${code ?? 0}__`);
    }) as never;
  });

  afterEach(() => {
    process.exit = originalExit;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("rejects invocations without the guardrails ack flag", async () => {
    const { main } = await import("../src/cli.js");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await expect(main([])).rejects.toThrow(/__exit_1__/);
    expect(exitCalls).toEqual([1]);
    const message = stderr.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toContain("This Cognit Flow implementation");
  });

  it("rejects when workflow file does not exist", async () => {
    const { main } = await import("../src/cli.js");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const missing = path.join(tmpDir, "does-not-exist.md");
    await expect(
      main([
        "--i-understand-that-this-will-be-running-without-the-usual-guardrails",
        missing,
      ]),
    ).rejects.toThrow(/__exit_1__/);
    const message = stderr.mock.calls.map((c) => String(c[0])).join("\n");
    expect(message).toContain("Workflow file not found");
  });
});
