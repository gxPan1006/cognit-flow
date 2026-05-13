import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../src/path-safety.js";

describe("path-safety canonicalize", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cognition-path-safety-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("returns the same absolute path for an existing directory", () => {
    const result = canonicalize(tmp);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(fs.realpathSync(tmp));
  });

  it("appends non-existent suffix segments without erroring", () => {
    const candidate = path.join(tmp, "does-not-exist", "child.txt");
    const result = canonicalize(candidate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // On macOS /var is a symlink to /private/var; canonicalize resolves the
    // existing prefix (tmp) and appends the non-existent suffix as-is.
    const expected = path.join(fs.realpathSync(tmp), "does-not-exist", "child.txt");
    expect(result.path).toBe(expected);
  });

  it("follows symbolic links", () => {
    const target = path.join(tmp, "real");
    fs.mkdirSync(target);
    const link = path.join(tmp, "alias");
    fs.symlinkSync(target, link);
    const result = canonicalize(link);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(fs.realpathSync(link));
  });
});
