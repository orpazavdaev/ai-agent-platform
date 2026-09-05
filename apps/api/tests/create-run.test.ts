import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentState,
  setFinalReport,
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("POST /api/runs", () => {
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

  it("validates the body with Zod and rejects empty tasks", async () => {
    const server = createApiServer({
      executor: {
        async run() {
          return createAgentState({ task: "unused" });
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "   " }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/invalid request body/i);
  });

  it("creates an in-memory run and returns runId immediately", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const store = new InMemoryRunStore();
    const server = createApiServer({
      store,
      createId: () => "run-fixed-id",
      executor: {
        async run(task: string) {
          await gate;
          const state = createAgentState({ task });
          setFinalReport(state, sampleReport("done"));
          return state;
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Investigate pricing" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ runId: "run-fixed-id" });

    const pending = store.get("run-fixed-id");
    expect(pending?.status).toBe("running");
    expect(pending?.task).toBe("Investigate pricing");
    expect(pending?.state).toBeNull();

    release();
    await waitFor(() => store.get("run-fixed-id")?.status === "completed");

    const completed = store.get("run-fixed-id");
    expect(completed?.state?.finalReport?.summary).toBe("done");
  });

  it("starts the agent executor without blocking the response", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const server = createApiServer({
      createId: () => "run-async",
      executor: {
        async run(task: string) {
          started.push(task);
          await gate;
          const state = createAgentState({ task });
          setFinalReport(state, sampleReport("later"));
          return state;
        },
      },
    });
    servers.push(server);
    const baseUrl = await listen(server);

    const startedAt = Date.now();
    const response = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "async task" }),
    });
    const elapsedMs = Date.now() - startedAt;

    expect(response.status).toBe(202);
    expect(elapsedMs).toBeLessThan(500);
    await expect(response.json()).resolves.toEqual({ runId: "run-async" });
    expect(started).toEqual(["async task"]);

    release();
  });
});
