import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { mkdtemp, readFile, appendFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_BUDGET,
  digest,
  type GraphRevision,
} from "../src/graph/schema.js";
import {
  compileGraph,
  singleGraph,
  topological,
} from "../src/graph/compiler.js";
import { reviseGraph } from "../src/graph/revisions.js";
import { RunStore } from "../src/storage/run-store.js";
import { schedule } from "../src/graph/scheduler.js";
import {
  approvePlan,
  assertPlanApproved,
} from "../src/interaction/approval.js";

const envelope = {
  readPaths: ["**"],
  writePaths: ["src/**"],
  exclude: [".git/**"],
  verifierIds: ["check"],
  budget: DEFAULT_BUDGET,
};
function graph(): GraphRevision {
  return singleGraph("test-run", {
    taskType: "backend_core",
    goal: "Change code",
    readPaths: ["**"],
    writePaths: ["src/a.ts"],
    acceptanceCriteria: ["check passes"],
    requiredCapabilities: [],
    inputArtifacts: [],
    verifierIds: ["check"],
    budget: { maxIterations: 6 },
  });
}
describe("graph compiler", () => {
  it("rejects invalid references, cycles, duplicate IDs and unverified writes", () => {
    const g = graph();
    expect(() =>
      compileGraph(
        {
          ...g,
          edges: [...g.edges, { from: "missing", to: "work", kind: "order" }],
        },
        envelope,
      ),
    ).toThrow(/Unknown/);
    expect(() =>
      compileGraph(
        {
          ...g,
          edges: [...g.edges, { from: "validate", to: "work", kind: "order" }],
        },
        envelope,
      ),
    ).toThrow(/cycle/);
    expect(() =>
      compileGraph({ ...g, nodes: [...g.nodes, g.nodes[0]!] }, envelope),
    ).toThrow(/Duplicate/);
    expect(() => compileGraph({ ...g, edges: [] }, envelope)).toThrow(
      /validation/,
    );
  });
  it("rejects writes outside approval and traversal", () => {
    for (const path of [
      "README.md",
      "../outside",
      "C:/temp/out",
      ".git/config",
    ]) {
      const g = graph();
      g.nodes[0]!.writePaths = [path];
      expect(() => compileGraph(g, envelope)).toThrow();
    }
  });
  it("serializes overlapping workers without introducing cycles", () => {
    const g = graph();
    g.nodes.splice(1, 0, { ...g.nodes[0]!, nodeId: "second" });
    g.edges.push({ from: "second", to: "integrate", kind: "artifact" });
    const compiled = compileGraph(g, envelope);
    expect(compiled.edges).toContainEqual({
      from: "work",
      to: "second",
      kind: "artifact",
    });
    expect(topological(compiled).indexOf("work")).toBeLessThan(
      topological(compiled).indexOf("second"),
    );
  });
  it("topological ordering respects generated chain edges", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (count) => {
        const g = graph();
        g.nodes = Array.from({ length: count }, (_, i) => ({
          ...g.nodes[0]!,
          nodeId: `n${i}`,
        }));
        g.edges = Array.from({ length: count - 1 }, (_, i) => ({
          from: `n${i}`,
          to: `n${i + 1}`,
          kind: "order" as const,
        }));
        expect(topological(g)).toEqual(g.nodes.map((n) => n.nodeId));
      }),
    );
  });
  it("only increments changed nodes and their descendants", () => {
    const g = graph(),
      next = structuredClone(g);
    next.nodes[0]!.goal = "Updated implementation";
    const revised = reviseGraph(g, next, {}, envelope);
    expect(revised.nodes.every((n) => n.generation === 1)).toBe(true);
    expect(() =>
      reviseGraph(
        g,
        next,
        { work: { status: "running", generation: 0, iteration: 1 } },
        envelope,
      ),
    ).toThrow(/active/);
  });
});
describe("durable graph state", () => {
  it("serializes concurrent appends and reconstructs without executing effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-store-"));
    const store = new RunStore(root, "test-run");
    await store.acquire();
    await store.append(
      { type: "graph.revised", payload: { graph: graph() } },
      1,
    );
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.append({ type: "runtime.elapsed", payload: { ms: 1 } }, 1),
      ),
    );
    expect((await store.state()).activeMs).toBe(20);
    expect((await store.readAfter(18)).map((e) => e.seq)).toEqual([19, 20, 21]);
    await store.saveSnapshot();
    await writeFile(join(store.directory, "snapshot.json"), "broken");
    expect((await store.loadSnapshot()).activeMs).toBe(20);
    await store.release();
  });
  it("rejects a second owner and repairs only an incomplete tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-store-"));
    const store = new RunStore(root, "test-run");
    await store.acquire();
    await expect(new RunStore(root, "other-run").acquire()).rejects.toThrow(
      /supervisor/,
    );
    await store.append(
      { type: "graph.revised", payload: { graph: graph() } },
      1,
    );
    await appendFile(store.journal.path, '{"torn":');
    await expect(store.journal.read()).rejects.toThrow(/tail/);
    expect(await store.journal.read(true)).toHaveLength(1);
    const text = await readFile(store.journal.path, "utf8");
    await writeFile(store.journal.path, text.replace('"seq":1', '"seq":2'));
    await expect(store.journal.read(true)).rejects.toThrow(/integrity/);
    await store.release();
  });
  it("schedules independent work concurrently and waits for fan-in", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-schedule-"));
    const store = new RunStore(root, "test-run");
    await store.acquire();
    const g = graph();
    g.nodes.splice(1, 0, {
      ...g.nodes[0]!,
      nodeId: "second",
      writePaths: ["src/b.ts"],
    });
    g.edges.push({ from: "second", to: "integrate", kind: "artifact" });
    await store.append({ type: "graph.revised", payload: { graph: g } }, 1);
    let active = 0,
      max = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const done: string[] = [];
    const state = await schedule(
      g,
      store,
      2,
      async (n) => {
        active++;
        max = Math.max(max, active);
        if (n.kind === "integrate")
          expect(done).toEqual(expect.arrayContaining(["work", "second"]));
        if (n.kind === "worker") {
          if (active === 2) release();
          await barrier;
        }
        active--;
        done.push(n.nodeId);
        return {
          nodeId: n.nodeId,
          generation: 0,
          inputDigest: digest(n),
          outcome: "completed",
          artifactIds: [],
          evidenceIds: [],
          summary: "ok",
        };
      },
      new AbortController().signal,
    );
    expect(max).toBe(2);
    expect(
      Object.values(state.nodes).every((n) => n.status === "completed"),
    ).toBe(true);
    await store.release();
  });
  it("marks descendants blocked instead of reporting success", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-schedule-"));
    const store = new RunStore(root, "test-run");
    await store.acquire();
    await store.append(
      { type: "graph.revised", payload: { graph: graph() } },
      1,
    );
    const state = await schedule(
      graph(),
      store,
      1,
      async () => {
        throw new Error("no route");
      },
      new AbortController().signal,
    );
    expect(state.nodes.work?.status).toBe("blocked");
    expect(state.nodes.validate?.status).toBe("blocked");
    await store.release();
  });
});

