import {
  LlmConnectionError,
  LlmError,
  LlmModelError,
} from "./types.js";
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  LlmToolDefinition,
} from "./types.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "llama3.2";

export type OllamaProviderOptions = {
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
};

type OllamaChatMessage = {
  role: string;
  content?: string;
  tool_calls?: Array<{
    id?: string;
    function?: {
      name?: string;
      arguments?: unknown;
    };
  }>;
  tool_name?: string;
};

type OllamaChatResponse = {
  model?: string;
  message?: OllamaChatMessage;
  done?: boolean;
  error?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string" && value.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw: value };
    }
  }

  return {};
}

function toOllamaTools(tools: LlmToolDefinition[] | undefined): unknown[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? {
        type: "object",
        properties: {},
      },
    },
  }));
}

function toOllamaMessages(messages: LlmMessage[]): OllamaChatMessage[] {
  return messages.map((message) => {
    const mapped: OllamaChatMessage = {
      role: message.role,
      content: message.content,
    };

    if (message.role === "assistant" && message.toolCalls?.length) {
      mapped.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      }));
    }

    if (message.role === "tool") {
      mapped.tool_name = message.toolName;
      if (message.toolCallId) {
        (mapped as { tool_call_id?: string }).tool_call_id = message.toolCallId;
      }
    }

    return mapped;
  });
}

function fromOllamaMessage(message: OllamaChatMessage | undefined): LlmMessage {
  const toolCalls: LlmToolCall[] = [];
  for (const [index, call] of (message?.tool_calls ?? []).entries()) {
    const name = call.function?.name?.trim();
    if (!name) {
      continue;
    }
    toolCalls.push({
      id: call.id?.trim() || `tool-call-${index + 1}`,
      name,
      arguments: parseToolArguments(call.function?.arguments),
    });
  }

  return {
    role: (message?.role as LlmMessage["role"]) || "assistant",
    content: message?.content ?? "",
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

export class OllamaProvider implements LlmProvider {
  readonly baseUrl: string;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaProviderOptions = {}) {
    const model = (options.model ?? DEFAULT_OLLAMA_MODEL).trim();
    if (!model) {
      throw new LlmModelError("Ollama model name must be a non-empty string.");
    }

    const baseUrl = normalizeBaseUrl(
      (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).trim(),
    );
    if (!baseUrl) {
      throw new LlmConnectionError("Ollama base URL must be a non-empty string.");
    }

    this.model = model;
    this.baseUrl = baseUrl;
    this.fetchImpl = options.fetch ?? fetch;
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: { fetch?: typeof fetch } = {},
  ): OllamaProvider {
    return new OllamaProvider({
      baseUrl: env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL,
      model: env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL,
      fetch: options.fetch,
    });
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new LlmError("Chat request must include at least one message.");
    }

    const url = `${this.baseUrl}/api/chat`;
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: toOllamaMessages(request.messages),
          tools: toOllamaTools(request.tools),
          stream: false,
        }),
      });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Unknown connection failure";
      throw new LlmConnectionError(
        `Unable to reach Ollama at ${this.baseUrl}: ${detail}`,
      );
    }

    let body: OllamaChatResponse | undefined;
    const text = await response.text();
    try {
      body = text ? (JSON.parse(text) as OllamaChatResponse) : undefined;
    } catch {
      body = undefined;
    }

    if (!response.ok) {
      const detail = body?.error || text || response.statusText;
      if (response.status === 404) {
        throw new LlmModelError(
          `Ollama model error for "${this.model}": ${detail}`,
        );
      }
      throw new LlmError(
        `Ollama request failed (${response.status}): ${detail}`,
      );
    }

    if (body?.error) {
      const message = body.error;
      if (/not found|unknown model|pull/i.test(message)) {
        throw new LlmModelError(
          `Ollama model error for "${this.model}": ${message}`,
        );
      }
      throw new LlmError(`Ollama request failed: ${message}`);
    }

    if (!body?.message) {
      throw new LlmError("Ollama returned an empty chat response.");
    }

    return {
      message: fromOllamaMessage(body.message),
      model: body.model ?? this.model,
      done: body.done ?? true,
    };
  }
}

export function createLlmProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetch?: typeof fetch } = {},
): LlmProvider {
  return OllamaProvider.fromEnv(env, options);
}
