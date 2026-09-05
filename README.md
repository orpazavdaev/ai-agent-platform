# CodePilot Agent

Production-oriented but intentionally simple AI software engineering agent. It will investigate software engineering tasks with an LLM and MCP repository tools, stream activity to a Next.js UI, and return a structured final report.

## Current status

Workspace scaffold plus:

- `test-repository` sample app with an intentional pricing bug
- MCP server repository path security utilities (`resolveRepoPath`)
- Stdio MCP server process (`codepilot-mcp-server`) with `search_code`, `read_file`, `run_tests`, and `get_diff` registered
- Agent package MCP client (`McpClientSession`) that spawns the server over stdio and discovers tools dynamically
- Agent in-memory state/types (`AgentState`, steps, tool calls/results, events, `FinalReport`)
- Ollama LLM adapter behind a small `LlmProvider` interface (`OLLAMA_BASE_URL`, `OLLAMA_MODEL`)
- `AgentRunner` loop (max 10 steps) that discovers MCP tools, calls them through MCP, and validates a final JSON report
- API `POST /api/runs` that validates input, creates an in-memory run, starts `AgentRunner`, and returns `{ runId }` immediately
- API `GET /api/runs/:runId/events` SSE stream for run activity
- Next.js dashboard for task input, live timeline, tool calls, and final report

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

## Testing strategy

Tests prioritize behavior and safety over line coverage. They focus on boundaries that protect the host and keep runs deterministic.

### MCP server (`npm test -w @codepilot/mcp-server`)

- Input validation for tool arguments (missing/wrong types)
- Repository boundary and path traversal (`resolveRepoPath`, `read_file`, symlink escapes, null bytes)
- Fixed trusted commands only (`run_tests` / `get_diff` ignore model-supplied command argv)
- Structured tool failure codes (`outside_repository`, `not_found`, timeouts, spawn failures)
- Stdio smoke: initialize, tool list, happy-path calls

### Agent (`npm test -w @codepilot/agent`)

- Max step limit and clean failure without a report
- Repeated identical tool-call detection (same name + args; key-order equivalence; different args allowed)
- Structured `FinalReport` validation (required fields, no “I modified/fixed…” claims)
- Invalid final model output → clean failure
- Tool failures (MCP `isError`, timeouts, oversized results, transport throws) continue or fail cleanly as designed
- MCP tool discovery failure → clean failure

### API (`npm test -w @codepilot/api`)

- `POST /api/runs` Zod/JSON validation (empty/missing/wrong-type task, malformed JSON)
- Non-blocking run creation (`202` + `runId`)
- SSE lifecycle: live stream, replay after completion, `run_failed`, 404, client disconnect
- Terminal SSE payloads include `finalReport` or `error`

### What is intentionally not chased

- Arbitrary 100% line coverage
- UI snapshot/pixel suites
- End-to-end live Ollama quality (depends on local model/hardware)

## Local model (Ollama)

CodePilot uses **Ollama** as the local LLM backend for the agent package.

- **Why Ollama:** it runs entirely on the developer machine over a simple HTTP API (`/api/chat`), which fits a portfolio MVP that should be easy to clone and try.
- **Why no paid model API is required:** the agent talks to `OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`) and `OLLAMA_MODEL`. There is no cloud API key in the default path.
- **Trade-off:** quality and reliability depend on the model you pull and on local hardware (CPU/GPU/RAM). Smaller models may struggle with tool calling or multi-step investigation; larger models need more resources. This project does not claim strong autonomous performance on every machine.

Ollama-specific code is isolated under `packages/agent/src/llm/ollama.ts`. The rest of the agent depends only on the small `LlmProvider` interface.

## API

Thin HTTP layer in `apps/api`. It does not contain agent reasoning; it validates requests, tracks in-memory runs, and starts `AgentRunner`.

### `POST /api/runs`

Starts an investigation run.

Request:

```json
{
  "task": "Investigate the failing checkout discount test"
}
```

Response (`202 Accepted`):

```json
{
  "runId": "…"
}
```

Notes:

- Body is validated with Zod (`task` must be a non-empty string)
- The run is stored in memory and `AgentRunner` starts in the background
- The handler returns as soon as the run id exists; it does not wait for the final report
- No database, auth, Redis, or queue

```bash
npm run build -w @codepilot/api
API_PORT=3001 npm start -w @codepilot/api
```

### `GET /api/runs/:runId/events`

Server-Sent Events stream for one run.

Event names:

- `run_started`
- `step_started`
- `tool_call_started`
- `tool_call_completed`
- `tool_call_failed`
- `run_completed`
- `run_failed`

Notes:

- Correct SSE framing (`id`, `event`, `data`, blank line)
- Connecting after completion replays buffered events and closes
- Failures emit `run_failed` (and `tool_call_failed` when a tool result is an error)
- Client disconnect unsubscribes the in-memory listener
- No WebSockets, Redis, or message broker

## Web UI

Single-page Next.js dashboard in `apps/web`.

Shows:

- task input and start control
- run status
- live SSE timeline
- tool call list
- final report
- error state

The browser only talks to the API (`POST /api/runs`, `GET /api/runs/:runId/events`). It does not contain agent reasoning or MCP logic.

