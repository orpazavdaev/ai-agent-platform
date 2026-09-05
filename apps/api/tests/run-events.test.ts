import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginStep,
  createAgentState,
  failAgent,
  recordToolCall,
  recordToolResult,
  setFinalReport,
  type AgentEvent,
  type FinalReport,
} from "@codepilot/agent";
import { createApiServer } from "../src/server.js";
import { InMemoryRunStore } from "../src/runs/store.js";

const sampleReport = (summary: string): FinalReport => ({
  summary,
  rootCause: "example root cause",
  filesInspected: [],
  testsExecuted: [],
  testResult: "not run",
  confidence: "medium",
  uncertainty: [],
  investigated: [],
  identified: [],
  recommended: [],
  verified: [],
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }
  return `http://127.0.0.1:${address.port}`;
}

function parseSseChunk(chunk: string): Array<{ event: string; data: string; id?: string }> {
  return chunk
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      let event = "message";
      let data = "";
      let id: string | undefined;
      for (const line of lines) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data = line.slice(5).trim();
        } else if (line.startsWith("id:")) {
          id = line.slice(3).trim();
        }
      }
      return { event, data, id };
    });
}

async function readSseUntilTerminal(
  response: Response,
): Promise<Array<{ event: string; data: string; id?: string }>> {
  if (!response.body) {
    throw new Error("Missing SSE body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ event: string; data: string; id?: string }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      events.push(...parseSseChunk(`${part}\n\n`));
    }
    if (
      events.some(
        (event) =>
          event.event === "run_completed" || event.event === "run_failed",
      )
    ) {
      break;
    }
  }

  return events;
}

describe("GET /api/runs/:runId/events", () => {
  const servers: http.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  });

  it("streams mapped agent events over SSE for a live run", async () => {
    let emit!: (event: AgentEvent) => void;
    let finish!: (state: ReturnType<typeof createAgentState>) => void;

    const server = createApiServer({
      createId: () => "run-live",
      executor: {
        async run(task, options) {
          emit = (event) => options?.onEvent?.(event);
          return await new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const createResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "stream me" }),
    });
    expect(createResponse.status).toBe(202);

    const streamPromise = fetch(`${baseUrl}/api/runs/run-live/events`).then(
      (response) => {
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toMatch(
          /text\/event-stream/,
        );
        return readSseUntilTerminal(response);
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const state = createAgentState({ task: "stream me" });
    beginStep(state);
    emit(state.events.at(-1)!);
    recordToolCall(state, {
      id: "c1",
      name: "search_code",
      arguments: { query: "x" },
    });
    emit(state.events.find((event) => event.type === "tool_call")!);
    recordToolResult(state, {
      toolCallId: "c1",
      name: "search_code",
      isError: false,
      content: "{}",
    });
    emit(state.events.find((event) => event.type === "tool_result")!);
    setFinalReport(state, sampleReport("done"));
    finish(state);

    const events = await streamPromise;
    const names = events.map((event) => event.event);
    expect(names[0]).toBe("run_started");
    expect(names).toContain("step_started");
    expect(names).toContain("tool_call_started");
    expect(names).toContain("tool_call_completed");
    expect(names.at(-1)).toBe("run_completed");
    expect(events[0]?.id).toBe("1");
    expect(events[0]?.data).toContain("run-live");

    const completed = events.find((event) => event.event === "run_completed");
    expect(completed).toBeDefined();
    const completedPayload = JSON.parse(completed!.data) as {
      payload: { finalReport?: { summary?: string } };
    };
    expect(completedPayload.payload.finalReport?.summary).toBe("done");
  });

  it("replays events for an already completed run and closes", async () => {
    const store = new InMemoryRunStore();
    const server = createApiServer({
      store,
      createId: () => "run-done",
      executor: {
        async run(task) {
          const state = createAgentState({ task });
          beginStep(state);
          setFinalReport(state, sampleReport("already done"));
          return state;
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "done task" }),
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.get("run-done")?.status).toBe("completed");

    const response = await fetch(`${baseUrl}/api/runs/run-done/events`);
    const events = await readSseUntilTerminal(response);
    expect(events.map((event) => event.event)).toEqual([
      "run_started",
      "run_completed",
    ]);
  });

  it("streams run_failed for failed runs", async () => {
    const server = createApiServer({
      createId: () => "run-fail",
      executor: {
        async run(task, options) {
          const state = createAgentState({ task });
          beginStep(state);
          options?.onEvent?.(state.events.at(-1)!);
          recordToolCall(state, {
            id: "bad",
            name: "search_code",
            arguments: { query: "x" },
          });
          options?.onEvent?.(
            state.events.find((event) => event.type === "tool_call")!,
          );
          recordToolResult(state, {
            toolCallId: "bad",
            name: "search_code",
            isError: true,
            content: "boom",
          });
          options?.onEvent?.(
            state.events.find((event) => event.type === "tool_result")!,
          );
          failAgent(state, "investigation failed");
          return state;
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "fail task" }),
    });

    const response = await fetch(`${baseUrl}/api/runs/run-fail/events`);
    const events = await readSseUntilTerminal(response);
    const names = events.map((event) => event.event);
    expect(names).toContain("tool_call_failed");
    expect(names.at(-1)).toBe("run_failed");

    const failed = events.find((event) => event.event === "run_failed");
    expect(failed).toBeDefined();
    const failedPayload = JSON.parse(failed!.data) as {
      payload: { error?: string };
    };
    expect(failedPayload.payload.error).toBe("investigation failed");
  });

  it("emits run_failed when the executor throws", async () => {
    const server = createApiServer({
      createId: () => "run-throw",
      executor: {
        async run() {
          throw new Error("executor exploded");
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "throw task" }),
    });

    const response = await fetch(`${baseUrl}/api/runs/run-throw/events`);
    const events = await readSseUntilTerminal(response);
    expect(events.map((event) => event.event)).toEqual([
      "run_started",
      "run_failed",
    ]);

    const failedPayload = JSON.parse(events[1]!.data) as {
      payload: { error?: string };
    };
    expect(failedPayload.payload.error).toBe("executor exploded");
  });

  it("returns 404 for unknown runs", async () => {
    const server = createApiServer({
      executor: {
        async run(task) {
          return createAgentState({ task });
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/runs/missing/events`);
    expect(response.status).toBe(404);
  });

  it("handles client disconnect without throwing", async () => {
    let finish!: (state: ReturnType<typeof createAgentState>) => void;
    const server = createApiServer({
      createId: () => "run-disconnect",
      executor: {
        async run() {
          return await new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "disconnect" }),
    });

    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/runs/run-disconnect/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    controller.abort();

    finish(
      (() => {
        const state = createAgentState({ task: "disconnect" });
        setFinalReport(state, sampleReport("done"));
        return state;
      })(),
    );
  });
});
