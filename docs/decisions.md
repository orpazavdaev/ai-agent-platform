# Decisions

Architecture and product decisions that are already reflected in the CodePilot implementation. Each entry records what exists today—not speculative future options.

Sources: current packages under `apps/` and `packages/`, plus the companion docs that describe them (`docs/architecture.md`, `docs/agent-design.md`).

---

## Decision: Split UI, API, agent, and MCP into separate packages

### Context

A browser UI, HTTP transport, LLM tool loop, and repository capabilities have different failure modes and trust boundaries.

### Decision

Keep four layers:

- `apps/web` — UI only
- `apps/api` — HTTP/SSE + in-memory runs
- `packages/agent` — runner, state, LLM, MCP client
- `packages/mcp-server` — repository tools + path/command policy

### Alternatives

- Monolith process module with shared imports everywhere
- Put MCP tools inside the agent package
- Put agent reasoning in Next.js route handlers

### Why

Separation of concerns keeps prompts/reasoning out of the UI and MCP server, and keeps repository I/O out of the API/UI. It also makes package tests target one boundary at a time.

### Trade-offs

- More packages and wiring (`REPO_ROOT`, spawn paths, CORS)
- Local demo requires running API and web separately
- Cross-cutting changes touch multiple package boundaries

### When I Would Change This

If the project shrank to a single CLI prototype with no UI/API, or if a different deployment unit forced a combined binary with the same logical boundaries preserved internally.

---

## Decision: Use MCP for repository access

### Context

The agent needs to search, read files, run tests, and inspect diffs against a target repository. Those capabilities must stay separate from LLM prompting and the HTTP/UI layers.

### Decision

Expose repository capabilities through an MCP server (`packages/mcp-server`) and reach them only via an MCP client (`McpClientSession` in `packages/agent`). `AgentRunner` uses `listTools` / `callTool`; it does not open the filesystem or shell directly.

### Alternatives

- Call Node `fs` / `child_process` / `git` directly from `AgentRunner`
- Embed repository helpers inside the API process without MCP

### Why

MCP gives a capability boundary between reasoning and repository I/O, with schema-validated tool inputs on the server. Path security and command policy live in the MCP server. The agent discovers the live tool list instead of hardcoding repository APIs into the loop. This matches the project split: the agent loop selects and interprets tool use; the MCP server only provides capabilities.

### Trade-offs

- Extra process and protocol overhead versus in-process helpers
- Tool surface is limited to what the MCP server registers (four tools today)
- Debugging spans agent + MCP child process
- “Dynamic discovery” still depends on a fixed server registration in this MVP

### When I Would Change This

If the product dropped MCP as a constraint and needed only in-process tools with no separate capability server—or if a different host protocol became the required integration surface.

---

## Decision: Use stdio MCP transport

### Context

The MCP server must run locally next to the agent for an MVP that clones and runs on one machine.

### Decision

Spawn the MCP server as a local child process and speak JSON-RPC over stdin/stdout (`StdioClientTransport` / `serveStdio`). Operational logs go to stderr so stdout stays the protocol channel.

### Alternatives

- HTTP/SSE MCP transport with a listening server
- Multi-client networked MCP hosting

### Why

Stdio matches the common local MCP hosting model, avoids an HTTP listener for tools, and avoids multi-client transport complexity for a single-agent MVP.

### Trade-offs

- One agent session owns one child process lifecycle
- Not suited as a shared multi-tenant tool service
- Process spawn/env wiring is part of the API/agent startup path

### When I Would Change This

If multiple concurrent hosts needed a shared MCP server, or if deployment required a networked tool endpoint instead of a per-run subprocess.

---

## Decision: Single AgentRunner (no multi-agent system)

### Context

The product investigates one software-engineering task per run and returns one structured report.

### Decision

Use one explicit `AgentRunner` loop and one `AgentState` object per run. No sub-agents, orchestrators, or agent-to-agent handoffs.

### Alternatives

- Planner/worker multi-agent graphs
- Specialized agents per tool domain (search agent, test agent, …)

### Why

A single loop keeps control flow, guardrails, and failure modes visible and testable. The MVP scope is one investigation task streaming to one UI—not a multi-agent organization.

### Trade-offs

- No parallel specialized roles
- All reasoning shares one message buffer and step budget
- Complex tasks compete for the same max-steps limit

### When I Would Change This

