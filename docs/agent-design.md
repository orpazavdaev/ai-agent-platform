# Agent design

Current scope: in-memory agent state/types, MCP client, and Ollama LLM adapter. No agent loop yet.

## State model

```mermaid
stateDiagram-v2
  [*] --> idle
  idle --> running: beginStep / setAgentStatus
  running --> waiting_for_tool: recordToolCall
  waiting_for_tool --> running: recordToolResult
  running --> completed: setFinalReport
  running --> failed: failAgent
  waiting_for_tool --> failed: failAgent
  completed --> [*]
  failed --> [*]
```

### Core types

| Type | Role |
|------|------|
| `AgentState` | In-memory run state for one investigation task |
| `AgentStatus` | `idle` \| `running` \| `waiting_for_tool` \| `completed` \| `failed` |
| `AgentStep` | One loop iteration (`index`, optional thought, tool call ids, timestamps) |
| `ToolCall` | Requested MCP tool invocation |
| `ToolResult` | MCP tool response linked by `toolCallId` |
| `AgentEvent` | Append-only streamable timeline entry |
| `FinalReport` | Structured outcome written when the run completes |

### `AgentState` fields

- `task` — investigation request
- `messages` — conversation buffer for the future LLM loop
- `currentStep` — latest step index (`0` before the first step)
- `status` — lifecycle status above
- `steps` — step records
- `toolCalls` / `toolResults` — tool activity for the run
- `events` — ordered events for UI/API streaming later
- `finalReport` — `null` until completion
- `maxSteps` — hard cap (default `10`)

State lives in process memory only. Helpers in `packages/agent/src/state.ts` mutate a single `AgentState` object; there is no database or external state library.

## LLM adapter

The agent depends on a small provider-neutral `LlmProvider` (`chat(messages, tools?)`). The only implemented backend is Ollama (`packages/agent/src/llm/ollama.ts`), configured with `OLLAMA_BASE_URL` and `OLLAMA_MODEL`. Tool definitions are forwarded when the local model supports tool calling; connection and missing-model failures map to explicit error types.
