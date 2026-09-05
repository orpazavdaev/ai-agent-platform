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
import {
  DEFAULT_MAX_AGENT_STEPS,
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
  toolTimeoutMs?: number;
  maxToolResultBytes?: number;
  maxIdenticalToolCalls?: number;
  onEvent?: (event: AgentEvent) => void;
};

export type AgentRunOptions = {
  signal?: AbortSignal;
};

const SYSTEM_PROMPT = [
  "You are CodePilot, a software engineering investigation agent.",
  "Use the available MCP tools to inspect the repository.",
  "Do not invent filesystem or shell access; only use tools.",
  "You cannot modify, create, delete, or patch repository files. Never claim that you changed code.",
  "Separate claims carefully:",
  "- investigated: what you looked at (files, searches, diffs).",
  "- identified: facts you found from tool evidence.",
  "- recommended: suggested fixes or next steps that were NOT applied.",
  "- verified: only outcomes confirmed by tool evidence (for example failing/passing tests).",
  "When you have enough evidence, respond with ONLY a JSON object matching:",
  JSON.stringify({
    summary: "string",
    rootCause: "string",
    filesInspected: ["string"],
    testsExecuted: ["string"],
    testResult: "string",
    confidence: "high|medium|low",
    uncertainty: ["string"],
    investigated: ["string"],
    identified: ["string"],
    recommended: ["string"],
    verified: ["string"],
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

function requireNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return null;
  }
  return value.trim();
}

function claimsCodeModification(text: string): boolean {
  return /\b(i|we)\s+(modified|changed|edited|patched|fixed|updated|wrote|created|deleted)\b/i.test(
    text,
  );
}

export function validateFinalReport(
  value: unknown,
  _state: AgentState,
): FinalReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const summary = requireNonEmptyString(record.summary);
  const rootCause = requireNonEmptyString(record.rootCause);
  const testResult = requireNonEmptyString(record.testResult);
  const confidence = requireNonEmptyString(record.confidence);

  if (!summary || !rootCause || !testResult || !confidence) {
    return null;
  }

  if (
    !isStringArray(record.filesInspected) ||
    !isStringArray(record.testsExecuted) ||
    !isStringArray(record.uncertainty) ||
    !isStringArray(record.investigated) ||
    !isStringArray(record.identified) ||
    !isStringArray(record.recommended) ||
    !isStringArray(record.verified)
  ) {
    return null;
  }

  const narrative = [
    summary,
    rootCause,
    testResult,
    ...record.investigated,
    ...record.identified,
    ...record.recommended,
    ...record.verified,
    ...record.uncertainty,
  ].join("\n");

  if (claimsCodeModification(narrative)) {
    return null;
  }

  return {
    summary,
    rootCause,
    filesInspected: [...record.filesInspected],
    testsExecuted: [...record.testsExecuted],
    testResult,
    confidence,
    uncertainty: [...record.uncertainty],
    investigated: [...record.investigated],
    identified: [...record.identified],
    recommended: [...record.recommended],
    verified: [...record.verified],
  };
}

function parseFinalReport(
  response: LlmChatResponse,
  state: AgentState,
): FinalReport | null {
  return validateFinalReport(extractJsonObject(response.message.content), state);
}

export function isCleanFailureState(state: AgentState): boolean {
  return (
    state.status === "failed" &&
    typeof state.error === "string" &&
    state.error.trim() !== "" &&
    state.finalReport === null &&
    state.events.some((event) => event.type === "error") &&
    state.events.some((event) => event.type === "done")
  );
}

export class AgentRunner {
  constructor(private readonly options: AgentRunnerOptions) {}

  async run(
    task: string,
    runOptions: AgentRunOptions = {},
  ): Promise<AgentState> {
    const maxSteps = this.options.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
    const toolTimeoutMs =
      this.options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const maxToolResultBytes =
      this.options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
    const maxIdenticalToolCalls =
      this.options.maxIdenticalToolCalls ?? DEFAULT_MAX_IDENTICAL_TOOL_CALLS;
    const signal = runOptions.signal;

    const state = createAgentState({
      task,
      maxSteps,
    });
    let eventIndex = emitNew(state, 0, this.options.onEvent);

    appendMessage(state, { role: "system", content: SYSTEM_PROMPT });
    appendMessage(state, { role: "user", content: state.task });

    try {
      throwIfAborted(signal);

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
        throwIfAborted(signal);

        if (state.currentStep >= state.maxSteps) {
          failAgent(
            state,
            `Reached maximum of ${state.maxSteps} steps without a final report.`,
          );
          eventIndex = emitNew(state, eventIndex, this.options.onEvent);
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
          if (error instanceof RunCancelledError) {
            throw error;
          }
          const message =
            error instanceof LlmError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Model request failed.";
          failAgent(state, message);
          eventIndex = emitNew(state, eventIndex, this.options.onEvent);
          break;
        }

        throwIfAborted(signal);

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

          let stop = false;
          for (const call of toolCalls) {
            throwIfAborted(signal);

            const identicalCount = countIdenticalToolCalls(
              state.toolCalls,
              call.name,
              call.arguments,
            );
            if (identicalCount + 1 > maxIdenticalToolCalls) {
              recordToolCall(state, {
                id: call.id,
                name: call.name,
                arguments: call.arguments,
              });
              eventIndex = emitNew(state, eventIndex, this.options.onEvent);
              failAgent(
                state,
                `Repeated identical tool call detected for "${call.name}" (limit ${maxIdenticalToolCalls}).`,
              );
              eventIndex = emitNew(state, eventIndex, this.options.onEvent);
              stop = true;
              break;
            }

            recordToolCall(state, {
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            });
            eventIndex = emitNew(state, eventIndex, this.options.onEvent);

            let toolResult: ToolCallResult;
            try {
              toolResult = await withTimeout(
                this.options.mcp.callTool(call.name, call.arguments),
                toolTimeoutMs,
                `Tool "${call.name}"`,
                signal,
              );
            } catch (error) {
              if (error instanceof RunCancelledError) {
                throw error;
              }
              if (error instanceof ToolTimeoutError) {
                toolResult = {
                  isError: true,
                  content: [{ type: "text", text: error.message }],
                  structuredContent: {
                    error: {
                      code: "timeout",
                      message: error.message,
                    },
                  },
                };
              } else {
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
            }

            const rawContent = stringifyToolContent(toolResult);
            const bounded = truncateUtf8(rawContent, maxToolResultBytes);
            const content = bounded.text;
            const structuredContent = bounded.truncated
              ? {
                  truncated: true,
                  preview: content,
                }
              : toolResult.structuredContent;

            recordToolResult(state, {
              toolCallId: call.id,
              name: call.name,
              isError: toolResult.isError || bounded.truncated,
              content,
              structuredContent,
            });
            eventIndex = emitNew(state, eventIndex, this.options.onEvent);

            appendMessage(state, {
              role: "tool",
              content,
              toolCallId: call.id,
              toolName: call.name,
            });
          }

          if (stop) {
            break;
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
          eventIndex = emitNew(state, eventIndex, this.options.onEvent);
          break;
        }

        endStep(state);
        eventIndex = emitNew(state, eventIndex, this.options.onEvent);
        setFinalReport(state, report);
        eventIndex = emitNew(state, eventIndex, this.options.onEvent);
        break;
      }
    } catch (error) {
      if (error instanceof RunCancelledError) {
        if (state.status !== "failed" && state.status !== "completed") {
          failAgent(state, error.message);
          emitNew(state, eventIndex, this.options.onEvent);
        }
        return state;
      }
      throw error;
    }

    return state;
  }
}
