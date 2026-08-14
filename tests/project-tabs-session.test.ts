import assert from "node:assert/strict";

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function memoryStorage(initial: Record<string, string> = {}): MemoryStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const sessionKey = "garment-canvas-project-tabs";
const recentKey = "garment-canvas-recent-results";
const restoredEdge = { id: "edge-a-b", source: "node-a", target: "node-b" };
const storedSession = {
  activeTabId: "tab-a",
  tabs: [
    {
      id: "tab-a",
      projectId: "project-a",
      projectName: "项目 A",
      nodes: [
        {
          id: "node-a",
          type: "image-input",
          position: { x: 0, y: 0 },
          data: {
            kind: "image-input",
            label: "输入",
            status: "idle",
            imageRole: "default",
          },
        },
        {
          id: "node-b",
          type: "result",
          position: { x: 300, y: 0 },
          data: { kind: "result", label: "结果", status: "idle", images: [] },
        },
      ],
      edges: [restoredEdge],
      selectedNodeId: null,
      selectedResultId: null,
      compareIds: [],
      saveState: "saving",
      revision: 3,
      savedRevision: 2,
      dirty: true,
      documentEpoch: 0,
    },
  ],
};

const storedRecentResults = [
  {
    id: "record-project-b",
    image: "/api/files/project-b.png",
    nodeId: "node-project-b",
    nodeLabel: "项目 B 的生成记录",
    kind: "ai-modify",
    projectId: "project-b",
    projectName: "项目 B",
    startedAt: 1_000,
    finishedAt: 2_000,
    status: "success",
  },
  {
    id: "record-legacy",
    image: "/api/files/legacy.png",
    nodeId: "node-legacy",
    nodeLabel: "旧版生成记录",
    kind: "sketch-to-render",
    startedAt: 3_000,
    finishedAt: 4_000,
    status: "success",
  },
];

const sessionStorage = memoryStorage({ [sessionKey]: JSON.stringify(storedSession) });
const localStorage = memoryStorage({ [recentKey]: JSON.stringify(storedRecentResults) });
Object.assign(globalThis, { window: { sessionStorage, localStorage } });

const { useFlowStore } = await import("../src/store/flowStore");
const state = useFlowStore.getState();

console.log("项目页签会话恢复测试");

assert.deepEqual(state.edges, [restoredEdge]);
assert.deepEqual(state.tabs[0].edges, [restoredEdge]);
console.log("  ✓ 刷新恢复活动页签的完整连线");

assert.equal(state.saveState, "idle");
assert.equal(state.tabs[0].saveState, "idle");
assert.equal(state.dirty, true);
console.log("  ✓ 刷新将中断的 saving 状态归一为 idle 并保留未保存标记");

const persisted = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null") as typeof storedSession;
assert.deepEqual(persisted.tabs[0].edges, [restoredEdge]);
assert.equal(persisted.tabs[0].saveState, "idle");
console.log("  ✓ 初始化持久化不会再次覆盖恢复后的连线或保存状态");

assert.deepEqual(
  state.recentResults.map((record) => record.id),
  ["record-project-b", "record-legacy"],
);
const [{ createElement }, { renderToStaticMarkup }, { ResultsPanel }] = await Promise.all([
  import("react"),
  import("react-dom/server"),
  import("../src/components/panels/ResultsPanel"),
]);
const resultsMarkup = renderToStaticMarkup(createElement(ResultsPanel));
assert.match(resultsMarkup, /2 条/);
assert.match(resultsMarkup, /项目 B 的生成记录/);
assert.match(resultsMarkup, /旧版生成记录/);
console.log("  ✓ 刷新后跨项目及旧版生成记录仍在全局历史中可见");

console.log("\n通过 4 项");
