import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_IDENTICAL_TOOL_CALLS,
  RunCancelledError,
  ToolTimeoutError,
  countIdenticalToolCalls,
  throwIfAborted,
  truncateUtf8,
  withTimeout,
} from "../src/guardrails.js";
import { LlmModelError } from "../src/llm/types.js";
import type { LlmProvider } from "../src/llm/types.js";
import type { AgentMcpPort } from "../src/runner.js";
import { AgentRunner, isCleanFailureState, validateFinalReport } from "../src/runner.js";
import { createAgentState } from "../src/state.js";

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
  summary:
    "Volume discount fails at exactly $100 because the threshold uses a strict greater-than comparison.",
  rootCause:
    "applyVolumeDiscount uses `subtotal > 100` instead of `subtotal >= 100`, so $100.00 never qualifies.",
  filesInspected: [
    "src/pricing.ts",
    "tests/pricing.test.ts",
  ],
  testsExecuted: ["npm test"],
  testResult: "Failed: volume discount at exactly $100.00 expectation not met.",
  confidence: "high",
  uncertainty: [
    "Did not inspect unrelated checkout modules.",
    "No production logs were available.",
  ],
  investigated: [
    "Searched for discount and pricing logic.",
    "Read pricing implementation and failing test.",
    "Ran the repository test suite.",
  ],
  identified: [
    "Failing test asserts a discount at exactly $100.00.",
    "Implementation compares with `>` rather than `>=`.",
  ],
  recommended: [
    "Change the threshold comparison in applyVolumeDiscount from `>` to `>=`.",
    "Re-run npm test after the change.",
  ],
  verified: [
    "Observed the failing test output from run_tests.",
    "Confirmed the comparison operator in the inspected source file.",
  ],
};

describe("guardrail helpers", () => {
  it("counts identical tool calls by name and arguments", () => {
    const calls = [
      { name: "search_code", arguments: { query: "a" } },
      { name: "search_code", arguments: { query: "b" } },
      { name: "search_code", arguments: { query: "a" } },
    ];
    expect(countIdenticalToolCalls(calls, "search_code", { query: "a" })).toBe(
      2,
    );
    expect(DEFAULT_MAX_IDENTICAL_TOOL_CALLS).toBe(3);
  });

  it("treats object key order as identical for tool-call fingerprints", () => {
    const calls = [
      { name: "search_code", arguments: { query: "a", limit: 1 } },
    ];
    expect(
      countIdenticalToolCalls(calls, "search_code", { limit: 1, query: "a" }),
    ).toBe(1);
  });

  it("truncates oversized UTF-8 payloads", () => {
    const result = truncateUtf8("x".repeat(100), 32);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(32);
    expect(result.text).toContain("[truncated]");
  });

  it("times out slow operations", async () => {
    await expect(
      withTimeout(
        new Promise(() => undefined),
        20,
        'Tool "search_code"',
      ),
    ).rejects.toBeInstanceOf(ToolTimeoutError);
  });

  it("honors abort signals", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(RunCancelledError);
  });
});

