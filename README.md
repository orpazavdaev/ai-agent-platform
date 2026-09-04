# CodePilot Agent

Production-oriented but intentionally simple AI software engineering agent. It will investigate software engineering tasks with an LLM and MCP repository tools, stream activity to a Next.js UI, and return a structured final report.

## Current status

Workspace scaffold plus:

- `test-repository` sample app with an intentional pricing bug
- MCP server repository path security utilities (`resolveRepoPath`)
- Stdio MCP server process (`codepilot-mcp-server`) with `search_code`, `read_file`, `run_tests`, and `get_diff` registered
- Agent package MCP client (`McpClientSession`) that spawns the server over stdio and discovers tools dynamically

## High-level architecture

```
apps/web            UI — no agent logic
apps/api            Thin HTTP/SSE layer — no agent reasoning
packages/agent      LLM + MCP client + explicit agent loop
packages/mcp-server Repository MCP capabilities only — no LLM reasoning
test-repository     Standalone sample repo for agent investigation demos
```

## MCP server

`packages/mcp-server` is the Model Context Protocol server for CodePilot.

Responsibilities:

- Expose repository capabilities to the agent through MCP tools
- Enforce repository-root path security for those capabilities
- Run as a local child process over stdio

It does **not** contain LLM prompts, tool-selection logic, or any agent reasoning. Those belong in `packages/agent`. The MCP server only provides capabilities (tools/resources the host can call).

### MCP tools

| Tool | Input | Description |
|------|-------|-------------|
| `search_code` | `{ query: string }` | Search text/code files under `REPO_ROOT`. Returns matching paths, line numbers, and concise snippets. Skips common generated directories and stays inside the repository root. |
| `read_file` | `{ path: string }` | Read a file under `REPO_ROOT`. Uses path security, rejects directories/missing/outside/oversized paths, and returns structured errors. |
| `run_tests` | `{}` | Run the fixed trusted test command from application config (`TEST_COMMAND`). Returns exit code, duration, and bounded stdout/stderr. The model cannot supply a shell command. |
| `get_diff` | `{}` | Return the current `git diff` against `HEAD` under `REPO_ROOT` using a fixed git argv only. Reports empty diffs and non-git roots clearly; output size is capped. |

### Why stdio for the MVP

The agent launches the MCP server as a local subprocess and talks JSON-RPC on stdin/stdout. That matches the common local MCP hosting model, keeps deployment simple (no HTTP listener), and avoids multi-client transport complexity for a single-agent MVP.

Operational logs go to **stderr** so stdout stays a clean protocol channel.

```bash
npm run build -w @codepilot/mcp-server
REPO_ROOT=./test-repository npm start -w @codepilot/mcp-server
```

Startup is verified by the package test suite: a stdio MCP client connects, completes initialize, and confirms the registered repository tools.

## Test repository

`test-repository/` is a small, standalone TypeScript project (`mini-checkout`). It is not part of the npm workspaces.

CodePilot will use it as the target codebase when demonstrating or testing agent investigation: the agent should inspect source and tests there through MCP tools, not through the main monorepo packages.

It ships with an intentional, deterministic pricing bug so a failing test suite gives the agent a concrete software engineering task.

```bash
cd test-repository
npm install
npm test
```

## Security Boundaries

Repository filesystem access is constrained by `packages/mcp-server` security utilities. The configured repository root is the only trust boundary for path resolution.

Implemented behavior (`resolveRepoPath`):

- Resolves the repository root to a real absolute directory path
- Resolves the requested path with Node's path resolution (not string checks for `"../"` alone)
- Follows existing symlink ancestors via `realpath` before the containment check
- Accepts the path only when the final resolved location is inside the repository root
- Rejects empty paths, null bytes, missing/non-directory roots, traversal escapes, and absolute paths that resolve outside the root

### Why `run_tests` uses a fixed command

`run_tests` deliberately takes **no command input from the LLM**. An agent that can invent shell strings can turn “run the tests” into arbitrary remote code execution on the host.

Instead:

- The host configures one trusted argv via `TEST_COMMAND` (default `npm test`)
- The tool parses that string into argv and runs it in `REPO_ROOT` (no LLM-supplied command)
- Shell metacharacters in the configured command are rejected
- On Windows, `.cmd`/`.bat` trusted binaries use `shell: true` only because Node refuses to spawn them otherwise; argv remains fixed and metacharacter-checked
- Execution is bounded by timeout and captured stdout/stderr size caps

The model may call `run_tests`, but it cannot choose *what* runs.

`get_diff` follows the same rule for git: it only runs a fixed `git diff --no-ext-diff --no-color HEAD` in `REPO_ROOT`. There is no git-command input field.

## MCP Verification

Independent stdio MCP client checks (after `npm run build -w @codepilot/mcp-server`):

1. Server starts and completes the initialize handshake
2. `tools/list` returns exactly `search_code`, `read_file`, `run_tests`, `get_diff`
3. Happy-path calls succeed for all four tools against a fixture `REPO_ROOT`
4. Invalid tool input is rejected
5. Path traversal / absolute outside paths return structured `outside_repository` errors
6. Missing files and directory reads return structured tool errors

Package tests cover the same behaviors; run:

```bash
npm test -w @codepilot/mcp-server
```

Optional UI: MCP Inspector against `node packages/mcp-server/dist/main.js` with `REPO_ROOT` and `TEST_COMMAND` set.

## Planned development phases

1. Shared request/event/report schemas
2. MCP server with four tools (`search_code`, `read_file`, `run_tests`, `get_diff`) and path security
3. Agent loop with MCP client (max 10 steps), mocked LLM first
4. Real LLM adapter and structured final report
5. API streaming endpoint wired to the agent
6. Next.js UI for task input, activity stream, and report
7. Hardening (timeouts, output caps) and runbook updates

## Setup

Requirements: Node.js 20+

```bash
cp .env.example .env
npm install
npm run typecheck
npm run build
```

## Workspace packages

| Path | Package | Role |
|------|---------|------|
| `apps/web` | `@codepilot/web` | Next.js frontend |
| `apps/api` | `@codepilot/api` | API server |
| `packages/agent` | `@codepilot/agent` | Agent runtime |
| `packages/mcp-server` | `@codepilot/mcp-server` | MCP tool server |
