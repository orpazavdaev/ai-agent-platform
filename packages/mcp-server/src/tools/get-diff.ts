import { spawn } from "node:child_process";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { boundUtf8 } from "../text.js";

export const FIXED_GIT_DIFF_ARGV = [
  "git",
  "diff",
  "--no-ext-diff",
  "--no-color",
  "HEAD",
] as const;

export const DEFAULT_DIFF_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_DIFF_BYTES = 64 * 1024;

export type GetDiffErrorCode =
  | "not_a_git_repository"
  | "git_failed"
  | "invalid_config";

export class GetDiffError extends Error {
  readonly code: GetDiffErrorCode;

  constructor(code: GetDiffErrorCode, message: string) {
    super(message);
    this.name = "GetDiffError";
    this.code = code;
  }
}

export type GetDiffResult = {
  ok: boolean;
  empty: boolean;
  diff: string;
  truncated: boolean;
  command: string[];
};

export type GetDiffErrorResult = {
  error: {
    code: GetDiffErrorCode;
    message: string;
  };
};

export type GetDiffConfig = {
  repositoryRoot: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

type CommandCapture = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

function runFixedGit(
  repositoryRoot: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number },
): Promise<CommandCapture> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let settled = false;

    const child = spawn("git", [...args], {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      windowsHide: true,
    });

    const finish = (result: CommandCapture) => {
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
      const bounded = boundUtf8(next, options.maxOutputBytes);
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
      child.kill();
      if (settled) {
        return;
      }
      settled = true;
      reject(new GetDiffError("git_failed", "git diff timed out."));
    }, options.timeoutMs);

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
        new GetDiffError(
          "git_failed",
          `Failed to start git: ${error.message}`,
        ),
      );
    });

    child.on("close", (exitCode) => {
      finish({
        exitCode,
        stdout,
        stderr,
        truncated,
      });
    });
  });
}

export async function getDiff(config: GetDiffConfig): Promise<GetDiffResult> {
  if (
    typeof config.repositoryRoot !== "string" ||
    config.repositoryRoot.trim() === ""
  ) {
    throw new GetDiffError(
      "invalid_config",
      "Repository root must be a non-empty string.",
    );
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new GetDiffError(
      "invalid_config",
      "Diff timeout must be a positive integer.",
    );
  }

  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_DIFF_BYTES;
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new GetDiffError(
      "invalid_config",
      "maxOutputBytes must be a positive integer.",
    );
  }

  const probe = await runFixedGit(
    config.repositoryRoot,
    ["rev-parse", "--is-inside-work-tree"],
    { timeoutMs, maxOutputBytes },
  );

  if (probe.exitCode !== 0 || probe.stdout.trim() !== "true") {
    throw new GetDiffError(
      "not_a_git_repository",
      "Repository root is not a git work tree.",
    );
  }

  const diffArgs = FIXED_GIT_DIFF_ARGV.slice(1);
  const captured = await runFixedGit(config.repositoryRoot, diffArgs, {
    timeoutMs,
    maxOutputBytes,
  });

  if (captured.exitCode !== 0) {
    const detail = captured.stderr.trim() || "git diff failed.";
    throw new GetDiffError("git_failed", detail);
  }

  const diff = captured.stdout;
  const empty = diff.trim() === "";

  return {
    ok: true,
    empty,
    diff,
    truncated: captured.truncated,
    command: [...FIXED_GIT_DIFF_ARGV],
  };
}

function toErrorResult(error: unknown): GetDiffErrorResult {
  if (error instanceof GetDiffError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: "git_failed",
      message: error instanceof Error ? error.message : "get_diff failed.",
    },
  };
}

export function registerGetDiffTool(
  server: McpServer,
  config: GetDiffConfig,
): void {
  server.registerTool(
    "get_diff",
    {
      title: "Get Diff",
      description:
        "Return the current git diff against HEAD inside the repository root. Uses a fixed git invocation only; the model cannot supply git arguments.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        ok: z.boolean(),
        empty: z.boolean(),
        diff: z.string(),
        truncated: z.boolean(),
        command: z.array(z.string()),
      }),
    },
    async () => {
      try {
        const output = await getDiff(config);
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
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
