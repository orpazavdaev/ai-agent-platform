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
import {
  SERVER_NAME,
  SERVER_VERSION,
  createServer,
} from "../src/create-server.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const mainEntry = path.join(packageRoot, "dist", "main.js");

describe("createServer", () => {
  let repoRoot: string;

  afterEach(() => {
    if (repoRoot) {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("builds an MCP server with the CodePilot identity and search_code", () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-server-"));
    fs.writeFileSync(path.join(repoRoot, "README.md"), "# fixture\n");

    const server = createServer({ repositoryRoot: repoRoot });
    expect(server).toBeDefined();
    expect(SERVER_NAME).toBe("codepilot-mcp-server");
    expect(SERVER_VERSION).toBe("0.0.0");
  });
});

describe("stdio MCP server process", () => {
  let repoRoot: string;

  afterEach(() => {
    if (repoRoot) {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("starts over stdio and registers search_code", async () => {
    repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codepilot-stdio-"));
    fs.writeFileSync(
      path.join(repoRoot, "note.txt"),
      "hello searchable token\n",
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mainEntry],
      cwd: packageRoot,
      env: {
        ...getDefaultEnvironment(),
        REPO_ROOT: repoRoot,
      },
      stderr: "pipe",
    });

    const stderrChunks: Buffer[] = [];
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(
        typeof chunk === "string" ? Buffer.from(chunk) : chunk,
      );
    });

    const client = new Client({
      name: "codepilot-mcp-smoke",
      version: "0.0.0",
    });

    await client.connect(transport);

    expect(client.getServerVersion()).toMatchObject({
      name: SERVER_NAME,
      version: SERVER_VERSION,
    });

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["search_code"]);

    const result = await client.callTool({
      name: "search_code",
      arguments: { query: "searchable token" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      truncated: false,
      matches: [
        {
          path: "note.txt",
          line: 1,
          snippet: "hello searchable token",
        },
      ],
    });

    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    expect(stderr).toContain(`${SERVER_NAME} v${SERVER_VERSION}`);
    expect(stderr).toContain("starting on stdio");
    expect(stderr).toContain(repoRoot);

    await client.close();
  });
});
