import assert from "node:assert/strict";
import fs from "node:fs";
import type { Edge } from "@xyflow/react";
import { applyRunEventToTab, useFlowStore, type FlowNode } from "../src/store/flowStore";

let passed = 0;

async function test(name: string, run: () => void | Promise<void>): Promise<void> {
  try {
    await run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function imageNode(id: string, label: string): FlowNode {
  return {
    id,
    type: "image-input",
    position: { x: 0, y: 0 },
    data: { kind: "image-input", label, status: "idle", imageRole: "default" },
  };
}

function aiNode(id: string, label: string): FlowNode {
  return {
    id,
    type: "ai-modify",
    position: { x: 320, y: 0 },
    data: {
      kind: "ai-modify",
      label,
      status: "success",
      prompt: "修改衣领",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages: ["/api/files/previous.png"],
    },
  };
}

console.log("项目多页签状态测试");

const initial = useFlowStore.getState();
const tabA = initial.activeTabId;
initial.setProjectName("项目 A");
initial.updateNodeData(initial.nodes[0].id, { label: "A 上传节点" });

useFlowStore.getState().openFlowTab({
  projectId: "project-b",
  projectName: "项目 B",
  nodes: [imageNode("b-node", "B 上传节点")],
  edges: [] as Edge[],
});
const tabB = useFlowStore.getState().activeTabId;

await test("切换页签保留各自画布与项目名称", () => {
  assert.notEqual(tabA, tabB);
  assert.equal(useFlowStore.getState().projectName, "项目 B");
  assert.equal(useFlowStore.getState().nodes[0].id, "b-node");
  useFlowStore.getState().switchTab(tabA);
  assert.equal(useFlowStore.getState().projectName, "项目 A");
  assert.equal(useFlowStore.getState().nodes[0].data.label, "A 上传节点");
  useFlowStore.getState().switchTab(tabB);
  assert.equal(useFlowStore.getState().nodes[0].data.label, "B 上传节点");
});

await test("重复打开同一项目复用已有页签且不覆盖未保存状态", () => {
  useFlowStore.getState().updateNodeData("b-node", { label: "B 本地修改" });
  const count = useFlowStore.getState().tabs.length;
  useFlowStore.getState().openFlowTab({
    projectId: "project-b",
    projectName: "服务端旧名称",
    nodes: [imageNode("replacement", "不应覆盖")],
    edges: [],
  });
  assert.equal(useFlowStore.getState().tabs.length, count);
  assert.equal(useFlowStore.getState().activeTabId, tabB);
  assert.equal(useFlowStore.getState().nodes[0].data.label, "B 本地修改");
});

await test("后台任务可定向回写非当前页签", () => {
  useFlowStore.getState().switchTab(tabA);
  useFlowStore.getState().updateNodeDataInTab(tabB, "b-node", {
    status: "success",
    imageUrl: "/api/files/background-result.png",
  });
  assert.equal(useFlowStore.getState().projectName, "项目 A");
  useFlowStore.getState().switchTab(tabB);
  const node = useFlowStore.getState().nodes.find((candidate) => candidate.id === "b-node");
  assert.equal(node?.data.status, "success");
  assert.equal(node?.data.kind === "image-input" ? node.data.imageUrl : undefined, "/api/files/background-result.png");
});

await test("A 页签后台失败不影响 B 页签且保留 A 的上一版图片", () => {
  useFlowStore.getState().switchTab(tabA);
  useFlowStore.getState().addExistingNode(aiNode("a-ai-node", "A 后台改款"));
  useFlowStore.getState().switchTab(tabB);
  const beforeB = useFlowStore.getState().nodes;

  applyRunEventToTab(tabA, "a-ai-node", {
    type: "node-status",
    nodeId: "a-ai-node",
    status: "error",
    error: "AI 网关暂不可用",
  });

  assert.equal(useFlowStore.getState().activeTabId, tabB);
  assert.strictEqual(useFlowStore.getState().nodes, beforeB);
  useFlowStore.getState().switchTab(tabA);
  const failedNode = useFlowStore.getState().nodes.find((node) => node.id === "a-ai-node");
  assert.equal(failedNode?.data.status, "error");
  assert.equal(failedNode?.data.error, "AI 网关暂不可用");
  assert.deepEqual(
    failedNode?.data.kind === "ai-modify" ? failedNode.data.outputImages : undefined,
    ["/api/files/previous.png"],
  );
  useFlowStore.getState().switchTab(tabB);
});

await test("运行中的页签不能关闭，避免任务结果丢失画布回写", () => {
  useFlowStore.getState().updateNodeData("b-node", { status: "queued" });
  const count = useFlowStore.getState().tabs.length;
  useFlowStore.getState().closeTab(tabB);
  assert.equal(useFlowStore.getState().tabs.length, count);
  assert.equal(useFlowStore.getState().activeTabId, tabB);
  useFlowStore.getState().updateNodeData("b-node", { status: "idle" });
});

await test("关闭当前页签后切换到相邻页签，至少保留一个画布", () => {
  useFlowStore.getState().closeTab(tabB);
  assert.equal(useFlowStore.getState().activeTabId, tabA);
  assert.equal(useFlowStore.getState().tabs.length, 1);
  useFlowStore.getState().closeTab(tabA);
  assert.equal(useFlowStore.getState().tabs.length, 1);
  assert.ok(useFlowStore.getState().activeTabId);
  assert.equal(useFlowStore.getState().nodes.length, 1);
});

await test("保存期间继续编辑会排队并最终写入最新版本", async () => {
  const requests: Array<{ body: string; resolve: (response: Response) => void }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise<Response>((resolve) => {
      requests.push({ body: String(init?.body ?? ""), resolve });
    });

  try {
    const before = useFlowStore.getState();
    const firstSave = before.saveProject();
    assert.equal(requests.length, 1);

    useFlowStore.getState().setProjectName("保存期间的新名称");
    const secondSave = useFlowStore.getState().saveProject();
    assert.equal(requests.length, 1, "第二次保存应等待当前请求完成");

    requests[0].resolve(Response.json({ ok: true }));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requests.length, 2, "旧快照完成后应自动发送最新快照");

    const latestPayload = JSON.parse(requests[1].body) as { name: string };
    assert.equal(latestPayload.name, "保存期间的新名称");
    requests[1].resolve(Response.json({ ok: true }));
    await Promise.all([firstSave, secondSave]);

    const after = useFlowStore.getState();
    assert.equal(after.dirty, false);
    assert.equal(after.saveState, "saved");
    assert.equal(after.savedRevision, after.revision);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("React Flow 初始化尺寸不会移动节点或标记项目未保存", () => {
  useFlowStore.getState().openFlowTab({
    projectId: "dimension-init-project",
    projectName: "尺寸初始化测试",
    nodes: [imageNode("dimension-node", "尺寸初始化节点")],
    edges: [],
  });
  const before = useFlowStore.getState();
  const originalPosition = { ...before.nodes[0].position };

  before.onNodesChange([{
    id: "dimension-node",
    type: "dimensions",
    dimensions: { width: 280, height: 162 },
  }]);

  const after = useFlowStore.getState();
  assert.equal(after.revision, before.revision);
  assert.equal(after.dirty, false);
  assert.deepEqual(after.nodes[0].position, originalPosition);
  assert.deepEqual(after.nodes[0].measured, { width: 280, height: 162 });
});

await test("打开含蒙版节点的项目时只订阅稳定的首张输入图", () => {
  const source = fs.readFileSync(
    new URL("../src/components/nodes/MaskRedrawNode.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes("const source = useFlowStore((state) => selectNodeInputImages(state, id)[0]);"));
  assert.doesNotMatch(source, /const sourceImages = useFlowStore/);
});

await test("窄屏侧栏使用抽屉且顶栏不再依赖绝对居中", () => {
  const appSource = fs.readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const topBarSource = fs.readFileSync(
    new URL("../src/components/panels/TopBar.tsx", import.meta.url),
    "utf8",
  );

  assert.match(appSource, /type MobilePanel = "library" | "inspector" | null/);
  assert.match(appSource, /invisible -translate-x-full/);
  assert.match(appSource, /invisible translate-x-full/);
  assert.match(appSource, /md:static md:visible md:translate-x-0/);
  assert.match(topBarSource, /min-w-0 flex-1/);
  assert.doesNotMatch(topBarSource, /absolute left-1\/2/);
});

console.log(`\n通过 ${passed} 项`);
