import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RESULTS,
  SearchCodeError,
  searchCode,
} from "../src/tools/search-code.js";

describe("searchCode", () => {
  let repoRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-search-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-search-out-"));
    fs.mkdirSync(path.join(repoRoot, "src"));
    fs.writeFileSync(
      path.join(repoRoot, "src", "pricing.ts"),
      "export function price() {\n  return computeTotal();\n}\n",
    );
    fs.writeFileSync(
      path.join(repoRoot, "README.md"),
      "# sample\n\ncomputeTotal lives in src.\n",
    );
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("returns matching file paths, line numbers, and snippets", () => {
    const result = searchCode(repoRoot, "computeTotal");

    expect(result.truncated).toBe(false);
    expect(result.matches).toEqual([
      {
        path: "README.md",
        line: 3,
        snippet: "computeTotal lives in src.",
      },
      {
        path: "src/pricing.ts",
        line: 2,
        snippet: "return computeTotal();",
      },
    ]);
  });

  it("returns no matches when the query is absent", () => {
    const result = searchCode(repoRoot, "definitely-not-present-xyz");

    expect(result).toEqual({
      matches: [],
      truncated: false,
    });
  });

  it("rejects invalid queries", () => {
    expect(() => searchCode(repoRoot, "")).toThrow(SearchCodeError);
    expect(() => searchCode(repoRoot, "   ")).toThrow(/non-empty string/);
    expect(() => searchCode(repoRoot, "a".repeat(501))).toThrow(
      /at most 500 characters/,
    );
  });

  it("does not follow symlink escapes outside the repository root", () => {
    const secret = path.join(outsideDir, "secret.ts");
    fs.writeFileSync(secret, "export const LEAKED_SECRET = true;\n");
    const linkPath = path.join(repoRoot, "leak.ts");

    try {
      fs.symlinkSync(secret, linkPath);
    } catch {
      return;
    }

    const result = searchCode(repoRoot, "LEAKED_SECRET");
    expect(result.matches).toEqual([]);
  });

  it("ignores common generated directories", () => {
    for (const ignored of ["node_modules", "dist", ".git", "coverage"]) {
      const dir = path.join(repoRoot, ignored);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "generated.ts"),
        `export const IGNORED_${ignored.replace(".", "_")} = "find-me-ignored";\n`,
      );
    }

    fs.writeFileSync(
      path.join(repoRoot, "src", "visible.ts"),
      'export const visible = "find-me-ignored";\n',
    );

    const result = searchCode(repoRoot, "find-me-ignored");

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      path: "src/visible.ts",
      line: 1,
    });
  });

  it("limits the number of returned matches", () => {
    for (let index = 0; index < DEFAULT_MAX_RESULTS + 5; index += 1) {
      fs.writeFileSync(
        path.join(repoRoot, "src", `hit-${index}.ts`),
        `export const value = "limit-marker-${index}";\n`,
      );
    }

    const result = searchCode(repoRoot, "limit-marker");

    expect(result.matches).toHaveLength(DEFAULT_MAX_RESULTS);
    expect(result.truncated).toBe(true);

    const custom = searchCode(repoRoot, "limit-marker", { maxResults: 3 });
    expect(custom.matches).toHaveLength(3);
    expect(custom.truncated).toBe(true);
  });
});
