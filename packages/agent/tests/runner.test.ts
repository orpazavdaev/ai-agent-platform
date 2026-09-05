import { describe, expect, it, vi } from "vitest";
import { LlmModelError } from "../src/llm/types.js";
import type { LlmProvider } from "../src/llm/types.js";
import type { AgentMcpPort } from "../src/runner.js";
import { AgentRunner } from "../src/runner.js";

function createScriptedLlm(
  responses: Array<
    | {
        content?: string;
        toolCalls?: Array<{
          id: string;
          name: string;
          arguments?: Record<string, unknown>;
        }>;
      }
    | Error
  >,
): LlmProvider {
  let index = 0;
  return {
    async chat() {
      const next = responses[index];
      index += 1;
      if (!next) {
        throw new Error("LLM script exhausted");
      }
      if (next instanceof Error) {
        throw next;
      }
      return {
        model: "test-model",
        done: true,
        message: {
          role: "assistant",
          content: next.content ?? "",
          toolCalls: next.toolCalls?.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? {},
          })),
        },
      };
    },
  };
}

function createMockMcp(handlers: {
  listTools?: AgentMcpPort["listTools"];
  callTool?: AgentMcpPort["callTool"];
}): AgentMcpPort {
  return {
    listTools:
      handlers.listTools ??
      (async () => [
        {
          name: "search_code",
          description: "Search code",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
      ]),
    callTool:
      handlers.callTool ??
      (async () => ({
        isError: false,
        content: [{ type: "text", text: "ok" }],
        structuredContent: { ok: true },
      })),
  };
}

const validReport = {
  summary: "Found threshold bug",
  findings: ["applyVolumeDiscount uses >"],
  stepsTaken: 1,
  toolsUsed: ["search_code"],
  conclusion: "Change comparison to >=",
  limitations: ["Did not edit files"],
};

describe("AgentRunner", () => {
  it("runs a tool-call loop then finishes with a validated report", async () => {
    const callTool = vi.fn(async () => ({
      isError: false,
      content: [{ type: "text", text: "match" }],
      structuredContent: { matches: [{ path: "src/x.ts", line: 1 }] },
    }));

    const events: string[] = [];
    const runner = new AgentRunner({
      llm: createScriptedLlm([
        {
          toolCalls: [
            {
              id: "call-1",
              name: "search_code",
              arguments: { query: "discount" },
            },
          ],
        },
        { content: JSON.stringify(validReport) },
      ]),
      mcp: createMockMcp({ callTool }),
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    const state = await runner.run("Investigate the discount bug");

    expect(callTool).toHaveBeenCalledWith("search_code", {
      query: "discount",
    });
    expect(state.status).toBe("completed");
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolResults).toHaveLength(1);
    expect(state.finalReport?.summary).toBe("Found threshold bug");
    expect(events).toContain("tool_call");
    expect(events).toContain("tool_result");
    expect(events).toContain("report");
    expect(events).toContain("done");
  });

  it("accepts an immediate final response", async () => {
    const callTool = vi.fn();
    const runner = new AgentRunner({
      llm: createScriptedLlm([{ content: JSON.stringify(validReport) }]),
      mcp: createMockMcp({ callTool }),
    });

    const state = await runner.run("Summarize the issue");

    expect(callTool).not.toHaveBeenCalled();
    expect(state.status).toBe("completed");
    expect(state.currentStep).toBe(1);
    expect(state.finalReport?.conclusion).toContain(">=");
  });

  it("records tool errors and continues the loop", async () => {
    const runner = new AgentRunner({
      llm: createScriptedLlm([
        {
          toolCalls: [
            {
              id: "call-err",
              name: "search_code",
              arguments: { query: "x" },
            },
          ],
        },
        { content: JSON.stringify(validReport) },
      ]),
      mcp: createMockMcp({
        callTool: async () => ({
          isError: true,
          content: [{ type: "text", text: "boom" }],
          structuredContent: { error: { code: "not_found", message: "boom" } },
        }),
      }),
    });

    const state = await runner.run("Investigate");

    expect(state.toolResults[0]?.isError).toBe(true);
    expect(state.status).toBe("completed");
    expect(state.finalReport).not.toBeNull();
  });

  it("fails the run on model errors", async () => {
    const runner = new AgentRunner({
      llm: createScriptedLlm([
        new LlmModelError('Ollama model error for "missing": not found'),
      ]),
      mcp: createMockMcp({}),
    });

    const state = await runner.run("Investigate");

    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/model error/i);
    expect(state.finalReport).toBeNull();
  });

  it("stops after the max step limit", async () => {
    const runner = new AgentRunner({
      maxSteps: 3,
      llm: createScriptedLlm([
        {
          toolCalls: [
            { id: "c1", name: "search_code", arguments: { query: "a" } },
          ],
        },
        {
          toolCalls: [
            { id: "c2", name: "search_code", arguments: { query: "b" } },
          ],
        },
        {
          toolCalls: [
            { id: "c3", name: "search_code", arguments: { query: "c" } },
          ],
        },
      ]),
      mcp: createMockMcp({}),
    });

    const state = await runner.run("Keep searching");

    expect(state.currentStep).toBe(3);
    expect(state.toolCalls).toHaveLength(3);
    expect(state.status).toBe("failed");
    expect(state.error).toMatch(/maximum of 3 steps/i);
    expect(state.finalReport).toBeNull();
  });
});
