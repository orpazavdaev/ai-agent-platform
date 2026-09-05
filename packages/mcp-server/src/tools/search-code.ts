import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PathSecurityError, resolveRepoPath } from "../security/path-guard.js";
import { toPosixRelative } from "../text.js";

export const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "coverage",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

export const DEFAULT_MAX_RESULTS = 50;
export const MAX_SNIPPET_LENGTH = 160;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_QUERY_LENGTH = 500;

export const searchCodeInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1, "Query must be a non-empty string.")
    .max(
      MAX_QUERY_LENGTH,
      `Query must be at most ${MAX_QUERY_LENGTH} characters.`,
    ),
});

export type SearchCodeMatch = {
  path: string;
  line: number;
  snippet: string;
};

export type SearchCodeResult = {
  matches: SearchCodeMatch[];
  truncated: boolean;
};

export class SearchCodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchCodeError";
  }
}

function trimSnippet(line: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= MAX_SNIPPET_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SNIPPET_LENGTH - 1)}…`;
}

function readTextFile(absolutePath: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return null;
  }

  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
    return null;
  }

  const buffer = fs.readFileSync(absolutePath);
  if (buffer.includes(0)) {
    return null;
  }

  return buffer.toString("utf8");
}

function collectFiles(repositoryRoot: string, currentDir: string, files: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const candidate = path.join(currentDir, entry.name);
    const relative = path.relative(repositoryRoot, candidate);

    let safePath: string;
    try {
      safePath = resolveRepoPath(repositoryRoot, relative === "" ? "." : relative);
    } catch (error) {
      if (error instanceof PathSecurityError) {
        continue;
      }
      throw error;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(safePath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        continue;
      }
      collectFiles(repositoryRoot, safePath, files);
      continue;
    }

    if (stat.isFile()) {
      files.push(safePath);
    }
  }
}

export function searchCode(
  repositoryRoot: string,
  query: string,
  options: { maxResults?: number } = {},
): SearchCodeResult {
  const parsed = searchCodeInputSchema.safeParse({ query });
  if (!parsed.success) {
    const message =
      parsed.error.issues[0]?.message ?? "Query must be a non-empty string.";
    throw new SearchCodeError(message);
  }

  const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new SearchCodeError("maxResults must be a positive integer.");
  }

  const root = resolveRepoPath(repositoryRoot, ".");
  const files: string[] = [];
  collectFiles(root, root, files);
  files.sort((left, right) => left.localeCompare(right));

  const matches: SearchCodeMatch[] = [];
  const needle = parsed.data.query;

  for (const absolutePath of files) {
    const content = readTextFile(absolutePath);
    if (content === null) {
      continue;
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!line.includes(needle)) {
        continue;
      }

      matches.push({
        path: toPosixRelative(root, absolutePath),
        line: index + 1,
        snippet: trimSnippet(line),
      });

      if (matches.length >= maxResults) {
        return { matches, truncated: true };
      }
    }
  }

  return { matches, truncated: false };
}

export function registerSearchCodeTool(
  server: McpServer,
  repositoryRoot: string,
): void {
  server.registerTool(
    "search_code",
    {
      title: "Search Code",
      description:
        "Search text and code files inside the configured repository. Returns matching file paths, line numbers, and concise snippets. Ignores common generated directories and stays within the repository root.",
      inputSchema: searchCodeInputSchema,
      outputSchema: z.object({
        matches: z.array(
          z.object({
            path: z.string(),
            line: z.number().int().positive(),
            snippet: z.string(),
          }),
        ),
        truncated: z.boolean(),
      }),
    },
    async ({ query }) => {
      try {
        const output = searchCode(repositoryRoot, query);
        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "search_code failed.";
        return {
          isError: true,
          content: [{ type: "text", text: message }],
        };
      }
    },
  );
}
