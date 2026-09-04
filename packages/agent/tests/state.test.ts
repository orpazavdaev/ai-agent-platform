import { describe, expect, it } from "vitest";
import {
  AgentStateError,
  appendMessage,
  beginStep,
  createAgentState,
  endStep,
  failAgent,
  recordToolCall,
  recordToolResult,
  setAgentStatus,
  setFinalReport,
} from "../src/state.js";

describe("createAgentState", () => {
  it("creates in-memory idle state for a task", () => {
    const state = createAgentState({ task: "  fix pricing bug  " });

    expect(state.task).toBe("fix pricing bug");
    expect(state.messages).toEqual([]);
    expect(state.currentStep).toBe(0);
    expect(state.status).toBe("idle");
    expect(state.toolCalls).toEqual([]);
    expect(state.finalReport).toBeNull();
    expect(state.maxSteps).toBe(10);
    expect(state.events[0]).toMatchObject({
      type: "status",
      step: 0,
      payload: { status: "idle" },
    });
  });

  it("rejects invalid task and maxSteps", () => {
    expect(() => createAgentState({ task: "" })).toThrow(AgentStateError);
    expect(() => createAgentState({ task: "ok", maxSteps: 0 })).toThrow(
      /positive integer/,
    );
  });
});

describe("agent state behavior", () => {
  it("appends messages and tracks status transitions", () => {
    const state = createAgentState({ task: "investigate" });
    appendMessage(state, { role: "user", content: "investigate" });
    setAgentStatus(state, "running");

    expect(state.messages).toHaveLength(1);
    expect(state.status).toBe("running");
    expect(state.events.at(-1)).toMatchObject({
      type: "status",
      payload: { status: "running" },
    });
  });

  it("records steps, tool calls, and tool results", () => {
    const state = createAgentState({ task: "investigate" });
    beginStep(state, "search for discount logic");

    expect(state.currentStep).toBe(1);
    expect(state.status).toBe("running");
    expect(state.steps[0]).toMatchObject({
      index: 1,
      thought: "search for discount logic",
    });

    const call = recordToolCall(state, {
      id: "call-1",
      name: "search_code",
      arguments: { query: "discount" },
    });

    expect(call.step).toBe(1);
    expect(state.status).toBe("waiting_for_tool");
    expect(state.toolCalls).toHaveLength(1);
    expect(state.steps[0]?.toolCallIds).toEqual(["call-1"]);

    const result = recordToolResult(state, {
      toolCallId: "call-1",
      name: "search_code",
      isError: false,
      content: '{"matches":[]}',
      structuredContent: { matches: [] },
    });

    expect(result.step).toBe(1);
    expect(state.status).toBe("running");
    expect(state.toolResults).toHaveLength(1);

    endStep(state);
    expect(state.steps[0]?.finishedAt).toEqual(expect.any(String));
  });

  it("rejects tool results for unknown calls and steps past max", () => {
    const state = createAgentState({ task: "investigate", maxSteps: 1 });
    beginStep(state);

    expect(() =>
      recordToolResult(state, {
        toolCallId: "missing",
        name: "read_file",
        isError: true,
        content: "nope",
      }),
    ).toThrow(/Unknown toolCallId/);

    endStep(state);
    expect(() => beginStep(state)).toThrow(/maxSteps/);
  });

  it("stores a final report and marks completion", () => {
    const state = createAgentState({ task: "investigate" });
    beginStep(state);
    recordToolCall(state, { id: "c1", name: "run_tests" });
    recordToolResult(state, {
      toolCallId: "c1",
      name: "run_tests",
      isError: false,
      content: "ok",
    });
    endStep(state);

    setFinalReport(state, {
      summary: "Threshold comparison bug",
      findings: ["applyVolumeDiscount uses > instead of >="],
      stepsTaken: state.currentStep,
      toolsUsed: ["run_tests"],
      conclusion: "Change the comparison to >=",
      limitations: ["Did not patch the file"],
    });

    expect(state.status).toBe("completed");
    expect(state.finalReport?.summary).toBe("Threshold comparison bug");
    expect(state.events.some((event) => event.type === "report")).toBe(true);
    expect(state.events.at(-1)?.type).toBe("done");
  });

  it("records failure state", () => {
    const state = createAgentState({ task: "investigate" });
    failAgent(state, "MCP disconnected");

    expect(state.status).toBe("failed");
    expect(state.error).toBe("MCP disconnected");
    expect(state.finalReport).toBeNull();
    expect(state.events.some((event) => event.type === "error")).toBe(true);
  });
});
