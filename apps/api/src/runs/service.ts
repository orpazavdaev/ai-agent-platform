import type { AgentState } from "@codepilot/agent";
import { InMemoryRunStore } from "./store.js";

export type AgentExecutor = {
  run(task: string): Promise<AgentState>;
};

export type RunsService = {
  createRun(task: string): { runId: string };
  getRun(runId: string): ReturnType<InMemoryRunStore["get"]>;
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
        .run(task)
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
  };
}