If product requirements demanded parallel specialized roles with clear handoff contracts—and the single-loop step budget proved insufficient for that workflow.

---

## Decision: No agent framework

### Context

The investigation loop needs LLM chat, tool calls, state, and stopping rules.

### Decision

Implement `AgentRunner` directly against small ports (`LlmProvider`, `AgentMcpPort`) instead of adopting LangChain/LlamaIndex-style agent frameworks (or similar).

### Alternatives

- Adopt an agent framework for planning, memory, and tool routing
- Generate the loop from a framework graph DSL

### Why

An explicit runner keeps the tool-calling loop, guardrails, and clean failure behavior readable in one place. Framework abstractions would hide control flow that this project is meant to demonstrate.

### Trade-offs

- More hand-written orchestration code
- Fewer built-in integrations (memory stores, tool routers, tracers)
- Replacing the loop later means rewriting runner logic, not swapping a framework preset

### When I Would Change This

If a framework clearly reduced maintenance while preserving the same transparent failure modes and MCP-only repository boundary—and the educational value of an explicit loop was no longer a goal.

---

## Decision: Use Ollama as the local LLM backend

### Context

The agent needs a chat + tool-calling model without requiring a cloud API key for the default path.

### Decision

Implement `OllamaProvider` behind `LlmProvider`, configured with `OLLAMA_BASE_URL` and `OLLAMA_MODEL`. Ollama-specific code stays under `packages/agent/src/llm/ollama.ts`.

### Alternatives

- Hosted model APIs (OpenAI-compatible or vendor SDKs) as the default
- Multiple providers wired in from day one

### Why

Ollama runs on the developer machine over a simple HTTP API (`/api/chat`), which fits a clone-and-try local MVP. No paid cloud API key is required in the default path. The small `LlmProvider` interface still allows swapping backends later.

### Trade-offs

- Quality and tool-calling reliability depend on the pulled model and local hardware
- Smaller models may struggle with multi-step investigation
- Larger models need more CPU/GPU/RAM
- The project does not claim strong autonomous performance on every machine

### When I Would Change This

If the default demo needed consistently stronger tool calling than local models provide, or if a hosted API became an accepted default with explicit key configuration.

---

## Decision: No database

### Context

Runs produce short-lived status, events, and a final report for a local operator.

### Decision

Do not introduce PostgreSQL/SQLite/or other durable stores for runs, events, or agent state.

### Alternatives

- Persist runs/events in a database for history and multi-process recovery
- External object storage for reports

### Why

Runs and events are short-lived and local. An in-memory store is enough for the single-process MVP. Avoiding a database keeps setup and failure modes small.

### Trade-offs

- Run history is lost when the API process exits
- No cross-process replay or analytics warehouse
- Horizontal scaling of run state is out of scope

### When I Would Change This

If operators needed durable run history, multi-instance API hosts, or crash recovery across process restarts.

---

## Decision: In-memory agent and run state

### Context

Each investigation needs `AgentState` plus API-side run/SSE buffers.

### Decision

Keep agent state in process memory (`AgentState` helpers) and API run/event/subscriber state in `InMemoryRunStore`. No Redis, queue, or external state library.

### Alternatives

- Redis (or similar) for run events and pub/sub
- Durable workflow engines

### Why

One API process runs the agent and serves SSE. In-memory state tracks lifecycle and subscribers without persistence infrastructure. Matches the “intentionally simple” MVP constraint.

### Trade-offs

- State dies with the process
- Not a multi-worker fan-out design
- SSE is not a durable multi-subscriber bus beyond that process lifetime

### When I Would Change This

If multiple API workers needed shared run state, or if subscribers had to survive API restarts.

---

## Decision: Stream run activity with SSE

### Context

The UI needs a one-way stream of investigation progress (`run_started`, tool activity, completion/failure).

### Decision

Expose `GET /api/runs/:runId/events` as Server-Sent Events with `id` / `event` / `data` framing. The browser uses `EventSource`.

### Alternatives

- WebSockets
- Redis/broker-backed push
- Polling REST for run snapshots only

### Why

Progress is agent→UI only. SSE works over plain HTTP with simple disconnect handling and is enough for a single-user local MVP. WebSockets add bidirectional complexity that is not needed. Brokers add infrastructure overhead for in-process runs.

### Trade-offs

- Not a durable multi-subscriber event bus
- Events live in API process memory for the lifetime of that run
- Clients that miss the live window rely on in-memory replay after the fact (while the process still holds the run)

