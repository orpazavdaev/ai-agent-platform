import path from "node:path";

export function boundUtf8(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return { text: value, truncated: false };
  }

  return {
    text: buffer.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
}

export function toPosixRelative(
  repositoryRoot: string,
  absolutePath: string,
): string {
  return path.relative(repositoryRoot, absolutePath).split(path.sep).join("/");
}
