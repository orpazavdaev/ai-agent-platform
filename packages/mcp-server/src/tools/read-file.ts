import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PathSecurityError, resolveRepoPath } from "../security/path-guard.js";

export const MAX_READ_FILE_BYTES = 256 * 1024;

export type ReadFileErrorCode =
  | "invalid_path"
  | "not_found"
  | "is_directory"
  | "outside_repository"
  | "too_large"
  | "unreadable";

export class ReadFileError extends Error {
  readonly code: ReadFileErrorCode;

  constructor(code: ReadFileErrorCode, message: string) {
    super(message);
    this.name = "ReadFileError";
    this.code = code;
  }
}

export const readFileInputSchema = z.object({
  path: z.string().min(1, "Path must be a non-empty string."),
});

export type ReadFileResult = {
  path: string;
  content: string;
  sizeBytes: number;
};

export type ReadFileErrorResult = {
  error: {
    code: ReadFileErrorCode;
    message: string;
  };
};

function toPosixRelative(repositoryRoot: string, absolutePath: string): string {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}

export function readRepoFile(
  repositoryRoot: string,
  inputPath: string,
): ReadFileResult {
  const parsed = readFileInputSchema.safeParse({ path: inputPath });
  if (!parsed.success) {
    throw new ReadFileError(
      "invalid_path",
      parsed.error.issues[0]?.message ?? "Path must be a non-empty string.",
    );
  }

  let absolutePath: string;
  try {
    absolutePath = resolveRepoPath(repositoryRoot, parsed.data.path);
  } catch (error) {
    if (error instanceof PathSecurityError) {
      throw new ReadFileError("outside_repository", error.message);
    }
    throw error;
  }

  if (!fs.existsSync(absolutePath)) {
    throw new ReadFileError(
      "not_found",
      `File not found: ${parsed.data.path}`,
    );
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    throw new ReadFileError(
      "unreadable",
      `Unable to read path: ${parsed.data.path}`,
    );
  }

  if (stat.isDirectory()) {
    throw new ReadFileError(
      "is_directory",
      `Path is a directory: ${parsed.data.path}`,
    );
  }

  if (!stat.isFile()) {
    throw new ReadFileError(
      "unreadable",
      `Path is not a regular file: ${parsed.data.path}`,
    );
  }

  if (stat.size > MAX_READ_FILE_BYTES) {
    throw new ReadFileError(
      "too_large",
      `File exceeds the ${MAX_READ_FILE_BYTES} byte limit: ${parsed.data.path}`,
    );
  }

  let content: string;
  try {
    content = fs.readFileSync(absolutePath, "utf8");
  } catch {
    throw new ReadFileError(
      "unreadable",
      `Unable to read file: ${parsed.data.path}`,
    );
  }

  const root = resolveRepoPath(repositoryRoot, ".");
  return {
    path: toPosixRelative(root, absolutePath),
    content,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
}

function toErrorResult(error: unknown): ReadFileErrorResult {
  if (error instanceof ReadFileError) {
    return {
      error: {
        code: error.code,
        message: error.message,
      },
    };
  }

  if (error instanceof PathSecurityError) {
    return {
      error: {
        code: "outside_repository",
        message: error.message,
      },
    };
  }

  return {
    error: {
      code: "unreadable",
      message: error instanceof Error ? error.message : "read_file failed.",
    },
  };
}

export function registerReadFileTool(
  server: McpServer,
  repositoryRoot: string,
): void {
  server.registerTool(
    "read_file",
    {
      title: "Read File",
      description:
        "Read a text file inside the configured repository. Rejects directories, missing paths, paths outside the repository root, and files over the size limit.",
      inputSchema: readFileInputSchema,
      outputSchema: z.object({
        path: z.string(),
        content: z.string(),
        sizeBytes: z.number().int().nonnegative(),
      }),
    },
    async ({ path: inputPath }) => {
      try {
        const output = readRepoFile(repositoryRoot, inputPath);
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
