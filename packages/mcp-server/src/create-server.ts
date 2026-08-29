import { McpServer } from "@modelcontextprotocol/server";

export const SERVER_NAME = "codepilot-mcp-server";
export const SERVER_VERSION = "0.0.0";

export function createServer(): McpServer {
  return new McpServer(
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
}
