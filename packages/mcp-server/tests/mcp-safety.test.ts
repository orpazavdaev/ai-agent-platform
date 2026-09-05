import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "vitest";
import { FIXED_GIT_DIFF_ARGV } from "../src/tools/get-diff.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const mainEntry = path.join(packageRoot, "dist", "main.js");

async function connectMcp(env: Record<string, string>): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mainEntry],
    cwd: packageRoot,
    env: {
      ...getDefaultEnvironment(),
      ...env,
    },
    stderr: "ignore",
  });

  const client = new Client({
    name: "codepilot-mcp-safety",
    version: "0.0.0",
  });

  await client.connect(transport);

  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

describe("MCP safety over stdio", () => {
  let repoRoot: string;
  let outsideDir: string;
  let closeClient: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (closeClient) {
      await closeClient();
      closeClient = undefined;
    }
    if (repoRoot) {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
    if (outsideDir) {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid search_code and read_file inputs", async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-mcp-input-"));
    fs.writeFileSync(path.join(repoRoot, "note.txt"), "hello\n");

    const session = await connectMcp({ REPO_ROOT: repoRoot });
    closeClient = session.close;

    const missingQuery = await session.client.callTool({
      name: "search_code",
      arguments: {},
    });
    expect(missingQuery.isError).toBe(true);
    expect(JSON.stringify(missingQuery)).toMatch(/query/i);

    const wrongQueryType = await session.client.callTool({
      name: "search_code",
      arguments: { query: 42 },
    });
    expect(wrongQueryType.isError).toBe(true);
    expect(JSON.stringify(wrongQueryType)).toMatch(/query/i);

    const wrongPathType = await session.client.callTool({
      name: "read_file",
      arguments: { path: 7 },
    });
    expect(wrongPathType.isError).toBe(true);
    expect(JSON.stringify(wrongPathType)).toMatch(/path/i);
  });

  it("rejects path traversal through read_file", async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-mcp-trav-"));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-mcp-out-"));
    fs.writeFileSync(path.join(repoRoot, "inside.txt"), "inside\n");
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret\n");

    const session = await connectMcp({ REPO_ROOT: repoRoot });
    closeClient = session.close;

    const relativeEscape = await session.client.callTool({
      name: "read_file",
      arguments: { path: "../secret.txt" },
    });
    expect(relativeEscape.isError).toBe(true);
    expect(relativeEscape.structuredContent).toMatchObject({
      error: { code: "outside_repository" },
    });

    const absoluteEscape = await session.client.callTool({
      name: "read_file",
      arguments: { path: outsideFile },
    });
    expect(absoluteEscape.isError).toBe(true);
    expect(absoluteEscape.structuredContent).toMatchObject({
      error: { code: "outside_repository" },
    });
  });

  it("ignores model-supplied run_tests command arguments", async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-mcp-cmd-"));
    const script = path.join(repoRoot, "ok.js");
    fs.writeFileSync(
      script,
      "console.log('trusted-ok'); process.exit(0);\n",
    );

    const session = await connectMcp({
      REPO_ROOT: repoRoot,
      TEST_COMMAND: "node ok.js",
    });
    closeClient = session.close;

    const result = await session.client.callTool({
      name: "run_tests",
      arguments: {
        command: "rm -rf /",
        argv: ["powershell", "-Command", "Write-Host pwned"],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      ok: true,
      command: ["node", "ok.js"],
      stdout: expect.stringContaining("trusted-ok"),
    });
  });

  it("keeps get_diff on the fixed git argv even with extra arguments", async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-mcp-diff-"));
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# fixture\n");

    const { execFileSync } = await import("node:child_process");
    execFileSync("git", ["init"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Test"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["add", "README.md"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["commit", "-m", "init"], {
      cwd: repoRoot,
      stdio: "ignore",
    });

    const session = await connectMcp({ REPO_ROOT: repoRoot });
    closeClient = session.close;

    const result = await session.client.callTool({
      name: "get_diff",
      arguments: {
        command: "git push --force",
        argv: ["git", "push", "--force"],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      command: [...FIXED_GIT_DIFF_ARGV],
    });
  });
});
