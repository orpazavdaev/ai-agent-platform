import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RunsService } from "../runs/service.js";

export const createRunBodySchema = z.object({
  task: z.string().trim().min(1, "task must be a non-empty string."),
});

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SyntaxError("Request body must be valid JSON.");
  }
}

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

export async function handleCreateRun(
  req: IncomingMessage,
  res: ServerResponse,
  runs: RunsService,
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: "Request body must be valid JSON." });
    return;
  }

  const parsed = createRunBodySchema.safeParse(body);
  if (!parsed.success) {
    sendJson(res, 400, {
      error: "Invalid request body.",
      details: parsed.error.issues.map((issue) => issue.message),
    });
    return;
  }

  const { runId } = runs.createRun(parsed.data.task);
  sendJson(res, 202, { runId });
}
