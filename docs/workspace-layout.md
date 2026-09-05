# Workspace layout

Current repository layout for CodePilot Agent:

```
apps/web            Next.js frontend (scaffold)
apps/api            HTTP API (`POST /api/runs`, in-memory runs)
packages/agent      MCP client + state + Ollama adapter + AgentRunner
packages/mcp-server Stdio MCP server (four repo tools + path security)
test-repository     Standalone sample app (`mini-checkout`) for agent demos
docs                Project documentation
```

```mermaid
flowchart LR
  agent["packages/agent"] -->|stdio MCP| mcp["packages/mcp-server"]
  mcp -->|REPO_ROOT only| repo["test-repository"]
```

## MCP repository tools

- `search_code`: plain recursive filesystem walk and substring match (no ripgrep dependency).
- `read_file`: reads one file through `resolveRepoPath`, with a size cap and structured error codes.
- `run_tests`: fixed application-configured argv only (`TEST_COMMAND`); no LLM-supplied shell; timeout + bounded output.
- `get_diff`: fixed `git diff ... HEAD` only; empty-diff and non-git handling; bounded output.

Install and run the sample separately:

```bash
cd test-repository && npm install && npm test
```
