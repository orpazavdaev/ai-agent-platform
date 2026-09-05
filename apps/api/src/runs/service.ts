import type { AgentEvent, AgentState } from "@codepilot/agent";
import { mapAgentEventToStreamType } from "./map-agent-event.js";
import { InMemoryRunStore } from "./store.js";

export type AgentExecutor = {
  run(
    task: string,
    options?: { onEvent?: (event: AgentEvent) => void },
  ): Promise<AgentState>;
};

export type RunsService = {
  createRun(task: string): { runId: string };
  getRun(runId: string): ReturnType<InMemoryRunStore["get"]>;
  listEvents(runId: string): ReturnType<InMemoryRunStore["listEvents"]>;
  subscribe(
    runId: string,
    listener: Parameters<InMemoryRunStore["subscribe"]>[1],
  ): () => void;
};

export function createRunsService(options: {
  executor: AgentExecutor;
  store?: InMemoryRunStore;
  createId?: () => string;
}): RunsService {
  const store = options.store ?? new InMemoryRunStore();
  const createId = options.createId ?? (() => crypto.randomUUID());

  return {
    createRun(task: string): { runId: string } {
      const run = store.create(task, createId());

      void options.executor
        .run(task, {
          onEvent: (event) => {
            const type = mapAgentEventToStreamType(event);
            if (type) {
              store.appendEvent(run.id, type, event.payload);
            }
          },
        })
        .then((state) => {
          store.complete(run.id, state);
        })
        .catch((error: unknown) => {
          store.fail(
            run.id,
            error instanceof Error ? error.message : "Agent run failed.",
          );
        });

      return { runId: run.id };
    },
    getRun(runId: string) {
      return store.get(runId);
    },
    listEvents(runId: string) {
      return store.listEvents(runId);
    },
    subscribe(runId, listener) {
      return store.subscribe(runId, listener);
    },
  };
}
