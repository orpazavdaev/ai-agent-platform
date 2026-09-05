export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 32 * 1024;
export const DEFAULT_MAX_IDENTICAL_TOOL_CALLS = 3;

export class ToolTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolTimeoutError";
  }
}

export class RunCancelledError extends Error {
  constructor(message = "Run cancelled.") {
    super(message);
    this.name = "RunCancelledError";
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export function toolCallFingerprint(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}:${stableStringify(args)}`;
}

export function countIdenticalToolCalls(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  name: string,
  args: Record<string, unknown>,
): number {
  const fingerprint = toolCallFingerprint(name, args);
  return calls.filter(
    (call) => toolCallFingerprint(call.name, call.arguments) === fingerprint,
  ).length;
}

export function truncateUtf8(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error("maxBytes must be a positive integer.");
  }

  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return { text: value, truncated: false };
  }

  const marker = "\n...[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) {
    return {
      text: buffer.subarray(0, maxBytes).toString("utf8"),
      truncated: true,
    };
  }

  const body = buffer
    .subarray(0, maxBytes - markerBytes)
    .toString("utf8");
  return { text: `${body}${marker}`, truncated: true };
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RunCancelledError();
  }
}

export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);

  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer.");
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new RunCancelledError());
    };

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(new ToolTimeoutError(`${label} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
