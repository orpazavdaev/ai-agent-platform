import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  SERVER_NAME,
  SERVER_VERSION,
  createServer,
} from "./create-server.js";

console.error(
  `${SERVER_NAME} v${SERVER_VERSION} starting on stdio (no tools registered yet)`,
);

const handle = serveStdio(createServer, {
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
