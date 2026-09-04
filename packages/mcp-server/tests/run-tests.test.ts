import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseTrustedTestCommand,
  runTests,
  RunTestsError,
} from "../src/tools/run-tests.js";

describe("parseTrustedTestCommand", () => {
  it("parses a simple trusted argv", () => {
    expect(parseTrustedTestCommand("npm test")).toEqual(["npm", "test"]);
  });

  it("rejects empty commands", () => {
    expect(() => parseTrustedTestCommand("")).toThrow(RunTestsError);
    expect(() => parseTrustedTestCommand("   ")).toThrow(/non-empty string/);
  });

  it("rejects shell metacharacters", () => {
    expect(() => parseTrustedTestCommand("npm test; rm -rf /")).toThrow(
      /shell metacharacters/,
    );
    expect(() => parseTrustedTestCommand("npm test && id")).toThrow(
      RunTestsError,
    );
    expect(() => parseTrustedTestCommand("echo $(whoami)")).toThrow(
      RunTestsError,
    );
  });
});

describe("runTests", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-run-tests-"));
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  it("rejects invalid configuration", async () => {
    await expect(
      runTests({ repositoryRoot: repoRoot, command: [] }),
    ).rejects.toMatchObject({ code: "invalid_config" });

    await expect(
      runTests({
        repositoryRoot: repoRoot,
        command: ["node", "ok.js"],
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });
  });

  it("captures a successful trusted command", async () => {
    const script = path.join(repoRoot, "ok.js");
    fs.writeFileSync(script, "console.log('pass-marker'); process.exit(0);\n");

    const result = await runTests({
      repositoryRoot: repoRoot,
      command: [process.execPath, script],
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("pass-marker");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.command).toEqual([process.execPath, script]);
  });

  it("returns a clear failure result for non-zero exit", async () => {
    const script = path.join(repoRoot, "fail.js");
    fs.writeFileSync(
      script,
      "console.error('fail-marker'); process.exit(2);\n",
    );

    const result = await runTests({
      repositoryRoot: repoRoot,
      command: [process.execPath, script],
      timeoutMs: 10_000,
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toContain("fail-marker");
  });

  it("times out hung commands", async () => {
    const script = path.join(repoRoot, "hang.js");
    fs.writeFileSync(script, "setInterval(() => {}, 1000);\n");

    const result = await runTests({
      repositoryRoot: repoRoot,
      command: [process.execPath, script],
      timeoutMs: 200,
    });

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(200);
  });

  it("bounds captured output", async () => {
    const script = path.join(repoRoot, "loud.js");
    fs.writeFileSync(
      script,
      'process.stdout.write("x".repeat(5000)); process.exit(0);\n',
    );

    const result = await runTests({
      repositoryRoot: repoRoot,
      command: [process.execPath, script],
      timeoutMs: 10_000,
      maxOutputBytes: 64,
    });

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(64);
  });

  it("surfaces spawn failures clearly", async () => {
    await expect(
      runTests({
        repositoryRoot: repoRoot,
        command: [
          path.join(repoRoot, "definitely-missing-binary-xyz"),
          "--help",
        ],
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "spawn_failed" });
  });
});