describe("validateFinalReport", () => {
  it("accepts a complete investigation report", () => {
    const state = createAgentState({ task: "investigate" });
    expect(validateFinalReport(validReport, state)).toEqual(validReport);
  });

  it("rejects reports that claim code was modified", () => {
    const state = createAgentState({ task: "investigate" });
    expect(
      validateFinalReport(
        {
          ...validReport,
          recommended: ["I fixed the comparison operator."],
        },
        state,
      ),
    ).toBeNull();
  });

  it("rejects incomplete reports", () => {
    const state = createAgentState({ task: "investigate" });
    expect(
      validateFinalReport(
        {
          summary: "incomplete",
          rootCause: "missing other fields",
        },
        state,
      ),
    ).toBeNull();
  });

  it("rejects whitespace-only required strings and non-string list items", () => {
    const state = createAgentState({ task: "investigate" });
    expect(
      validateFinalReport(
        {
          ...validReport,
          summary: "   ",
        },
        state,
      ),
    ).toBeNull();
    expect(
      validateFinalReport(
        {
          ...validReport,
          filesInspected: ["src/a.ts", 12],
        },
        state,
      ),
    ).toBeNull();
  });
});

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
    expect(state.finalReport?.summary).toBe(validReport.summary);
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
    expect(state.finalReport?.rootCause).toContain(">=");
    expect(state.finalReport?.recommended[0]).toContain(">=");
    expect(state.finalReport?.verified.length).toBeGreaterThan(0);
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

  it("fails the run on model errors with a clean failure state", async () => {
    const runner = new AgentRunner({
      llm: createScriptedLlm([
        new LlmModelError('Ollama model error for "missing": not found'),
      ]),
      mcp: createMockMcp({}),
    });

    const state = await runner.run("Investigate");

    expect(isCleanFailureState(state)).toBe(true);
    expect(state.error).toMatch(/model error/i);
  });

  it("enforces the maximum step limit", async () => {
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
    expect(isCleanFailureState(state)).toBe(true);
    expect(state.error).toMatch(/maximum of 3 steps/i);
  });

  it("fails cleanly when the final answer is not a valid FinalReport", async () => {
    const runner = new AgentRunner({
      llm: createScriptedLlm([
        { content: "I think the bug is in pricing.ts" },
      ]),
      mcp: createMockMcp({}),
    });

    const state = await runner.run("Investigate");

    expect(isCleanFailureState(state)).toBe(true);
    expect(state.finalReport).toBeNull();
    expect(state.error).toMatch(/valid FinalReport/i);
  });

  it("fails cleanly when MCP tool discovery fails", async () => {
    const runner = new AgentRunner({
      llm: createScriptedLlm([{ content: JSON.stringify(validReport) }]),
      mcp: createMockMcp({
        listTools: async () => {
          throw new Error("stdio disconnected");
        },
      }),
    });

    const state = await runner.run("Investigate");

    expect(isCleanFailureState(state)).toBe(true);
    expect(state.error).toMatch(/Failed to load MCP tools/i);
    expect(state.error).toMatch(/stdio disconnected/);
  });

  it("records MCP callTool throws as tool failures and continues", async () => {
    const runner = new AgentRunner({
      llm: createScriptedLlm([
        {
          toolCalls: [
            {
              id: "throwing",
              name: "search_code",
              arguments: { query: "x" },
            },
          ],
        },
        { content: JSON.stringify(validReport) },
      ]),
      mcp: createMockMcp({
        callTool: async () => {
          throw new Error("transport reset");
        },
      }),
    });

    const state = await runner.run("Investigate");

    expect(state.toolResults[0]?.isError).toBe(true);
    expect(state.toolResults[0]?.content).toMatch(/transport reset/);
    expect(state.status).toBe("completed");
    expect(state.finalReport).not.toBeNull();
  });

  it("enforces tool execution timeout", async () => {
    const runner = new AgentRunner({
      toolTimeoutMs: 30,
      llm: createScriptedLlm([
        {
          toolCalls: [
            { id: "slow", name: "search_code", arguments: { query: "x" } },
          ],
        },
        { content: JSON.stringify(validReport) },
      ]),
      mcp: createMockMcp({
        callTool: async () =>
          await new Promise(() => {
            /* hang */
          }),
      }),
    });

    const state = await runner.run("Investigate");

    expect(state.toolResults[0]?.isError).toBe(true);
    expect(state.toolResults[0]?.content).toMatch(/timed out/i);
    expect(state.status).toBe("completed");
  });

  it("enforces maximum tool result size", async () => {
    const runner = new AgentRunner({
      maxToolResultBytes: 64,
      llm: createScriptedLlm([
        {
          toolCalls: [
            { id: "big", name: "search_code", arguments: { query: "x" } },
          ],
        },
        { content: JSON.stringify(validReport) },
      ]),
      mcp: createMockMcp({
        callTool: async () => ({
          isError: false,
          content: [{ type: "text", text: "y".repeat(5_000) }],
          structuredContent: { blob: "y".repeat(5_000) },
        }),
      }),
    });

    const state = await runner.run("Investigate");

    expect(state.toolResults[0]?.isError).toBe(true);
    expect(state.toolResults[0]?.content).toContain("[truncated]");
    expect(
      Buffer.byteLength(state.toolResults[0]!.content, "utf8"),
    ).toBeLessThanOrEqual(64);
    expect(state.status).toBe("completed");
  });

  it("detects repeated identical tool calls", async () => {
    const callTool = vi.fn(async () => ({
      isError: false,
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
    }));

    const runner = new AgentRunner({
      maxIdenticalToolCalls: 2,
      llm: createScriptedLlm([
        {
          toolCalls: [
            { id: "r1", name: "search_code", arguments: { query: "same" } },
          ],
        },
        {
          toolCalls: [
            { id: "r2", name: "search_code", arguments: { query: "same" } },
          ],
        },
        {
          toolCalls: [
            { id: "r3", name: "search_code", arguments: { query: "same" } },
          ],
        },
      ]),
      mcp: createMockMcp({ callTool }),
    });

    const state = await runner.run("Loop");

    expect(callTool).toHaveBeenCalledTimes(2);
    expect(state.toolCalls).toHaveLength(3);
    expect(isCleanFailureState(state)).toBe(true);
    expect(state.error).toMatch(/repeated identical tool call/i);
  });

  it("allows repeated tool names when arguments differ", async () => {
    const callTool = vi.fn(async () => ({
      isError: false,
      content: [{ type: "text", text: "ok" }],
      structuredContent: { ok: true },
    }));

    const runner = new AgentRunner({
      maxIdenticalToolCalls: 2,
      llm: createScriptedLlm([
        {
          toolCalls: [
            { id: "a1", name: "search_code", arguments: { query: "one" } },
          ],
        },
        {
          toolCalls: [
            { id: "a2", name: "search_code", arguments: { query: "two" } },
          ],
        },
        {
          toolCalls: [
            { id: "a3", name: "search_code", arguments: { query: "three" } },
          ],
        },
        { content: JSON.stringify(validReport) },
      ]),
      mcp: createMockMcp({ callTool }),
    });

    const state = await runner.run("Different queries");

    expect(callTool).toHaveBeenCalledTimes(3);
    expect(state.status).toBe("completed");
    expect(state.finalReport).not.toBeNull();
  });

  it("supports cancellation via AbortSignal", async () => {
    const controller = new AbortController();
    const runner = new AgentRunner({
      llm: createScriptedLlm([
        {
          toolCalls: [
            { id: "c1", name: "search_code", arguments: { query: "a" } },
          ],
        },
        { content: JSON.stringify(validReport) },
      ]),
      mcp: createMockMcp({
        callTool: async () => {
          controller.abort();
          return {
            isError: false,
            content: [{ type: "text", text: "ok" }],
            structuredContent: { ok: true },
          };
        },
      }),
    });

    const state = await runner.run("Cancel me", { signal: controller.signal });

    expect(isCleanFailureState(state)).toBe(true);
    expect(state.error).toMatch(/cancelled/i);
    expect(state.finalReport).toBeNull();
  });
});
