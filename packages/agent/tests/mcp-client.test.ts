import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpClientError, McpClientSession } from "../src/mcp-client.js";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const mcpServerEntry = path.join(
  workspaceRoot,
  "packages",
  "mcp-server",
  "dist",
  "main.js",
);

describe("McpClientSession", () => {
  let repoRoot: string;
  let session: McpClientSession | undefined;

  beforeEach(() => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-agent-mcp-"));
    fs.mkdirSync(path.join(repoRoot, "src"));
    fs.writeFileSync(
      path.join(repoRoot, "src", "note.ts"),
      "export const marker = 'agent-mcp-token';\n",
    );
  });

  afterEach(async () => {
    if (session) {
      await session.close();
      session = undefined;
    }
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  async function connect(): Promise<McpClientSession> {
    session = await McpClientSession.connect({
      command: process.execPath,
      args: [mcpServerEntry],
      cwd: path.dirname(mcpServerEntry),
      env: {
        REPO_ROOT: repoRoot,
        TEST_COMMAND:
          process.platform === "win32" ? "npm.cmd test" : "npm test",
      },
    });
    return session;
  }

  it("connects to the local MCP server over stdio", async () => {
    const client = await connect();
    const version = client.getServerVersion();

    expect(version).toMatchObject({
      name: "codepilot-mcp-server",
      version: "0.0.0",
    });
  });

  it("discovers tools dynamically without hardcoding names", async () => {
    const client = await connect();
    const tools = await client.listTools();

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toEqual(expect.any(String));
      expect(tool.name.length).toBeGreaterThan(0);
    }

    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("calls a discovered tool", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const search = tools.find((tool) => tool.name === "search_code");
    expect(search).toBeDefined();

    const result = await client.callTool(search!.name, {
      query: "agent-mcp-token",
    });

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      truncated: false,
      matches: [
        expect.objectContaining({
          path: "src/note.ts",
        }),
      ],
    });
  });

  it("returns tool failures from the server", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const read = tools.find((tool) => tool.name === "read_file");
    expect(read).toBeDefined();

    const result = await client.callTool(read!.name, {
      path: "missing-file.ts",
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "not_found",
      },
    });
  });

  it("closes cleanly and rejects further use", async () => {
    const client = await connect();
    await client.close();
    session = undefined;

    await expect(client.listTools()).rejects.toThrow(McpClientError);
    await expect(client.callTool("search_code", { query: "x" })).rejects.toThrow(
      /closed/,
    );

    await expect(client.close()).resolves.toBeUndefined();
  });
});
