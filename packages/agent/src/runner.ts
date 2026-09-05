import type {
  DiscoveredTool,
  ToolCallResult,
} from "./mcp-client.js";
import type {
  LlmChatResponse,
  LlmMessage,
  LlmProvider,
  LlmToolDefinition,
} from "./llm/types.js";
import { LlmError } from "./llm/types.js";
import {
  appendMessage,
  beginStep,
  createAgentState,
  endStep,
  failAgent,
  recordToolCall,
  recordToolResult,
  setFinalReport,
  type AgentEvent,
  type AgentState,
  type FinalReport,
} from "./state.js";

export type AgentMcpPort = {
  listTools(): Promise<DiscoveredTool[]>;
  callTool(
    name: string,
    args?: Record<string, unknown>,
  ): Promise<ToolCallResult>;
};

export type AgentRunnerOptions = {
  llm: LlmProvider;
  mcp: AgentMcpPort;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
};

const SYSTEM_PROMPT = [
  "You are CodePilot, a software engineering investigation agent.",
  "Use the available MCP tools to inspect the repository.",
  "Do not invent filesystem or shell access; only use tools.",
  "When you have enough evidence, respond with ONLY a JSON object matching:",
  JSON.stringify({
    summary: "string",
    findings: ["string"],
    stepsTaken: 0,
    toolsUsed: ["string"],
    conclusion: "string",
    limitations: ["string"],
  }),
].join("\n");

function emitNew(
  state: AgentState,
  fromIndex: number,
  onEvent?: (event: AgentEvent) => void,
): number {
  if (onEvent) {
    for (let index = fromIndex; index < state.events.length; index += 1) {
      onEvent(state.events[index]!);
    }
  }
  return state.events.length;
}

function toLlmMessages(state: AgentState): LlmMessage[] {
  return state.messages.map((message) => ({
    role: message.role,
    content: message.content,
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    toolCalls: message.toolCalls?.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
  }));
}

function toLlmTools(tools: DiscoveredTool[]): LlmToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.title,
    parameters:
      tool.inputSchema ??
      ({
        type: "object",
        properties: {},
      } as Record<string, unknown>),
  }));
}

function stringifyToolContent(result: ToolCallResult): string {
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return JSON.stringify(result.content);
}

function extractJsonObject(content: string): unknown {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function validateFinalReport(
  value: unknown,
  state: AgentState,
): FinalReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.summary !== "string" || record.summary.trim() === "") {
    return null;
  }
  if (typeof record.conclusion !== "string" || record.conclusion.trim() === "") {
    return null;
  }
  if (!isStringArray(record.findings) || !isStringArray(record.limitations)) {
    return null;
  }

  const toolsUsed = isStringArray(record.toolsUsed)
    ? record.toolsUsed
    : [...new Set(state.toolCalls.map((call) => call.name))];

  const stepsTaken =
    typeof record.stepsTaken === "number" &&
    Number.isInteger(record.stepsTaken) &&
    record.stepsTaken >= 0
      ? record.stepsTaken
      : state.currentStep;

  return {
    summary: record.summary.trim(),
    findings: [...record.findings],
    stepsTaken,
    toolsUsed,
    conclusion: record.conclusion.trim(),
    limitations: [...record.limitations],
  };
}

function parseFinalReport(
  response: LlmChatResponse,
  state: AgentState,
): FinalReport | null {
  return validateFinalReport(extractJsonObject(response.message.content), state);
}

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(task: string): Promise<AgentState> {
    const state = createAgentState({
      task,
      maxSteps: this.options.maxSteps,
    });
    let eventIndex = emitNew(state, 0, this.options.onEvent);

    appendMessage(state, { role: "system", content: SYSTEM_PROMPT });
    appendMessage(state, { role: "user", content: state.task });

    let tools: DiscoveredTool[];
    try {
      tools = await this.options.mcp.listTools();
    } catch (error) {
      failAgent(
        state,
        error instanceof Error
          ? `Failed to load MCP tools: ${error.message}`
          : "Failed to load MCP tools.",
      );
      emitNew(state, eventIndex, this.options.onEvent);
      return state;
    }

    const llmTools = toLlmTools(tools);

    while (
      state.status !== "completed" &&
      state.status !== "failed"
    ) {
      if (state.currentStep >= state.maxSteps) {
        failAgent(
          state,
          `Reached maximum of ${state.maxSteps} steps without a final report.`,
        );
        emitNew(state, eventIndex, this.options.onEvent);
        break;
      }

      beginStep(state);
      eventIndex = emitNew(state, eventIndex, this.options.onEvent);

      let response: LlmChatResponse;
      try {
        response = await this.options.llm.chat({
          messages: toLlmMessages(state),
          tools: llmTools,
        });
      } catch (error) {
        const message =
          error instanceof LlmError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Model request failed.";
        failAgent(state, message);
        emitNew(state, eventIndex, this.options.onEvent);
        break;
      }

      const toolCalls = response.message.toolCalls ?? [];
      if (toolCalls.length > 0) {
        appendMessage(state, {
          role: "assistant",
          content: response.message.content,
          toolCalls: toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        });

        for (const call of toolCalls) {
          recordToolCall(state, {
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          });
          eventIndex = emitNew(state, eventIndex, this.options.onEvent);

          let toolResult: ToolCallResult;
          try {
            toolResult = await this.options.mcp.callTool(
              call.name,
              call.arguments,
            );
          } catch (error) {
            toolResult = {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    error instanceof Error
                      ? error.message
                      : "MCP tool call failed.",
                },
              ],
            };
          }

          const content = stringifyToolContent(toolResult);
          recordToolResult(state, {
            toolCallId: call.id,
            name: call.name,
            isError: toolResult.isError,
            content,
            structuredContent: toolResult.structuredContent,
          });
          eventIndex = emitNew(state, eventIndex, this.options.onEvent);

          appendMessage(state, {
            role: "tool",
            content,
            toolCallId: call.id,
            toolName: call.name,
          });
        }

        endStep(state);
        eventIndex = emitNew(state, eventIndex, this.options.onEvent);
        continue;
      }

      appendMessage(state, {
        role: "assistant",
        content: response.message.content,
      });

      const report = parseFinalReport(response, state);
      if (!report) {
        failAgent(
          state,
          "Model returned a final answer that was not a valid FinalReport JSON object.",
        );
        emitNew(state, eventIndex, this.options.onEvent);
        break;
      }

      endStep(state);
      eventIndex = emitNew(state, eventIndex, this.options.onEvent);
      setFinalReport(state, report);
      emitNew(state, eventIndex, this.options.onEvent);
      break;
    }

    return state;
  }
}
