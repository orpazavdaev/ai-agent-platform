export const mcpServerPackageName = "@codepilot/mcp-server";
export {
  SERVER_NAME,
  SERVER_VERSION,
  createServer,
  resolveRepositoryRoot,
} from "./create-server.js";
export type { CreateServerOptions } from "./create-server.js";
export { PathSecurityError, resolveRepoPath } from "./security/index.js";
