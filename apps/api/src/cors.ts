import type { IncomingMessage, ServerResponse } from "node:http";

const DEFAULT_WEB_ORIGIN = "http://localhost:3000";

export function applyCors(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const origin = process.env.WEB_ORIGIN?.trim() || DEFAULT_WEB_ORIGIN;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

export function handleCorsPreflight(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  if (req.method !== "OPTIONS") {
    return false;
  }
  applyCors(req, res);
  res.writeHead(204);
  res.end();
  return true;
}
