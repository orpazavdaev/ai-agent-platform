import { spawn } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { boundUtf8 } from "../text.js";

export const DEFAULT_TEST_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export type RunTestsErrorCode = "invalid_config" | "spawn_failed";

export class RunTestsError extends Error {
  readonly code: RunTestsErrorCode;

  constructor(code: RunTestsErrorCode, message: string) {
    super(message);
    this.name = "RunTestsError";
    this.code = code;
  }
}

export type RunTestsResult = {
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  command: string[];
};

export type RunTestsErrorResult = {
  error: {
    code: RunTestsErrorCode;
    message: string;
  };
};

export type RunTestsConfig = {
  repositoryRoot: string;
  command: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
};

const SHELL_META = /[\n\r;|&`$<>]/

export function parseTrustedTestCommand(raw: string): string[] {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new RunTestsError(
      "invalid_config",
      "Trusted test command must be a non-empty string.",
    );
  }

  const parts = raw.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new RunTestsError(
      "invalid_config",
      "Trusted test command must be a non-empty string.",
    );
  }

  for (const part of parts) {
    if (SHELL_META.test(part)) {
      throw new RunTestsError(
        "invalid_config",
        "Trusted test command must not contain shell metacharacters.",
      );
    }
  }

  return parts;
}

export function resolveTrustedTestCommand(explicit?: string): string[] {
  const configured =
    explicit ??
    process.env.TEST_COMMAND ??
    (process.platform === "win32" ? "npm.cmd test" : "npm test");

  return parseTrustedTestCommand(configured);
}

export async function runTests(config: RunTestsConfig): Promise<RunTestsResult> {
  if (!Array.isArray(config.command) || config.command.length === 0) {
    throw new RunTestsError(
      "invalid_config",
      "Trusted test command argv must be a non-empty array.",
    );
  }

  for (const part of config.command) {
    if (typeof part !== "string" || part === "" || SHELL_META.test(part)) {
      throw new RunTestsError(
        "invalid_config",
        "Trusted test command argv is invalid.",
      );
    }
  }

  if (
    typeof config.repositoryRoot !== "string" ||
    config.repositoryRoot.trim() === ""
  ) {
    throw new RunTestsError(
      "invalid_config",
      "Repository root must be a non-empty string.",
    );
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new RunTestsError(
      "invalid_config",
      "Test timeout must be a positive integer.",
    );
  }

  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RunTestsError(
      "invalid_config",
      "maxOutputBytes must be a positive integer.",
    );
  }

  const [file, ...args] = config.command;
  const startedAt = Date.now();
  const isWindowsBatch =
    process.platform === "win32" && /\.(cmd|bat)$/i.test(file!);

  return await new Promise<RunTestsResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawn(file!, args, {
      cwd: config.repositoryRoot,
      env: process.env,
      shell: isWindowsBatch,
      windowsHide: true,
    });

    const finish = (result: RunTestsResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const append = (stream: "stdout" | "stderr", chunk: Buffer) => {
      const current = stream === "stdout" ? stdout : stderr;
      const next = current + chunk.toString("utf8");
      const bounded = boundUtf8(next, maxOutputBytes);
      if (stream === "stdout") {
        stdout = bounded.text;
      } else {
        stderr = bounded.text;
      }
      if (bounded.truncated) {
        truncated = true;
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      append("stdout", chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append("stderr", chunk);
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new RunTestsError(
          "spawn_failed",
          `Failed to start trusted test command: ${error.message}`,
        ),
      );
    });

    child.on("close", (exitCode, signal) => {
      const durationMs = Date.now() - startedAt;
      const ok = !timedOut && exitCode === 0;

      finish({
        ok,
        exitCode,
        signal,
        timedOut,
        durationMs,
        stdout,
        stderr,
        truncated,
        command: [...config.command],
      });
    });
  });
}

function toErrorResult(error: unknown): RunTestsErrorResult {
  if (error instanceof RunTestsError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: "spawn_failed",
      message: error instanceof Error ? error.message : "run_tests failed.",
    },
  };
}

export function registerRunTestsTool(
  server: McpServer,
  config: RunTestsConfig,
): void {
  server.registerTool(
    "run_tests",
    {
      title: "Run Tests",
      description:
        "Run the application-configured trusted test command inside the repository root. The LLM cannot choose or supply a shell command. Returns exit code, duration, and bounded stdout/stderr.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
        exitCode: z.number().int().nullable(),
        signal: z.string().nullable(),
        timedOut: z.boolean(),
        durationMs: z.number().int().nonnegative(),
        stdout: z.string(),
        stderr: z.string(),
        truncated: z.boolean(),
        command: z.array(z.string()),
      }),
    },
    async () => {
      try {
        const output = await runTests(config);
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
          isError: !output.ok,
        };
      } catch (error) {
        const structured = toErrorResult(error);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(structured, null, 2),
            },
          ],
          structuredContent: structured,
        };
      }
    },
  );
}
