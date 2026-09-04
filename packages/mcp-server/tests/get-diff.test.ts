import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FIXED_GIT_DIFF_ARGV,
  getDiff,
  GetDiffError,
} from "../src/tools/get-diff.js";

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
    );
  }
}

describe("getDiff", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-get-diff-"));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("rejects invalid configuration", async () => {
    await expect(
      getDiff({ repositoryRoot: "", timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("handles a non-git directory", async () => {
    fs.writeFileSync(path.join(repoRoot, "readme.txt"), "hello\n");

    await expect(getDiff({ repositoryRoot: repoRoot })).rejects.toMatchObject({
      code: "not_a_git_repository",
    });
  });

  it("returns an empty diff when there are no changes", async () => {
    runGit(repoRoot, ["init"]);
    runGit(repoRoot, ["config", "user.email", "test@example.com"]);
    runGit(repoRoot, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "one\n");
    runGit(repoRoot, ["add", "file.txt"]);
    runGit(repoRoot, ["commit", "-m", "initial"]);

    const result = await getDiff({ repositoryRoot: repoRoot });

    expect(result.ok).toBe(true);
    expect(result.empty).toBe(true);
    expect(result.diff.trim()).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.command).toEqual([...FIXED_GIT_DIFF_ARGV]);
  });

  it("returns the current diff when files change", async () => {
    runGit(repoRoot, ["init"]);
    runGit(repoRoot, ["config", "user.email", "test@example.com"]);
    runGit(repoRoot, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "one\n");
    runGit(repoRoot, ["add", "file.txt"]);
    runGit(repoRoot, ["commit", "-m", "initial"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "two\n");

    const result = await getDiff({ repositoryRoot: repoRoot });

    expect(result.ok).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.diff).toContain("file.txt");
    expect(result.diff).toContain("-one");
    expect(result.diff).toContain("+two");
  });

  it("limits oversized diff output", async () => {
    runGit(repoRoot, ["init"]);
    runGit(repoRoot, ["config", "user.email", "test@example.com"]);
    runGit(repoRoot, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), "start\n");
    runGit(repoRoot, ["add", "file.txt"]);
    runGit(repoRoot, ["commit", "-m", "initial"]);
    fs.writeFileSync(path.join(repoRoot, "file.txt"), `${"x".repeat(5_000)}\n`);

    const result = await getDiff({
      repositoryRoot: repoRoot,
      maxOutputBytes: 128,
    });

    expect(result.ok).toBe(true);
    expect(result.empty).toBe(false);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.diff, "utf8")).toBeLessThanOrEqual(128);
  });
});
