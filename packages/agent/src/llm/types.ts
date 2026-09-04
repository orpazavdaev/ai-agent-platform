export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export type LlmToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type LlmMessage = {
  role: LlmMessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: LlmToolCall[];
};

export type LlmToolDefinition = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type LlmChatRequest = {
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
};

export type LlmChatResponse = {
  message: LlmMessage;
  model: string;
  done: boolean;
};

export type LlmProvider = {
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
};

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmError";
  }
}

export class LlmConnectionError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmConnectionError";
  }
}

export class LlmModelError extends LlmError {
  constructor(message: string) {
    super(message);
    this.name = "LlmModelError";
  }
}
