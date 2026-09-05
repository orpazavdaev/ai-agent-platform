import { randomUUID } from "node:crypto";
import type { AgentState } from "@codepilot/agent";
import {
  isTerminalStreamEvent,
  type StreamEvent,
  type StreamEventType,
} from "./events.js";

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

type Listener = (event: StreamEvent) => void;

export class InMemoryRunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly events = new Map<string, StreamEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();

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
    this.events.set(id, []);
    this.listeners.set(id, new Set());
    this.appendEvent(id, "run_started", { task });
    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  listEvents(id: string): StreamEvent[] {
    return [...(this.events.get(id) ?? [])];
  }

  appendEvent(
    runId: string,
    type: StreamEventType,
    payload?: unknown,
  ): StreamEvent {
    const existing = this.events.get(runId);
    if (!existing) {
      throw new Error(`Unknown run id: ${runId}`);
    }

    const event: StreamEvent = {
      id: existing.length + 1,
      type,
      runId,
      timestamp: new Date().toISOString(),
      payload,
    };
    existing.push(event);

    const listeners = this.listeners.get(runId);
    if (listeners) {
      for (const listener of listeners) {
        listener(event);
      }
    }

    return event;
  }

  subscribe(runId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(runId);
    if (!listeners) {
      throw new Error(`Unknown run id: ${runId}`);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  complete(id: string, state: AgentState): RunRecord {
    const existing = this.runs.get(id);
    if (!existing) {
      throw new Error(`Unknown run id: ${id}`);
    }

    const failed = state.status === "failed";
    const updated: RunRecord = {
      ...existing,
      status: failed ? "failed" : "completed",
      state,
      updatedAt: new Date().toISOString(),
      error: state.error,
    };
    this.runs.set(id, updated);

    if (!this.hasTerminalEvent(id)) {
      if (failed) {
        this.appendEvent(id, "run_failed", {
          error: state.error ?? "Agent run failed.",
        });
      } else {
        this.appendEvent(id, "run_completed", {
          finalReport: state.finalReport,
        });
      }
    }

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

    if (!this.hasTerminalEvent(id)) {
      this.appendEvent(id, "run_failed", { error });
    }

    return updated;
  }

  private hasTerminalEvent(runId: string): boolean {
    const events = this.events.get(runId) ?? [];
    return events.some((event) => isTerminalStreamEvent(event.type));
  }
}
