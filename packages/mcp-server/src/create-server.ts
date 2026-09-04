import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { PathSecurityError } from "./security/path-guard.js";
import { registerGetDiffTool } from "./tools/get-diff.js";
import { registerReadFileTool } from "./tools/read-file.js";
import {
  registerRunTestsTool,
  resolveTrustedTestCommand,
} from "./tools/run-tests.js";
import { registerSearchCodeTool } from "./tools/search-code.js";

export const SERVER_NAME = "codepilot-mcp-server";
export const SERVER_VERSION = "0.0.0";

export type CreateServerOptions = {
  repositoryRoot?: string;
  testCommand?: string;
  testTimeoutMs?: number;
};

export function resolveRepositoryRoot(explicitRoot?: string): string {
  const configured = explicitRoot ?? process.env.REPO_ROOT;
  if (typeof configured !== "string" || configured.trim() === "") {
    throw new PathSecurityError(
      "Repository root is not configured. Set REPO_ROOT or pass repositoryRoot.",
    );
  }

  const resolved = path.resolve(configured);
  let root: string;
  try {
    root = fs.realpathSync(resolved);
  } catch {
    throw new PathSecurityError(
      `Repository root does not exist or is inaccessible: ${resolved}`,
    );
  }

  if (!fs.statSync(root).isDirectory()) {
    throw new PathSecurityError(`Repository root must be a directory: ${root}`);
  }

  return root;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const repositoryRoot = resolveRepositoryRoot(options.repositoryRoot);
  const testCommand = resolveTrustedTestCommand(options.testCommand);
  const server = new McpServer(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  registerSearchCodeTool(server, repositoryRoot);
  registerReadFileTool(server, repositoryRoot);
  registerRunTestsTool(server, {
    repositoryRoot,
    command: testCommand,
    timeoutMs: options.testTimeoutMs,
  });
  registerGetDiffTool(server, { repositoryRoot });
  return server;
}
