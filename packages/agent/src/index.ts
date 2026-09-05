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
export {
  DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  RunCancelledError,
  ToolTimeoutError,
  countIdenticalToolCalls,
  throwIfAborted,
  truncateUtf8,
  withTimeout,
} from "./guardrails.js";
export {
  AgentRunner,
  isCleanFailureState,
  validateFinalReport,
} from "./runner.js";
export type {
  AgentMcpPort,
  AgentRunOptions,
  AgentRunnerOptions,
} from "./runner.js";
