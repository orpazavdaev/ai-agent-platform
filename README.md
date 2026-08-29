# CodePilot Agent

Production-oriented but intentionally simple AI software engineering agent. It will investigate software engineering tasks with an LLM and MCP repository tools, stream activity to a Next.js UI, and return a structured final report.

## Current status

Initial workspace scaffold only.

- npm workspaces configured
- TypeScript (ESM) baselines in place
- Package and app shells created
- No agent loop, MCP tools, or API routes yet

## High-level architecture

```
apps/web            UI — no agent logic
apps/api            Thin HTTP/SSE layer — no agent reasoning
packages/agent      LLM + MCP client + explicit agent loop
packages/mcp-server Repository tools only — no LLM logic
test-repository     Standalone sample repo for agent investigation demos
```

## Test repository

`test-repository/` is a small, standalone TypeScript project (`mini-checkout`). It is not part of the npm workspaces.

CodePilot will use it as the target codebase when demonstrating or testing agent investigation: the agent should inspect source and tests there through MCP tools, not through the main monorepo packages.

It ships with an intentional, deterministic pricing bug so a failing test suite gives the agent a concrete software engineering task.

```bash
cd test-repository
npm install
npm test
```

Planned boundaries:

- Frontend does not contain agent logic
- API does not contain agent reasoning logic
- Agent does not access the filesystem directly
- Repository access goes through MCP tools
- MCP server does not contain LLM reasoning logic

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