```bash
npm run dev -w @codepilot/web
```

Set `NEXT_PUBLIC_API_URL` (default `http://localhost:3001`) and run the API separately.

## Example run

Task:

```text
Investigate why the volume discount fails at exactly $100.00
```

Typical tool activity:

1. `search_code` for discount / pricing
2. `read_file` on `src/pricing.ts` and the failing test
3. `run_tests` to capture the failure
4. Final JSON report (no code changes)

Example final report shape:

```json
{
  "summary": "Volume discount fails at exactly $100 because the threshold uses a strict greater-than comparison.",
  "rootCause": "applyVolumeDiscount uses `subtotal > 100` instead of `subtotal >= 100`, so $100.00 never qualifies.",
  "filesInspected": ["src/pricing.ts", "tests/pricing.test.ts"],
  "testsExecuted": ["npm test"],
  "testResult": "Failed: volume discount at exactly $100.00 expectation not met.",
  "confidence": "high",
  "uncertainty": [
    "Did not inspect unrelated checkout modules.",
    "No production logs were available."
  ],
  "investigated": [
    "Searched for discount and pricing logic.",
    "Read pricing implementation and failing test.",
    "Ran the repository test suite."
  ],
  "identified": [
    "Failing test asserts a discount at exactly $100.00.",
    "Implementation compares with `>` rather than `>=`."
  ],
  "recommended": [
    "Change the threshold comparison in applyVolumeDiscount from `>` to `>=`.",
    "Re-run npm test after the change."
  ],
  "verified": [
    "Observed the failing test output from run_tests.",
    "Confirmed the comparison operator in the inspected source file."
  ]
}
```

Status vocabulary:

- **Investigated** — what was looked at
- **Identified** — facts supported by tool evidence
- **Recommended** — suggested fixes that were not applied
- **Verified** — outcomes confirmed by tools (for example test results)

The agent never claims to have modified repository files.

## Reliability & Guardrails

`AgentRunner` uses small in-process guardrails only. No Redis, queues, circuit breakers, distributed locks, or databases.

### Maximum 10 steps

- **Problem:** A confused local model can request tools forever.
- **Solution:** Default `maxSteps` is 10. When the limit is hit without a valid `FinalReport`, the run ends in a clean `failed` state.
- **Limitation:** Hard stops may cut off a slow but productive investigation; the limit is intentionally small for MVP demos.

### Tool execution timeout

- **Problem:** An MCP tool (especially `run_tests`) can hang and block the agent process.
- **Solution:** Each tool call is wrapped in a timeout (default 30s). Timeouts become tool error results the model can observe.
- **Limitation:** The underlying child process may keep running after the agent moves on; this is cooperative timeout around the await, not OS-level kill of MCP subprocesses.

### Maximum tool result size

- **Problem:** Huge stdout/search payloads can blow up conversation context and memory.
- **Solution:** Tool result text is truncated to a byte cap (default 32 KiB) before it is stored in state/messages.
- **Limitation:** Truncation can drop the exact evidence the model needed; the agent only sees a capped preview.

### Repeated identical tool-call detection

- **Problem:** Models often retry the same failing or unhelpful tool call with identical arguments.
- **Solution:** Identical tool fingerprints (`name` + stable JSON args) are counted. Exceeding the limit (default 3) fails the run cleanly.
- **Limitation:** Legitimate repeated reads of the same path/query are blocked too; the detector is intentionally simple and local to one run.

### Clean failure state

- **Problem:** Partial failures can leave callers unsure whether a report exists or the run is still active.
- **Solution:** Failures go through `failAgent`: `status=failed`, non-empty `error`, `finalReport=null`, and `error`/`done` events.
- **Limitation:** Clean failure does not roll back earlier tool side effects (for example tests that already ran inside MCP).

### Cancellation

- **Problem:** A UI/API caller may need to stop a long investigation.
- **Solution:** `run(task, { signal })` accepts an `AbortSignal` and checks it between steps/tool calls.
- **Limitation:** Cancellation is cooperative. In-flight MCP work is not forcibly killed; abort is detected at the next await boundary.

## Planned development phases

1. Shared request/event/report schemas
2. MCP server with four tools (`search_code`, `read_file`, `run_tests`, `get_diff`) and path security
3. Agent loop with MCP client (max 10 steps), mocked LLM first
4. Structured final report wiring on top of the Ollama adapter
5. API streaming endpoint wired to the agent
6. Next.js UI for task input, activity stream, and report
7. Hardening (timeouts, output caps) and runbook updates

## Setup

Requirements: Node.js 20+, and Ollama installed locally if you want live LLM calls

```bash
cp .env.example .env
npm install
npm run typecheck
npm run build
```

Pull a model before live runs, for example:

```bash
ollama pull llama3.2
```

## Workspace packages

| Path | Package | Role |
|------|---------|------|
| `apps/web` | `@codepilot/web` | Next.js frontend |
| `apps/api` | `@codepilot/api` | API server |
| `packages/agent` | `@codepilot/agent` | Agent runtime |
| `packages/mcp-server` | `@codepilot/mcp-server` | MCP tool server |
