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
export {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  LlmConnectionError,
  LlmError,
  LlmModelError,
  OllamaProvider,
  createLlmProviderFromEnv,
} from "./llm/index.js";
export type {
  LlmChatRequest,
  LlmChatResponse,
  LlmMessage,
  LlmMessageRole,
  LlmProvider,
  LlmToolCall,
  LlmToolDefinition,
  OllamaProviderOptions,
} from "./llm/index.js";
export { AgentRunner, validateFinalReport } from "./runner.js";
export type { AgentMcpPort, AgentRunnerOptions } from "./runner.js";