### When I Would Change This

If the UI needed client→server streaming during a run, or if multiple services required a shared durable event log.

---

## Decision: No `write_file` (investigation only)

### Context

The agent investigates repository issues and returns recommendations.

### Decision

Do not register a `write_file` (or other mutation) MCP tool. The system prompt and `FinalReport` validation forbid claiming that code was modified. Success means a validated investigation report, not a patched tree.

### Alternatives

- Allow the agent to edit files and re-run tests until green
- Add gated write tools with human approval

### Why

Scope is investigation and recommendation. Keeping mutation tools out reduces host risk and keeps the demo honest about what the agent did versus what it suggests.

### Trade-offs

- The agent cannot verify a fix it applies (it cannot apply one)
- Operators must implement recommended changes themselves
- End-to-end “autofix” demos are out of scope

### When I Would Change This

If the product explicitly added controlled mutation (for example write + diff review + approval) with clear security and UX constraints.

---

## Decision: Restricted command execution (`run_tests` / `get_diff`)

### Context

Investigation needs tests and diffs, but unconstrained shell/git from the model is dangerous.

### Decision

- `run_tests` accepts no command input from the LLM; it runs only the host-configured `TEST_COMMAND` argv (metacharacters rejected at parse time)
- `get_diff` runs only a fixed `git diff --no-ext-diff --no-color HEAD` argv
- Both bound timeout and output size

### Alternatives

- Let the model supply arbitrary shell strings
- Allow free-form git subcommands

### Why

An agent that can invent shell strings can turn “run the tests” into arbitrary code execution on the host. Fixed trusted argv keeps execution policy in application config, not in model output.

### Trade-offs

- Cannot run ad-hoc commands the model invents
- `TEST_COMMAND` must be configured correctly for the target repo
- Some legitimate workflows need a config change instead of a prompt change
- Safety still depends on the operator: a dangerous `TEST_COMMAND` remains dangerous
- On Windows, `.cmd`/`.bat` trusted binaries may use `shell: true` because Node cannot spawn them otherwise; argv stays fixed and metacharacter-checked
- Path guards do not replace command policy

### When I Would Change This

If a tightly allowlisted command palette (still not free-form shell) became necessary—and each entry remained host-configured, validated, and audited like `TEST_COMMAND` today.

---

## Decision: Structured `FinalReport` instead of free-form final prose

### Context

A multi-step investigation needs a stable UI/API contract for completion, not only chat text.

### Decision

Require a JSON `FinalReport` with fixed fields (`summary`, `rootCause`, files/tests fields, `confidence`, `uncertainty`, and investigated/identified/recommended/verified arrays). Validate before `completed`. Reject obvious first-person “I modified/fixed…” claims with a heuristic.

### Alternatives

- Accept free-form markdown as the final answer
- Stream partial natural-language conclusions without schema

### Why

Structured output makes the dashboard and SSE `run_completed` payload deterministic enough to render sections. The claim vocabulary forces separation between evidence, recommendation, and verification. The no-modification heuristic supports the investigation-only product rule.

### Trade-offs

- Invalid JSON fails the whole run even if the model “knew” the answer in prose
- Local models may struggle to emit valid schema consistently
- The modification-claim regex is heuristic and incomplete
- Schema evolution requires coordinated agent, API consumers, and UI updates

### When I Would Change This

If report consumers needed richer typed schemas (shared package), graded confidence enums, or human-editable report drafts before completion.

---

## Decision: Keep `search_code` as a simple recursive walk

### Context

The agent needs text search under `REPO_ROOT`.

### Decision

Implement `search_code` as a plain recursive filesystem walk with substring matching (skip common generated directories; cap results). Do not depend on ripgrep or an index.

### Alternatives

- Shell out to `rg` / `grep`
- Embed a search index

### Why

Fewer native dependencies and clearer security review for an MVP: search stays inside the same path-guarded tree and Node process model as `read_file`.

### Trade-offs

- Slower and less featureful than ripgrep (no advanced regex engine parity, weaker large-repo performance)
- Result quality depends on simple substring matching and caps
- May miss or over-match compared with a dedicated code search tool

### When I Would Change This

If demo repos or real targets became large enough that walk latency dominated runs—and an allowlisted `rg` invocation or indexed search could stay within the same MCP tool contract and path boundary.
