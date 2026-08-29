import fs from "node:fs";
import path from "node:path";

export class PathSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathSecurityError";
  }
}

function isInsideRepositoryRoot(
  repositoryRoot: string,
  candidate: string,
): boolean {
  const relative = path.relative(repositoryRoot, candidate);

  if (relative === "") {
    return true;
  }

  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveThroughExistingAncestors(candidate: string): string {
  const segments: string[] = [];
  let current = candidate;

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);

    if (parent === current) {
      throw new PathSecurityError(
        `Unable to resolve path against an existing filesystem ancestor: ${candidate}`,
      );
    }

    segments.unshift(path.basename(current));
    current = parent;
  }

  const realAncestor = fs.realpathSync(current);
  return segments.length === 0
    ? realAncestor
    : path.join(realAncestor, ...segments);
}

export function resolveRepoPath(
  repositoryRoot: string,
  inputPath: string,
): string {
  if (typeof repositoryRoot !== "string" || repositoryRoot.trim() === "") {
    throw new PathSecurityError(
      "Repository root must be a non-empty string.",
    );
  }

  if (typeof inputPath !== "string" || inputPath === "") {
    throw new PathSecurityError("Path must be a non-empty string.");
  }

  if (inputPath.includes("\0") || repositoryRoot.includes("\0")) {
    throw new PathSecurityError("Path contains an invalid null byte.");
  }

  let root: string;
  try {
    root = fs.realpathSync(path.resolve(repositoryRoot));
  } catch {
    throw new PathSecurityError(
      `Repository root does not exist or is inaccessible: ${path.resolve(repositoryRoot)}`,
    );
  }

  if (!fs.statSync(root).isDirectory()) {
    throw new PathSecurityError(
      `Repository root must be a directory: ${root}`,
    );
  }

  const resolved = path.resolve(root, inputPath);
  const candidate = resolveThroughExistingAncestors(resolved);

  if (!isInsideRepositoryRoot(root, candidate)) {
    throw new PathSecurityError(
      `Path is outside the repository root (${root}): ${inputPath}`,
    );
  }

  return candidate;
}
