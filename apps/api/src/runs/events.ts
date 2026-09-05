export type StreamEventType =
  | "run_started"
  | "step_started"
  | "tool_call_started"
  | "tool_call_completed"
  | "tool_call_failed"
  | "run_completed"
  | "run_failed";

export type StreamEvent = {
  id: number;
  type: StreamEventType;
  runId: string;
  timestamp: string;
  payload?: unknown;
};

export function formatSseEvent(event: StreamEvent): string {
  const data = JSON.stringify({
    runId: event.runId,
    timestamp: event.timestamp,
    payload: event.payload ?? null,
  });
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

const TERMINAL_EVENTS = new Set<StreamEventType>([
  "run_completed",
  "run_failed",
]);

export function isTerminalStreamEvent(type: StreamEventType): boolean {
  return TERMINAL_EVENTS.has(type);
}
