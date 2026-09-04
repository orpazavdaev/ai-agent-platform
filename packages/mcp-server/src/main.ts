import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  SERVER_NAME,
  SERVER_VERSION,
  createServer,
  resolveRepositoryRoot,
} from "./create-server.js";

const repositoryRoot = resolveRepositoryRoot();

console.error(
  `${SERVER_NAME} v${SERVER_VERSION} starting on stdio (repo: ${repositoryRoot})`,
);

const handle = serveStdio(() => createServer({ repositoryRoot }), {
  onerror: (error) => {
    console.error(`${SERVER_NAME} transport error:`, error);
  },
});

const shutdown = () => {
  void handle.close().finally(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
