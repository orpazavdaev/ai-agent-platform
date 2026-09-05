export type RunUiStatus =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "error";

export type TimelineItem = {
  id: string;
  type: string;
  timestamp: string;
  summary: string;
};

export type ToolCallItem = {
  id: string;
  name: string;
  status: "started" | "completed" | "failed";
  timestamp: string;
  arguments?: Record<string, unknown>;
  detail?: string;
};

export type FinalReportView = {
  summary: string;
  findings: string[];
  stepsTaken: number;
  toolsUsed: string[];
  conclusion: string;
  limitations: string[];
};

export type StreamEventPayload = {
  runId: string;
  timestamp: string;
  payload: unknown;
};

export function getApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  return configured && configured.length > 0
    ? configured.replace(/\/+$/, "")
    : "http://localhost:3001";
}

export async function startRun(task: string): Promise<{ runId: string }> {
  const response = await fetch(`${getApiBaseUrl()}/api/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task }),
  });

  const body = (await response.json().catch(() => null)) as
    | { runId?: string; error?: string }
    | null;

  if (!response.ok) {
    throw new Error(body?.error ?? `Failed to start run (${response.status})`);
  }

  if (!body?.runId) {
    throw new Error("API did not return a runId.");
  }

  return { runId: body.runId };
}

export function subscribeToRunEvents(
  runId: string,
  handlers: {
    onEvent: (type: string, data: StreamEventPayload) => void;
    onError: (message: string) => void;
  },
): () => void {
  const source = new EventSource(
    `${getApiBaseUrl()}/api/runs/${encodeURIComponent(runId)}/events`,
  );

  const eventTypes = [
    "run_started",
    "step_started",
    "tool_call_started",
    "tool_call_completed",
    "tool_call_failed",
    "run_completed",
    "run_failed",
  ] as const;

  for (const type of eventTypes) {
    source.addEventListener(type, (event) => {
      const message = event as MessageEvent<string>;
      try {
        const data = JSON.parse(message.data) as StreamEventPayload;
        handlers.onEvent(type, data);
      } catch {
        handlers.onError("Failed to parse SSE event payload.");
      }
    });
  }

  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      return;
    }
    handlers.onError("Lost connection to the event stream.");
    source.close();
  };

  return () => {
    source.close();
  };
}

export function summarizeEvent(type: string, payload: unknown): string {
  switch (type) {
    case "run_started":
      return "Run started";
    case "step_started": {
      const step = (payload as { index?: number } | null)?.index;
      return typeof step === "number" ? `Step ${step} started` : "Step started";
    }
    case "tool_call_started": {
      const name = (payload as { name?: string } | null)?.name;
      return name ? `Tool started: ${name}` : "Tool call started";
    }
    case "tool_call_completed": {
      const name = (payload as { name?: string } | null)?.name;
      return name ? `Tool completed: ${name}` : "Tool call completed";
    }
    case "tool_call_failed": {
      const name = (payload as { name?: string } | null)?.name;
      return name ? `Tool failed: ${name}` : "Tool call failed";
    }
    case "run_completed":
      return "Run completed";
    case "run_failed": {
      const error = (payload as { error?: string } | null)?.error;
      return error ? `Run failed: ${error}` : "Run failed";
    }
    default:
      return type;
  }
}

export function asFinalReport(value: unknown): FinalReportView | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.summary !== "string" ||
    typeof record.conclusion !== "string" ||
    !Array.isArray(record.findings) ||
    !Array.isArray(record.limitations) ||
    !Array.isArray(record.toolsUsed) ||
    typeof record.stepsTaken !== "number"
  ) {
    return null;
  }

  return {
    summary: record.summary,
    conclusion: record.conclusion,
    findings: record.findings.filter(
      (item): item is string => typeof item === "string",
    ),
    limitations: record.limitations.filter(
      (item): item is string => typeof item === "string",
    ),
    toolsUsed: record.toolsUsed.filter(
      (item): item is string => typeof item === "string",
    ),
    stepsTaken: record.stepsTaken,
  };
}
