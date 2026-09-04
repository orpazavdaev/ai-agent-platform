export const agentPackageName = "@codepilot/agent";
export {
  McpClientError,
  McpClientSession,
} from "./mcp-client.js";
export type {
  DiscoveredTool,
  McpClientConnectOptions,
  ToolCallResult,
} from "./mcp-client.js";
export {
  AgentStateError,
  DEFAULT_MAX_AGENT_STEPS,
  appendMessage,
  beginStep,
  createAgentState,
  endStep,
  failAgent,
  recordToolCall,
  recordToolResult,
  setAgentStatus,
  setFinalReport,
} from "./state.js";
export type {
  AgentEvent,
  AgentEventType,
  AgentMessage,
  AgentMessageRole,
  AgentState,
  AgentStatus,
  AgentStep,
  FinalReport,
  ToolCall,
  ToolResult,
} from "./state.js";
