import { Client } from "@modelcontextprotocol/client";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";

export type McpClientConnectOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  clientName?: string;
  clientVersion?: string;
};

export type DiscoveredTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type ToolCallResult = {
  isError: boolean;
  content: unknown[];
  structuredContent?: unknown;
};

export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpClientError";
  }
}

export class McpClientSession {
  private closed = false;

  private constructor(private readonly client: Client) {}

  static async connect(
    options: McpClientConnectOptions,
  ): Promise<McpClientSession> {
    if (typeof options.command !== "string" || options.command.trim() === "") {
      throw new McpClientError("MCP server command must be a non-empty string.");
    }

    const transport = new StdioClientTransport({
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      env: {
        ...getDefaultEnvironment(),
        ...(options.env ?? {}),
      },
      stderr: "pipe",
    });

    const client = new Client({
      name: options.clientName ?? "codepilot-agent",
      version: options.clientVersion ?? "0.0.0",
    });

    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }

    return new McpClientSession(client);
  }

  getServerVersion(): { name?: string; version?: string } | undefined {
    this.assertOpen();
    return this.client.getServerVersion() ?? undefined;
  }

  async listTools(): Promise<DiscoveredTool[]> {
    this.assertOpen();
    const { tools } = await this.client.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolCallResult> {
    this.assertOpen();

    if (typeof name !== "string" || name.trim() === "") {
      throw new McpClientError("Tool name must be a non-empty string.");
    }

    const result = await this.client.callTool({
      name,
      arguments: args,
    });

    return {
      isError: Boolean(result.isError),
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: result.structuredContent,
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.client.close();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new McpClientError("MCP client session is closed.");
    }
  }
}