it("stores immutable redacted artifacts and refuses corrupted duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-artifacts-"));
  const store = new RunStore(root, "artifact-test");
  await expect(store.graph()).rejects.toThrow(/No graph/);
  await expect(
    store.append({ type: "runtime.elapsed", payload: { ms: 1 } }, 1),
  ).rejects.toThrow(/owning/);
  await store.release();
  const value = {
    apiKey: "credential",
    findings: [{ ok: true, count: 2, note: null }],
  };
  const id = await store.putArtifact(value);
  expect(await store.putArtifact(value)).toBe(id);
  expect(((await store.artifact(id)) as any).apiKey).toBe("[REDACTED]");
  await writeFile(
    join(store.directory, "artifacts", `${id}.json`),
    JSON.stringify({ changed: true }),
  );
  await expect(store.putArtifact(value)).rejects.toThrow(/integrity/);
});
it("treats malformed middle records, including empty lines, as corruption", async () => {
  for (const middle of ["not-json", ""]) {
    const root = await mkdtemp(join(tmpdir(), "ralph-corrupt-")),
      store = new RunStore(root, "broken");
    await store.acquire();
    try {
      await store.append({ type: "runtime.elapsed", payload: { ms: 1 } }, 1);
      await appendFile(store.journal.path, middle + "\n");
      await expect(store.journal.read(true)).rejects.toThrow(/corrupt/);
    } finally {
      await store.release();
    }
  }
});
it("interruption waits for the running executor and does not start descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "ralph-interrupt-")),
    store = new RunStore(root, "test-run"),
    controller = new AbortController();
  await store.acquire();
  try {
    await store.append(
      { type: "graph.revised", payload: { graph: graph() } },
      1,
    );
    const state = await schedule(
      graph(),
      store,
      1,
      async () => {
        controller.abort();
        throw "Executor stopped";
      },
      controller.signal,
    );
    expect(state.nodes.work?.status).toBe("interrupted");
    expect(state.nodes.integrate?.status).toBe("pending");
    expect(state.nodes.work?.error).toBe("Executor stopped");
  } finally {
    await store.release();
  }
});
it("does not queue missing node states or nodes with unfinished inputs", async () => {
  const { readyNodes } = await import("../src/graph/scheduler.js");
  const { replay } = await import("../src/storage/run-store.js");
  const state = replay("test-run", []);
  expect(readyNodes(graph(), state)).toEqual([]);
  state.nodes.integrate = { status: "queued", generation: 0, iteration: 0 };
  expect(readyNodes(graph(), state)).toEqual([]);
});
