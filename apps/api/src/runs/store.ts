import { randomUUID } from "node:crypto";
import type { AgentState } from "@codepilot/agent";

export type RunStatus = "running" | "completed" | "failed";

export type RunRecord = {
  id: string;
  task: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  state: AgentState | null;
  error?: string;
};

export class InMemoryRunStore {
  private readonly runs = new Map<string, RunRecord>();

  create(task: string, id: string = randomUUID()): RunRecord {
    const now = new Date().toISOString();
    const record: RunRecord = {
      id,
      task,
      status: "running",
      createdAt: now,
      updatedAt: now,
      state: null,
    };
    this.runs.set(id, record);
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  complete(id: string, state: AgentState): RunRecord {
    const existing = this.runs.get(id);
    if (!existing) {
      throw new Error(`Unknown run id: ${id}`);
    }
    const updated: RunRecord = {
      ...existing,
      status: state.status === "failed" ? "failed" : "completed",
      state,
      updatedAt: new Date().toISOString(),
      error: state.error,
    };
    this.runs.set(id, updated);
    return updated;
  }

  fail(id: string, error: string): RunRecord {
    const existing = this.runs.get(id);
    if (!existing) {
      throw new Error(`Unknown run id: ${id}`);
    }
    const updated: RunRecord = {
      ...existing,
      status: "failed",
      updatedAt: new Date().toISOString(),
      error,
    };
    this.runs.set(id, updated);
    return updated;
  }
}
