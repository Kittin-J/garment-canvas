import assert from "node:assert/strict";

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function memoryStorage(initial: Record<string, string> = {}, onSet?: (key: string) => void): MemoryStorage {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      onSet?.(key);
      values.set(key, value);
    },
    removeItem: (key) => values.delete(key),
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

let sessionWrites = 0;
const sessionStorage = memoryStorage(
  { [sessionKey]: JSON.stringify(storedSession) },
  (key) => { if (key === sessionKey) sessionWrites += 1; },
);
const localStorage = memoryStorage({ [recentKey]: JSON.stringify(storedRecentResults) });
Object.assign(globalThis, { window: { sessionStorage, localStorage } });

const { discardActiveTabSession, normalizeTabSessionValue, TAB_SESSION_SCHEMA_VERSION, useFlowStore } = await import("../src/store/flowStore");
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
assert.equal((persisted as typeof storedSession & { schemaVersion: number }).schemaVersion, TAB_SESSION_SCHEMA_VERSION);
console.log("  ✓ 初始化持久化不会再次覆盖恢复后的连线或保存状态");

const migrated = normalizeTabSessionValue({
  activeTabId: "legacy-tab",
  tabs: [{
    id: "legacy-tab",
    projectId: "legacy-project",
    projectName: "旧项目",
    nodes: [
      {
        id: "legacy-ai",
        type: "ai-modify",
        position: { x: 10, y: 20 },
        data: { kind: "ai-modify", label: "改款", status: "idle", prompt: "换领型" },
      },
      { id: "broken", type: "unknown", position: { x: 0, y: 0 }, data: {} },
      {
        id: "legacy-result",
        type: "result",
        position: { x: 300, y: 20 },
        data: { kind: "result", label: "结果", status: "idle" },
      },
    ],
    edges: [
      { id: "valid-edge", source: "legacy-ai", target: "legacy-result" },
      { id: "dangling-edge", source: "broken", target: "legacy-result" },
    ],
    saveState: "saving",
    revision: 4,
    savedRevision: 4,
    dirty: false,
  }],
});
assert.ok(migrated);
assert.equal(migrated.schemaVersion, TAB_SESSION_SCHEMA_VERSION);
assert.deepEqual(migrated.tabs[0].nodes.map((node) => node.id), ["legacy-ai", "legacy-result"]);
assert.deepEqual(migrated.tabs[0].edges.map((edge) => edge.id), ["valid-edge"]);
const migratedAi = migrated.tabs[0].nodes[0].data;
assert.equal(migratedAi.kind, "ai-modify");
if (migratedAi.kind !== "ai-modify") throw new Error("unexpected node kind");
assert.equal(migratedAi.aspectRatio, "1:1");
assert.equal(migratedAi.batchSize, 1);
assert.deepEqual(migratedAi.outputImages, []);
assert.equal(migrated.tabs[0].saveState, "idle");
assert.equal(migrated.tabs[0].dirty, true);
console.log("  ✓ 旧会话逐节点补齐必需字段，并隔离坏节点和悬空边");

assert.deepEqual(state.recentResults, [], "登录后的历史必须以服务器为准，不能泄露上一账号的 localStorage");
const writesBeforeHistory = sessionWrites;
useFlowStore.setState({ recentResults: storedRecentResults as never });
assert.deepEqual(useFlowStore.getState().recentResults.map((record) => record.id), ["record-project-b", "record-legacy"]);
assert.equal(sessionWrites, writesBeforeHistory, "历史/SSE 更新不应重新序列化项目页签");
console.log("  ✓ 忽略本地跨账号缓存，并能渲染服务器恢复的全局历史");

sessionStorage.setItem(sessionKey, JSON.stringify({
  activeTabId: "bad-tab",
  tabs: [
    { id: "good-tab", projectId: "good-project", projectName: "可恢复项目", nodes: [], edges: [] },
    { id: "bad-tab", projectId: "bad-project", projectName: "损坏项目", nodes: [], edges: [] },
  ],
}));
discardActiveTabSession();
const recovered = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null") as {
  activeTabId: string;
  tabs: Array<{ id: string }>;
};
assert.equal(recovered.activeTabId, "good-tab");
assert.deepEqual(recovered.tabs.map((tab) => tab.id), ["good-tab"]);
console.log("  ✓ 错误恢复只清除当前损坏页签并保留其他页签");

console.log("\n通过 6 项");
