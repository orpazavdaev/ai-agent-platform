export const DEFAULT_MAX_AGENT_STEPS = 10;

export type AgentStatus =
  | "idle"
  | "running"
  | "waiting_for_tool"
  | "completed"
  | "failed";

export type AgentMessageRole = "system" | "user" | "assistant" | "tool";

export type AgentMessage = {
  role: AgentMessageRole;
  content: string;
  toolCallId?: string;
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  step: number;
};

export type ToolResult = {
  toolCallId: string;
  name: string;
  isError: boolean;
  content: string;
  structuredContent?: unknown;
  step: number;
};

export type AgentStep = {
  index: number;
  thought?: string;
  toolCallIds: string[];
  startedAt: string;
  finishedAt?: string;
};

export type FinalReport = {
  summary: string;
  findings: string[];
  stepsTaken: number;
  toolsUsed: string[];
  conclusion: string;
  limitations: string[];
};

export type AgentEventType =
  | "status"
  | "step_start"
  | "step_end"
  | "thought"
  | "tool_call"
  | "tool_result"
  | "error"
  | "report"
  | "done";

export type AgentEvent = {
  type: AgentEventType;
  step: number;
  timestamp: string;
  payload?: unknown;
};

export type AgentState = {
  task: string;
  messages: AgentMessage[];
  currentStep: number;
  status: AgentStatus;
  steps: AgentStep[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  events: AgentEvent[];
  finalReport: FinalReport | null;
  maxSteps: number;
  error?: string;
};

export class AgentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentStateError";
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function pushEvent(
  state: AgentState,
  type: AgentEventType,
  payload?: unknown,
): void {
  state.events.push({
    type,
    step: state.currentStep,
    timestamp: nowIso(),
    payload,
  });
}

export function createAgentState(input: {
  task: string;
  maxSteps?: number;
}): AgentState {
  if (typeof input.task !== "string" || input.task.trim() === "") {
    throw new AgentStateError("Agent task must be a non-empty string.");
  }

  const maxSteps = input.maxSteps ?? DEFAULT_MAX_AGENT_STEPS;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    throw new AgentStateError("maxSteps must be a positive integer.");
  }

  const state: AgentState = {
    task: input.task.trim(),
    messages: [],
    currentStep: 0,
    status: "idle",
    steps: [],
    toolCalls: [],
    toolResults: [],
    events: [],
    finalReport: null,
    maxSteps,
  };

  pushEvent(state, "status", { status: state.status });
  return state;
}

export function setAgentStatus(
  state: AgentState,
  status: AgentStatus,
  error?: string,
): AgentState {
  state.status = status;
  if (error !== undefined) {
    state.error = error;
  } else if (status !== "failed") {
    delete state.error;
  }
  pushEvent(state, "status", { status, error: state.error });
  return state;
}

export function appendMessage(
  state: AgentState,
  message: AgentMessage,
): AgentState {
  if (typeof message.content !== "string") {
    throw new AgentStateError("Message content must be a string.");
  }
  state.messages.push({ ...message });
  return state;
}

export function beginStep(
  state: AgentState,
  thought?: string,
): AgentStep {
  if (state.currentStep >= state.maxSteps) {
    throw new AgentStateError(
      `Cannot begin step beyond maxSteps (${state.maxSteps}).`,
    );
  }

  state.currentStep += 1;
  const step: AgentStep = {
    index: state.currentStep,
    thought,
    toolCallIds: [],
    startedAt: nowIso(),
  };
  state.steps.push(step);
  if (state.status === "idle") {
    state.status = "running";
    pushEvent(state, "status", { status: state.status });
  }
  pushEvent(state, "step_start", { index: step.index, thought });
  if (thought !== undefined) {
    pushEvent(state, "thought", { thought });
  }
  return step;
}

export function endStep(state: AgentState): AgentStep {
  const step = state.steps[state.steps.length - 1];
  if (!step || step.finishedAt) {
    throw new AgentStateError("No active step to end.");
  }
  step.finishedAt = nowIso();
  pushEvent(state, "step_end", { index: step.index });
  return step;
}

export function recordToolCall(
  state: AgentState,
  input: {
    id: string;
    name: string;
    arguments?: Record<string, unknown>;
  },
): ToolCall {
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new AgentStateError("Tool call id must be a non-empty string.");
  }
  if (typeof input.name !== "string" || input.name.trim() === "") {
    throw new AgentStateError("Tool call name must be a non-empty string.");
  }
  if (state.currentStep < 1) {
    throw new AgentStateError("Cannot record a tool call before beginStep.");
  }

  const toolCall: ToolCall = {
    id: input.id.trim(),
    name: input.name.trim(),
    arguments: input.arguments ?? {},
    step: state.currentStep,
  };

  state.toolCalls.push(toolCall);
  const step = state.steps[state.steps.length - 1];
  step?.toolCallIds.push(toolCall.id);
  state.status = "waiting_for_tool";
  pushEvent(state, "status", { status: state.status });
  pushEvent(state, "tool_call", toolCall);
  return toolCall;
}

export function recordToolResult(
  state: AgentState,
  input: {
    toolCallId: string;
    name: string;
    isError: boolean;
    content: string;
    structuredContent?: unknown;
  },
): ToolResult {
  if (typeof input.toolCallId !== "string" || input.toolCallId.trim() === "") {
    throw new AgentStateError("toolCallId must be a non-empty string.");
  }

  const matchingCall = state.toolCalls.find(
    (call) => call.id === input.toolCallId,
  );
  if (!matchingCall) {
    throw new AgentStateError(
      `Unknown toolCallId for tool result: ${input.toolCallId}`,
    );
  }

  const toolResult: ToolResult = {
    toolCallId: input.toolCallId.trim(),
    name: input.name.trim() || matchingCall.name,
    isError: input.isError,
    content: input.content,
    structuredContent: input.structuredContent,
    step: matchingCall.step,
  };

  state.toolResults.push(toolResult);
  state.status = "running";
  pushEvent(state, "status", { status: state.status });
  pushEvent(state, "tool_result", toolResult);
  return toolResult;
}

export function setFinalReport(
  state: AgentState,
  report: FinalReport,
): AgentState {
  state.finalReport = {
    summary: report.summary,
    findings: [...report.findings],
    stepsTaken: report.stepsTaken,
    toolsUsed: [...report.toolsUsed],
    conclusion: report.conclusion,
    limitations: [...report.limitations],
  };
  state.status = "completed";
  delete state.error;
  pushEvent(state, "report", state.finalReport);
  pushEvent(state, "status", { status: state.status });
  pushEvent(state, "done", { status: state.status });
  return state;
}

export function failAgent(
  state: AgentState,
  error: string,
): AgentState {
  if (typeof error !== "string" || error.trim() === "") {
    throw new AgentStateError("Failure error must be a non-empty string.");
  }
  state.status = "failed";
  state.error = error.trim();
  pushEvent(state, "error", { error: state.error });
  pushEvent(state, "status", { status: state.status, error: state.error });
  pushEvent(state, "done", { status: state.status });
  return state;
}
