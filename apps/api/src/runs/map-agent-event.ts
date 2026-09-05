import type { AgentEvent } from "@codepilot/agent";
import type { StreamEventType } from "./events.js";

export function mapAgentEventToStreamType(
  event: AgentEvent,
): StreamEventType | null {
  switch (event.type) {
    case "step_start":
      return "step_started";
    case "tool_call":
      return "tool_call_started";
    case "tool_result": {
      const payload = event.payload as { isError?: boolean } | undefined;
      return payload?.isError ? "tool_call_failed" : "tool_call_completed";
    }
    default:
      return null;
  }
}
