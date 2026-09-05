import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRunner,
  McpClientSession,
  createLlmProviderFromEnv,
} from "@codepilot/agent";
import { handleCreateRun } from "./routes/create-run.js";
import { createRunsService, type AgentExecutor } from "./runs/service.js";
import { InMemoryRunStore } from "./runs/store.js";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

function resolveMcpServerEntry(): string {
  return (
    process.env.MCP_SERVER_ENTRY?.trim() ||
    path.join(workspaceRoot, "packages", "mcp-server", "dist", "main.js")
  );
}

export function createDefaultAgentExecutor(): AgentExecutor {
  return {
    async run(task: string) {
      const mcp = await McpClientSession.connect({
        command: process.execPath,
        args: [resolveMcpServerEntry()],
        cwd: path.dirname(resolveMcpServerEntry()),
        env: {
          REPO_ROOT:
            process.env.REPO_ROOT?.trim() ||
            path.join(workspaceRoot, "test-repository"),
          TEST_COMMAND:
            process.env.TEST_COMMAND?.trim() ||
            (process.platform === "win32" ? "npm.cmd test" : "npm test"),
        },
      });

      try {
        const runner = new AgentRunner({
          llm: createLlmProviderFromEnv(),
          mcp,
        });
        return await runner.run(task);
      } finally {
        await mcp.close();
      }
    },
  };
}

export type ApiServerOptions = {
  executor?: AgentExecutor;
  store?: InMemoryRunStore;
  createId?: () => string;
};

export function createApiServer(options: ApiServerOptions = {}): http.Server {
  const runs = createRunsService({
    executor: options.executor ?? createDefaultAgentExecutor(),
    store: options.store,
    createId: options.createId,
  });

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "POST" && url.pathname === "/api/runs") {
      void handleCreateRun(req, res, runs).catch(() => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error." }));
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found." }));
  });
}

export function startApiServer(
  options: ApiServerOptions & { port?: number } = {},
): http.Server {
  const port = options.port ?? Number(process.env.API_PORT ?? 3001);
  const server = createApiServer(options);
  server.listen(port, () => {
    console.error(`@codepilot/api listening on http://127.0.0.1:${port}`);
  });
  return server;
}
