import type { IncomingMessage, ServerResponse } from "node:http";
import {
  formatSseEvent,
  isTerminalStreamEvent,
  type StreamEvent,
} from "../runs/events.js";
import type { RunsService } from "../runs/service.js";

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function writeSse(res: ServerResponse, event: StreamEvent): boolean {
  return res.write(formatSseEvent(event));
}

export function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  runs: RunsService,
  runId: string,
): void {
  const run = runs.getRun(runId);
  if (!run) {
    sendJson(res, 404, { error: "Run not found." });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  let closed = false;
  let unsubscribe: (() => void) | undefined;

  const close = () => {
    if (closed) {
      return;
    }
    closed = true;
    unsubscribe?.();
    res.end();
  };

  const onEvent = (event: StreamEvent) => {
    if (closed) {
      return;
    }
    writeSse(res, event);
    if (isTerminalStreamEvent(event.type)) {
      close();
    }
  };

  const buffered = runs.listEvents(runId);
  for (const event of buffered) {
    onEvent(event);
    if (closed) {
      return;
    }
  }

  if (run.status !== "running") {
    close();
    return;
  }

  try {
    unsubscribe = runs.subscribe(runId, onEvent);
  } catch {
    sendJson(res, 404, { error: "Run not found." });
    return;
  }

  req.on("close", () => {
    close();
  });
}
