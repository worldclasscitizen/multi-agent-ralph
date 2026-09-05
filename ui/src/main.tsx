import React, { useEffect, useState, useMemo } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  type NodeProps,
} from "@xyflow/react";
import type ELKType from "elkjs/lib/elk.bundled.js";
declare const ELK: typeof ELKType;
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { projectEvent } from "./projection";
import { VirtualLog } from "./virtual-log";
type Row = Record<string, any>;
const api = async (path: string) => {
  const r = await fetch(`/api/v2/${path}`);
  if (!r.ok) throw new Error((await r.json()).error);
  return r.json();
};
function Card({ data }: NodeProps) {
  const d = data as Row;
  return (
    <div
      className={`node ${d.status ?? "pending"}`}
      tabIndex={0}
      role="button"
      aria-label={`Inspect ${d.label}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          d.onInspect?.();
        }
      }}
    >
      <Handle type="target" position={Position.Left} />
      <span className="eyebrow">
        {d.kind} · {d.status ?? "pending"}
      </span>
      <strong>{d.label}</strong>
      <div className="node-meta">
        {d.modelId ??
          (d.kind === "integrate"
            ? "Local Git integration"
            : "Awaiting assignment")}
        <span>
          Iteration {d.iteration ?? 0}
          {d.startedAt
            ? ` · ${Math.max(0, Math.round((Date.parse(d.endedAt ?? new Date().toISOString()) - Date.parse(d.startedAt)) / 1000))}s`
            : ""}
        </span>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
const nodeTypes = { task: Card };
const elk = new ELK();
function App() {
  const [runs, setRuns] = useState<Row[]>([]),
    [selected, setSelected] = useState(""),
    [view, setView] = useState("runs"),
    [run, setRun] = useState<Row>(),
    [graph, setGraph] = useState<Row>(),
    [positions, setPositions] = useState<
      Record<string, { x: number; y: number }>
    >({}),
    [node, setNode] = useState(""),
    [detail, setDetail] = useState<Row>(),
    [artifact, setArtifact] = useState<Row>(),
    [metrics, setMetrics] = useState<Row[]>([]),
    [providers, setProviders] = useState<Row[]>([]),
    [error, setError] = useState(""),
    [revision, setRevision] = useState("latest");
  const loadRuns = () =>
    api("runs")
      .then((x) => setRuns(x.runs))
      .catch((e) => setError(e.message));
  useEffect(() => {
    loadRuns();
    const t = setInterval(loadRuns, 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!selected && runs.find((r) => !r.legacy))
      setSelected(runs.find((r) => !r.legacy)!.runId);
  }, [runs, selected]);
  useEffect(() => {
    if (view === "metrics")
      Promise.all([api("metrics"), api("providers")])
        .then(([m, p]) => {
          setMetrics(m);
          setProviders(p);
        })
        .catch((e) => setError(e.message));
  }, [view]);
  useEffect(() => {
    if (!selected) return;
    let stream: EventSource | undefined,
      cancelled = false,
      refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    const query = revision === "latest" ? "" : `?revision=${revision}`;
    const refresh = async () => {
      const [s, g] = await Promise.all([
        api(`runs/${selected}${query}`),
        api(`runs/${selected}/graph${query}`),
      ]);
      if (cancelled) return;
      cursor = s.seq;
      setRun(s);
      setGraph(g);
    };
    api(`runs/${selected}${query}`)
      .then((s) => {
        if (cancelled) return;
        cursor = s.seq;
        setRun(s);
        return api(`runs/${selected}/graph${query}`).then((g) => {
          if (cancelled) return;
          setGraph(g);
          if (revision !== "latest") return;
          stream = new EventSource(
            `/api/v2/runs/${selected}/events?after=${s.seq}`,
          );
          stream.addEventListener("ralph", (message) => {
            const event = JSON.parse((message as MessageEvent).data);
            if (event.seq <= cursor) return;
            if (event.seq === cursor + 1) {
              cursor = event.seq;
              setRun((current) =>
                current ? projectEvent(current, event) : current,
              );
              if (event.type === "graph.revised") setGraph(event.payload.graph);
              return;
            }
            if (!refreshTimer)
              refreshTimer = setTimeout(() => {
                refreshTimer = undefined;
                refresh().catch((e) => setError(e.message));
              }, 100);
          });
          stream.onerror = () => {
            if (!cancelled) refresh().catch((e) => setError(e.message));
          };
        });
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      stream?.close();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [selected, revision]);
  useEffect(() => {
    if (!graph) return;
    let cancelled = false;
    elk
      .layout({
        id: "root",
        layoutOptions: {
          "elk.algorithm": "layered",
          "elk.direction": "RIGHT",
          "elk.spacing.nodeNode": "40",
          "elk.layered.spacing.nodeNodeBetweenLayers": "70",
        },
        children: graph.nodes.map((n: Row) => ({
          id: n.nodeId,
          width: 240,
          height: 110,
        })),
        edges: graph.edges.map((e: Row, i: number) => ({
          id: `e${i}`,
          sources: [e.from],
          targets: [e.to],
        })),
      })
      .then((g) => {
        if (!cancelled)
          setPositions(
            Object.fromEntries(
              g.children!.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]),
            ),
          );
      });
    return () => {
      cancelled = true;
    };
  }, [graph?.revision, selected]);
  useEffect(() => {
    if (!node || !selected) return;
    api(
      `runs/${selected}/nodes/${node}${revision === "latest" ? "" : `?revision=${revision}`}`,
    )
      .then(setDetail)
      .catch((e) => setError(e.message));
  }, [node, selected, run?.seq]);
  const nodes = useMemo(
    () =>
      graph?.nodes.map((n: Row) => ({
        id: n.nodeId,
        type: "task",
        position: positions[n.nodeId] ?? { x: 0, y: 0 },
        data: {
          ...n,
          label: n.nodeId,
          ...run?.nodes[n.nodeId],
          onInspect: () => {
            setNode(n.nodeId);
            setArtifact(undefined);
          },
        },
      })) ?? [],
    [graph, positions, run],
  );
  const edges = useMemo(
    () =>
      graph?.edges.map((e: Row, i: number) => ({
        id: `e${i}`,
        source: e.from,
        target: e.to,
        type: "smoothstep",
        animated: run?.nodes[e.to]?.status === "running",
      })) ?? [],
    [graph, run],
  );
  const command = async (type: string) => {
    try {
      const { controlToken } = await api("session");
      const r = await fetch(`/api/v2/runs/${selected}/commands`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Ralph-Token": controlToken,
        },
        body: JSON.stringify({
          commandId: crypto.randomUUID(),
          expectedRevision: run?.revision,
          type,
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error);
      await loadRuns();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div
      className="shell"
      onKeyDown={(e) => {
        if (e.key === "Escape") setNode("");
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">R</span>
          <div>
            <b>Ralph</b>
            <small>Graph Control Center</small>
          </div>
          <span className="version">0.3</span>
        </div>
        <nav>
          <button
            className={view === "runs" ? "active" : ""}
            onClick={() => setView("runs")}
          >
            ◈ Execution runs
          </button>
          <button
            className={view === "metrics" ? "active" : ""}
            onClick={() => setView("metrics")}
          >
            ▥ Providers & usage
          </button>
        </nav>
        <div className="sidebar-title">
          LOCAL HISTORY <span>{runs.length}</span>
        </div>
        <div className="run-list">
          {runs.map((r) => (
            <button
              key={r.runId}
              className={`run-item ${selected === r.runId ? "selected" : ""}`}
              onClick={() => {
                if (r.legacy) {
                  setError(
                    "Legacy history is available through ralph history and migration.",
                  );
                  return;
                }
                setSelected(r.runId);
                setRevision("latest");
                setNode("");
                setArtifact(undefined);
                setView("runs");
              }}
            >
              <span className={`dot ${r.status}`} />
              <div>
                <strong>{r.goal ?? r.runId}</strong>
                <small>
                  {r.legacy ? "Legacy · " : ""}
                  {r.status} · {new Date(r.startedAt).toLocaleDateString()}
                </small>
              </div>
            </button>
          ))}
        </div>
        <footer>Local evidence · Git-backed execution</footer>
      </aside>
      <main>
        {error && (
          <div role="alert" className="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {view === "runs" ? (
          <>
            <header>
              <div>
                <div className="eyebrow">EXECUTION WORKSPACE</div>
                <h1>
                  {runs.find((r) => r.runId === selected)?.goal ??
                    "Your next run starts here"}
                </h1>
                <p>{selected || "Run ralph plan in a Git project to begin."}</p>
              </div>
              <div className="actions">
                <button
                  onClick={() => command("stop")}
                  disabled={revision !== "latest" || run?.status !== "running"}
                >
                  Stop safely
                </button>
                <button
                  onClick={() => command("resume")}
                  disabled={
                    revision !== "latest" ||
                    !run ||
                    !["paused", "awaiting_input", "failed"].includes(run.status)
                  }
                >
                  Resume
                </button>
              </div>
            </header>
            <div className="summary">
              <div>
                <small>STATUS</small>
                <b>{run?.status ?? "idle"}</b>
              </div>
              <div>
                <small>COMPLETED</small>
                <b>
                  {
                    Object.values(run?.nodes ?? {}).filter(
                      (n: any) => n.status === "completed",
                    ).length
                  }{" "}
                  / {graph?.nodes.length ?? 0}
                </b>
              </div>
              <div>
                <small>REVISION</small>
                <select
                  aria-label="Graph revision"
                  value={revision}
                  onChange={(e) => {
                    setRevision(e.target.value);
                    setNode("");
                    setArtifact(undefined);
                  }}
                >
                  <option value="latest">
                    Latest (
                    {runs.find((r) => r.runId === selected)?.revision ?? 1})
                  </option>
                  {Array.from(
                    {
                      length:
                        runs.find((r) => r.runId === selected)?.revision ?? 1,
                    },
                    (_, i) => (
                      <option key={i + 1} value={String(i + 1)}>
                        Revision {i + 1}
                      </option>
                    ),
                  )}
                </select>
              </div>
              <div>
                <small>MODEL CALLS</small>
                <b>{run?.attempts ?? 0}</b>
              </div>
              <div>
                <small>ACTIVE TIME</small>
                <b>{Math.round((run?.activeMs ?? 0) / 1000)}s</b>
              </div>
            </div>
            {run?.message && (
              <div className="notice">
                {run.message}
                {revision === "latest" && run.message.includes("T3") && (
                  <button onClick={() => command("approve_final")}>
                    Confirm final result
                  </button>
                )}
              </div>
            )}
            <div className="canvas">
              <div className="canvas-label">
                DEPENDENCY GRAPH{" "}
                <span>Click a node to inspect its evidence</span>
              </div>
              {graph ? (
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  nodeTypes={nodeTypes}
                  fitView
                  nodesDraggable={false}
                  nodesConnectable={false}
                  onNodeClick={(_, n) => {
                    setNode(n.id);
                    setArtifact(undefined);
                  }}
                  minZoom={0.2}
                >
                  <Background gap={24} color="#dfe4ed" />
                  <Controls />
                  <MiniMap />
                </ReactFlow>
              ) : (
                <div className="empty">
                  <h2>Intent → plan → verified result</h2>
                  <p>
                    Execution nodes and their dependencies will appear here.
                  </p>
                  <code>ralph run "Describe your task"</code>
                </div>
              )}
            </div>
            <div className="run-footer">
              <span>
                {run?.updatedAt
                  ? `Updated ${new Date(run.updatedAt).toLocaleTimeString()}`
                  : "Waiting for a run"}
              </span>
              <span>
                {run?.resultHead
                  ? `Result ${run.resultHead.slice(0, 12)}`
                  : "Results remain isolated until verification passes"}
              </span>
            </div>
          </>
        ) : (
          <>
            <header>
              <div className="eyebrow">RESOURCE ANALYTICS</div>
              <h1>Providers & usage</h1>
              <p>Reported usage is separated from unavailable measurements.</p>
            </header>
            <div className="provider-grid">
              {providers.map((p) => (
                <article key={p.id}>
                  <span className="eyebrow">{p.mode}</span>
                  <h2>{p.id}</h2>
                  <p>
                    {p.enabled ? "Enabled" : "Disabled"} · {p.support}
                  </p>
                  <small>
                    {p.verification?.length ? p.verification.map((v: Row) => `${v.model} · ${v.cliVersion} · ${v.platform} / ${v.node} · ${v.checkedAt}`).join("; ") : "Live conformance not yet recorded for this environment"}
                  </small>
                </article>
              ))}
            </div>
            <section
              className="metrics activity-chart"
              aria-label="Invocation distribution"
            >
              <h2>Invocation distribution</h2>
              {metrics.map((m) => (
                <div
                  className="distribution-row"
                  key={`${m.connectionId}/${m.modelId}`}
                >
                  <span>{m.modelId}</span>
                  <meter
                    aria-label={`${m.modelId} invocation share`}
                    min={0}
                    max={Math.max(
                      1,
                      metrics.reduce((n, m) => n + m.calls, 0),
                    )}
                    value={m.calls}
                  />
                  <b>{m.calls} calls</b>
                </div>
              ))}
            </section>
            <section className="metrics">
              <h2>Task distribution</h2>
              <div
                className="heatmap"
                role="table"
                aria-label="Task category invocation counts"
              >
                {metrics.map((m) => (
                  <div
                    key={`${m.connectionId}/${m.modelId}`}
                    className="heat-row"
                    role="row"
                  >
                    <strong>{m.modelId}</strong>
                    {Object.entries(m.taskCalls ?? {}).map(([task, count]) => (
                      <span
                        role="cell"
                        key={task}
                        style={{
                          background: `rgba(92,105,234,${Math.min(0.5, 0.08 + Number(count) / 30)})`,
                        }}
                      >
                        {task.replaceAll("_", " ")}
                        <b>{String(count)}</b>
                      </span>
                    ))}
                  </div>
                ))}
              </div>
              <h2>Model activity</h2>
              <table>
                <thead>
                  <tr>
                    <th>Model / connection</th>
                    <th>Calls</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Cached</th>
                    <th>Cost</th>
                    <th>Latency total</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.map((m) => (
                    <tr key={`${m.connectionId}/${m.modelId}`}>
                      <td>
                        <b>{m.modelId}</b>
                        <small>{m.connectionId}</small>
                      </td>
                      <td>{m.calls}</td>
                      <td>
                        {m.knownUsageCalls
                          ? m.inputTokens.toLocaleString()
                          : "Unknown"}
                      </td>
                      <td>
                        {m.knownUsageCalls
                          ? m.outputTokens.toLocaleString()
                          : "Unknown"}
                      </td>
                      <td>
                        {m.knownCachedCalls
                          ? m.cachedTokens.toLocaleString()
                          : "Unknown"}
                      </td>
                      <td>
                        {m.knownCostCalls
                          ? `~${m.estimatedCostUsd.toFixed(4)} (${m.costStatus})`
                          : "Unknown"}
                      </td>
                      <td>{(m.durationMs / 1000).toFixed(1)}s</td>
                      <td>{m.usageStatus}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!metrics.length && <p>No model usage recorded yet.</p>}
              <h2>Verified node outcomes</h2>
              <p>
                Local node checks, grouped by task and verifier version. Fewer
                than 20 samples do not affect routing.
              </p>
              <table>
                <thead>
                  <tr>
                    <th>Model / task</th>
                    <th>Passed / samples</th>
                    <th>95% lower bound</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {metrics.flatMap((m) =>
                    (m.quality ?? []).map((q: Row) => (
                      <tr
                        key={`${m.connectionId}/${m.modelId}/${q.taskCategory}/${q.verifierVersion}`}
                      >
                        <td>
                          {m.modelId}
                          <small>
                            {q.taskCategory} · {q.verifierVersion.slice(0, 8)}
                          </small>
                        </td>
                        <td>
                          {q.qualifiedSuccesses} / {q.attempts}
                        </td>
                        <td>{(q.lowerBound * 100).toFixed(1)}%</td>
                        <td>{q.dataStatus}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>
      {node && view === "runs" && (
        <aside className="inspector">
          <button
            className="close"
            aria-label="Close inspector"
            onClick={() => setNode("")}
          >
            ×
          </button>
          <div className="eyebrow">NODE INSPECTOR</div>
          <h2>{node}</h2>
          <span className="pill">{detail?.status ?? "Loading"}</span>
          <p>{detail?.result?.summary ?? detail?.error}</p>
          <dl>
            <dt>Model</dt>
            <dd>{detail?.modelId ?? "Local execution"}</dd>
            <dt>Selection</dt>
            <dd>{detail?.rationale ?? "Deterministic runtime policy"}</dd>
            <dt>Generation</dt>
            <dd>{detail?.generation}</dd>
            <dt>Iterations</dt>
            <dd>{detail?.iteration}</dd>
            <dt>Started</dt>
            <dd>{detail?.startedAt ?? "—"}</dd>
          </dl>
          <h3>Evidence</h3>
          {detail?.result?.evidenceIds?.map((id: string) => (
            <button
              key={id}
              onClick={() =>
                api(`runs/${selected}/artifacts/${id}`).then(setArtifact)
              }
            >
              Inspect {id.slice(0, 12)}
            </button>
          ))}
          {artifact && (
            <>
              <details open>
                <summary>Verification result</summary>
                <pre>
                  {JSON.stringify(
                    artifact.evaluation ?? artifact.verifier,
                    null,
                    2,
                  )}
                </pre>
              </details>
              <details>
                <summary>File diff</summary>
                <VirtualLog
                  text={artifact.diff ?? "No diff"}
                  label="File diff log"
                />
              </details>
            </>
          )}
          <h3>Timeline</h3>
          {detail?.events?.slice(-60).map((e: Row) => (
            <details key={e.eventId}>
              <summary>
                {e.type}
                <small>{new Date(e.timestamp).toLocaleTimeString()}</small>
              </summary>
              <VirtualLog
                text={JSON.stringify(e.payload, null, 2)}
                label="Event detail log"
              />
            </details>
          ))}
        </aside>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
