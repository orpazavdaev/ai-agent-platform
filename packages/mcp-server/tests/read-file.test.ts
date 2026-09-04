import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_READ_FILE_BYTES,
  ReadFileError,
  readRepoFile,
} from "../src/tools/read-file.js";

describe("readRepoFile", () => {
  let repoRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-read-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-read-out-"));
    fs.mkdirSync(path.join(repoRoot, "src"));
    fs.writeFileSync(
      path.join(repoRoot, "src", "main.ts"),
      "export const value = 42;\n",
    );
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("reads a file inside the repository", () => {
    const result = readRepoFile(repoRoot, "src/main.ts");

    expect(result).toEqual({
      path: "src/main.ts",
      content: "export const value = 42;\n",
      sizeBytes: Buffer.byteLength("export const value = 42;\n", "utf8"),
    });
  });

  it("rejects a missing file", () => {
    expect(() => readRepoFile(repoRoot, "src/missing.ts")).toThrow(ReadFileError);
    try {
      readRepoFile(repoRoot, "src/missing.ts");
    } catch (error) {
      expect(error).toMatchObject({
        code: "not_found",
        message: expect.stringContaining("File not found"),
      });
    }
  });

  it("rejects a directory path", () => {
    expect(() => readRepoFile(repoRoot, "src")).toThrow(ReadFileError);
    try {
      readRepoFile(repoRoot, "src");
    } catch (error) {
      expect(error).toMatchObject({
        code: "is_directory",
      });
    }
  });

  it("rejects ../ traversal outside the repository", () => {
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "nope\n");

    expect(() => readRepoFile(repoRoot, "../secret.txt")).toThrow(ReadFileError);
    try {
      readRepoFile(repoRoot, "../secret.txt");
    } catch (error) {
      expect(error).toMatchObject({
        code: "outside_repository",
      });
    }
  });

  it("rejects an absolute path outside the repository", () => {
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "nope\n");

    expect(() => readRepoFile(repoRoot, outsideFile)).toThrow(ReadFileError);
    try {
      readRepoFile(repoRoot, outsideFile);
    } catch (error) {
      expect(error).toMatchObject({
        code: "outside_repository",
      });
    }
  });

  it("rejects an oversized file", () => {
    const oversizedPath = path.join(repoRoot, "big.txt");
    fs.writeFileSync(oversizedPath, Buffer.alloc(MAX_READ_FILE_BYTES + 1, 0x61));

    expect(() => readRepoFile(repoRoot, "big.txt")).toThrow(ReadFileError);
    try {
      readRepoFile(repoRoot, "big.txt");
    } catch (error) {
      expect(error).toMatchObject({
        code: "too_large",
        message: expect.stringContaining(String(MAX_READ_FILE_BYTES)),
      });
    }
  });
});
