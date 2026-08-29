import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PathSecurityError, resolveRepoPath } from "../src/security/path-guard.js";

describe("resolveRepoPath", () => {
  let repoRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-repo-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-outside-"));
    fs.mkdirSync(path.join(repoRoot, "src"));
    fs.writeFileSync(path.join(repoRoot, "src", "main.ts"), "export {};\n");
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# sample\n");
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("resolves a relative path inside the repository root", () => {
    const resolved = resolveRepoPath(repoRoot, "src/main.ts");
    expect(resolved).toBe(fs.realpathSync(path.join(repoRoot, "src", "main.ts")));
  });

  it("normalizes . and .. segments that stay inside the root", () => {
    const resolved = resolveRepoPath(repoRoot, "./src/../src/main.ts");
    expect(resolved).toBe(fs.realpathSync(path.join(repoRoot, "src", "main.ts")));
  });

  it("resolves . to the repository root", () => {
    const resolved = resolveRepoPath(repoRoot, ".");
    expect(resolved).toBe(fs.realpathSync(repoRoot));
  });

  it("allows an absolute path that remains inside the repository root", () => {
    const absoluteInside = path.join(repoRoot, "README.md");
    const resolved = resolveRepoPath(repoRoot, absoluteInside);
    expect(resolved).toBe(fs.realpathSync(absoluteInside));
  });

  it("rejects path traversal that escapes the repository root", () => {
    expect(() => resolveRepoPath(repoRoot, "../secret.txt")).toThrow(
      PathSecurityError,
    );
    expect(() => resolveRepoPath(repoRoot, "../secret.txt")).toThrow(
      /outside the repository root/,
    );
  });

  it("rejects nested traversal escapes", () => {
    expect(() =>
      resolveRepoPath(repoRoot, "src/../../outside.txt"),
    ).toThrow(PathSecurityError);
  });

  it("rejects an absolute path outside the repository root", () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "nope\n");

    expect(() => resolveRepoPath(repoRoot, outsideFile)).toThrow(
      PathSecurityError,
    );
  });

  it("rejects empty input paths", () => {
    expect(() => resolveRepoPath(repoRoot, "")).toThrow(/non-empty string/);
  });

  it("rejects a missing repository root", () => {
    expect(() =>
      resolveRepoPath(path.join(repoRoot, "missing-root"), "src/main.ts"),
    ).toThrow(/does not exist or is inaccessible/);
  });

  it("rejects a repository root that is a file", () => {
    const fileRoot = path.join(outsideDir, "not-a-dir.txt");
    fs.writeFileSync(fileRoot, "file\n");

    expect(() => resolveRepoPath(fileRoot, "src/main.ts")).toThrow(
      /must be a directory/,
    );
  });

  it("resolves a not-yet-created path when ancestors stay inside the root", () => {
    const resolved = resolveRepoPath(repoRoot, "src/new-file.ts");
    expect(resolved).toBe(path.join(fs.realpathSync(repoRoot), "src", "new-file.ts"));
  });

  it("rejects a symlink that points outside the repository root", () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "nope\n");
    const linkPath = path.join(repoRoot, "leak.txt");

    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch {
      return;
    }

    expect(() => resolveRepoPath(repoRoot, "leak.txt")).toThrow(
      PathSecurityError,
    );
  });
});
