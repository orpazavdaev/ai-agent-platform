import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";
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
  it("builds an MCP server with the CodePilot identity", () => {
    const server = createServer();
    expect(server).toBeDefined();
    expect(SERVER_NAME).toBe("codepilot-mcp-server");
    expect(SERVER_VERSION).toBe("0.0.0");
  });
});

describe("stdio MCP server process", () => {
  it("starts over stdio and completes the initialize handshake", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [mainEntry],
      cwd: packageRoot,
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
    expect(tools).toEqual([]);

    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    expect(stderr).toContain(`${SERVER_NAME} v${SERVER_VERSION}`);
    expect(stderr).toContain("starting on stdio");

    await client.close();
  });
});
