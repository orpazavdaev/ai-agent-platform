"use client";

import { useEffect, useRef, useState } from "react";
import {
  asFinalReport,
  startRun,
  subscribeToRunEvents,
  summarizeEvent,
  type FinalReportView,
  type RunUiStatus,
  type TimelineItem,
  type ToolCallItem,
} from "@/lib/api";

function statusLabel(status: RunUiStatus): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "error":
      return "Error";
  }
}

export default function DashboardPage() {
  const [task, setTask] = useState(
    "Investigate why the volume discount fails at exactly $100.00",
  );
  const [status, setStatus] = useState<RunUiStatus>("idle");
  const [runId, setRunId] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [toolCalls, setToolCalls] = useState<ToolCallItem[]>([]);
  const [report, setReport] = useState<FinalReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      unsubscribeRef.current?.();
    };
  }, []);

  const canStart =
    task.trim().length > 0 &&
    status !== "starting" &&
    status !== "running";

  function resetRunView() {
    setTimeline([]);
    setToolCalls([]);
    setReport(null);
    setError(null);
  }

  function upsertToolCall(item: ToolCallItem) {
    setToolCalls((current) => {
      const index = current.findIndex((entry) => entry.id === item.id);
      if (index === -1) {
        return [...current, item];
      }
      const next = [...current];
      next[index] = { ...next[index], ...item };
      return next;
    });
  }

  async function onStart() {
    const trimmed = task.trim();
    if (!trimmed) {
      setError("Enter a task before starting a run.");
      setStatus("error");
      return;
    }

    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
    resetRunView();
    setStatus("starting");
    setRunId(null);

    try {
      const { runId: nextRunId } = await startRun(trimmed);
      setRunId(nextRunId);
      setStatus("running");

      unsubscribeRef.current = subscribeToRunEvents(nextRunId, {
        onEvent: (type, data) => {
          setTimeline((current) => [
            ...current,
            {
              id: `${type}-${data.timestamp}-${current.length}`,
              type,
              timestamp: data.timestamp,
              summary: summarizeEvent(type, data.payload),
            },
          ]);

          if (type === "tool_call_started") {
            const payload = data.payload as {
              id?: string;
              name?: string;
              arguments?: Record<string, unknown>;
            } | null;
            if (payload?.id && payload.name) {
              upsertToolCall({
                id: payload.id,
                name: payload.name,
                status: "started",
                timestamp: data.timestamp,
                arguments: payload.arguments,
              });
            }
          }

          if (type === "tool_call_completed" || type === "tool_call_failed") {
            const payload = data.payload as {
              toolCallId?: string;
              name?: string;
              content?: string;
            } | null;
            if (payload?.toolCallId) {
              upsertToolCall({
                id: payload.toolCallId,
                name: payload.name ?? "tool",
                status: type === "tool_call_failed" ? "failed" : "completed",
                timestamp: data.timestamp,
                detail: payload.content,
              });
            }
          }

          if (type === "run_completed") {
            const payload = data.payload as { finalReport?: unknown } | null;
            setReport(asFinalReport(payload?.finalReport));
            setStatus("completed");
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
          }

          if (type === "run_failed") {
            const payload = data.payload as { error?: string } | null;
            setError(payload?.error ?? "Run failed.");
            setStatus("failed");
            unsubscribeRef.current?.();
            unsubscribeRef.current = null;
          }
        },
        onError: (message) => {
          setError(message);
          setStatus((current) =>
            current === "completed" || current === "failed"
              ? current
              : "error",
          );
          unsubscribeRef.current?.();
          unsubscribeRef.current = null;
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run.");
      setStatus("error");
    }
  }

  return (
    <main className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">CodePilot</p>
          <h1>Investigation dashboard</h1>
          <p className="lede">
            Submit a software engineering task. The API starts an agent run and
            streams progress over SSE.
          </p>
        </div>
        <div className={`status status-${status}`} aria-live="polite">
          <span className="status-dot" />
          <div>
            <div className="status-label">{statusLabel(status)}</div>
            <div className="status-meta">
              {runId ? `run ${runId}` : "no active run"}
            </div>
          </div>
        </div>
      </header>

      <section className="panel task-panel">
        <label htmlFor="task">Task</label>
        <textarea
          id="task"
          value={task}
          rows={4}
          onChange={(event) => setTask(event.target.value)}
          placeholder="Describe the investigation task"
        />
        <div className="actions">
          <button
            type="button"
            disabled={!canStart}
            onClick={() => void onStart()}
          >
            {status === "starting" || status === "running"
              ? "Running…"
              : "Start run"}
          </button>
        </div>
      </section>

      {error ? (
        <section className="panel error-panel" role="alert">
          <h2>Error</h2>
          <p>{error}</p>
        </section>
      ) : null}

      <section className="grid">
        <article className="panel">
          <div className="panel-head">
            <h2>Live timeline</h2>
            <span>{timeline.length} events</span>
          </div>
          {timeline.length === 0 ? (
            <p className="empty">
              Events will appear here after you start a run.
            </p>
          ) : (
            <ol className="timeline">
              {timeline.map((item) => (
                <li key={item.id}>
                  <div className="timeline-type">{item.type}</div>
                  <div className="timeline-summary">{item.summary}</div>
                  <time dateTime={item.timestamp}>{item.timestamp}</time>
                </li>
              ))}
            </ol>
          )}
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Tool calls</h2>
            <span>{toolCalls.length} calls</span>
          </div>
          {toolCalls.length === 0 ? (
            <p className="empty">MCP tool activity will show here.</p>
          ) : (
            <ul className="tools">
              {toolCalls.map((call) => (
                <li key={call.id} className={`tool tool-${call.status}`}>
                  <div className="tool-head">
                    <code>{call.name}</code>
                    <span>{call.status}</span>
                  </div>
                  {call.arguments ? (
                    <pre>{JSON.stringify(call.arguments, null, 2)}</pre>
                  ) : null}
                  {call.detail ? (
                    <pre className="tool-detail">{call.detail}</pre>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Final report</h2>
        </div>
        {!report ? (
          <p className="empty">
            The structured final report will render when the run completes.
          </p>
        ) : (
          <div className="report">
            <div className="report-meta">
              <span>Confidence: {report.confidence}</span>
            </div>
            <div>
              <h3>Summary</h3>
              <p>{report.summary}</p>
            </div>
            <div>
              <h3>Root cause</h3>
              <p>{report.rootCause}</p>
            </div>
            <div className="report-grid">
              <div>
                <h3>Files inspected</h3>
                <ul>
                  {report.filesInspected.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Tests executed</h3>
                <ul>
                  {report.testsExecuted.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div>
              <h3>Test result</h3>
              <p>{report.testResult}</p>
            </div>
            <div className="report-grid report-status-grid">
              <div>
                <h3>Investigated</h3>
                <ul>
                  {report.investigated.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Identified</h3>
                <ul>
                  {report.identified.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Recommended</h3>
                <ul>
                  {report.recommended.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Verified</h3>
                <ul>
                  {report.verified.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div>
              <h3>Uncertainty / limitations</h3>
              <ul>
                {report.uncertainty.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
