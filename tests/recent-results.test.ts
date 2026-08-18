import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyRunEventToNode,
  applyRunEventToRecentResults,
  createQueuedResultCards,
  normalizeRunEvent,
  requestedResultCount,
  resumeRecentResults,
  useFlowStore,
  type RecentResult,
  type RunEvent,
} from "../src/store/flowStore";
import type { AiModifyNodeData } from "../src/types/workflow";
import { ImageGrid } from "../src/components/nodes/ImageGrid";

let passed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const queued: RecentResult = {
  id: "record-1",
  image: "",
  nodeId: "node-1",
  nodeLabel: "文生图",
  kind: "sketch-to-render",
  projectId: "project-1",
  projectName: "秋冬款式",
  prompt: "极简黑色西装",
  startedAt: 1_000,
  status: "queued",
};

function apply(event: RunEvent): RecentResult[] {
  return applyRunEventToRecentResults([queued], queued.id, event);
}

console.log("生成记录生命周期测试");

test("排队卡收到运行事件后原地更新，不重复新建", () => {
  const result = apply({
    type: "node-status",
    nodeId: "node-1",
    status: "running",
    model: "gpt-image-2",
    startedAt: 1_200,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, queued.id);
  assert.equal(result[0].status, "running");
  assert.equal(result[0].model, "gpt-image-2");
  assert.equal(result[0].startedAt, 1_200);
});

test("点击批量生成时立即按用户选择创建对应数量的排队卡", () => {
  const cards = createQueuedResultCards(queued, 4);
  assert.equal(cards.length, 4);
  assert.equal(cards[0].id, queued.id);
  assert.deepEqual(cards.slice(1).map((record) => record.id), [
    `${queued.id}:pending:1`,
    `${queued.id}:pending:2`,
    `${queued.id}:pending:3`,
  ]);
  assert.ok(cards.every((record) => record.status === "queued" && record.requestedCount === 4));

  const running = applyRunEventToRecentResults(cards, queued.id, {
    type: "node-status",
    nodeId: queued.nodeId,
    status: "running",
    startedAt: 1_500,
  });
  assert.ok(running.every((record) => record.status === "running" && record.startedAt === 1_500));
});

test("各批量节点正确计算用户选择的卡片数量", () => {
  const modify: AiModifyNodeData = {
    kind: "ai-modify",
    label: "AI 改款",
    status: "idle",
    prompt: "改款",
    aspectRatio: "1:1",
    batchSize: 4,
    outputImages: [],
  };
  assert.equal(requestedResultCount(modify), 4);
  assert.equal(requestedResultCount({
    kind: "print-mutate",
    label: "印花裂变",
    status: "idle",
    prompt: "变体",
    count: 8,
    outputImages: [],
  }), 8);
  assert.equal(requestedResultCount({
    kind: "fabric-recolor",
    label: "配色",
    status: "idle",
    colors: ["#111111", "#222222", "#333333"],
    prompt: "",
    outputImages: [],
  }), 3);
});

test("部分成功时用错误卡补足用户选择数量而不增减卡片", () => {
  const cards = createQueuedResultCards(queued, 4);
  const result = applyRunEventToRecentResults(cards, queued.id, {
    type: "node-status",
    nodeId: queued.nodeId,
    status: "success",
    images: ["/api/files/one", "/api/files/two"],
    failures: [{ error: "模型暂时不可用" }],
    finishedAt: 4_000,
  });
  assert.equal(result.length, 4);
  assert.deepEqual(result.map((record) => record.status), ["success", "success", "error", "error"]);
  assert.equal(result[2].error, "模型暂时不可用");
  assert.equal(result[3].error, "未返回图片");
});

test("成功后主卡保留原 id，批量图片追加独立可查看卡片", () => {
  const result = apply({
    type: "node-status",
    nodeId: "node-1",
    status: "success",
    images: ["/api/files/one", "/api/files/two"],
    prompts: ["提示词 1", "提示词 2"],
    finishedAt: 3_000,
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].id, queued.id);
  assert.deepEqual(
    result.map((record) => record.status),
    ["success", "success"],
  );
  assert.deepEqual(
    result.map((record) => record.image),
    ["/api/files/one", "/api/files/two"],
  );
  assert.equal(result[1].prompt, "提示词 2");
});

test("生成失败也保留点击时的卡片和错误信息", () => {
  const result = apply({
    type: "node-status",
    nodeId: "node-1",
    status: "error",
    error: "上游图片缺失",
    finishedAt: 2_000,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, queued.id);
  assert.equal(result[0].status, "error");
  assert.equal(result[0].error, "上游图片缺失");
  assert.equal(result[0].image, "");
});

test("异常错误事件即使夹带 images 也不会清空节点原有图片", () => {
  const data: AiModifyNodeData = {
    kind: "ai-modify",
    label: "保留上一版",
    status: "success",
    prompt: "改款",
    aspectRatio: "1:1",
    batchSize: 1,
    outputImages: ["/api/files/previous.png"],
  };
  const event = normalizeRunEvent({
    type: "node-status",
    nodeId: "node-1",
    status: "error",
    error: "网关失败",
    images: undefined,
  });
  assert.equal(event.type, "node-status");
  if (event.type !== "node-status") throw new Error("expected node status event");
  const next = applyRunEventToNode(data, event);
  assert.equal(next.status, "error");
  assert.equal(next.error, "网关失败");
  assert.deepEqual((next as AiModifyNodeData).outputImages, ["/api/files/previous.png"]);
});

test("缺少 images 的成功事件被归一为空数组而不是 undefined", () => {
  const event = normalizeRunEvent({
    type: "node-status",
    nodeId: "node-1",
    status: "success",
  });
  assert.equal(event.type, "node-status");
  if (event.type !== "node-status" || event.status !== "success") {
    throw new Error("expected success event");
  }
  assert.deepEqual(event.images, []);
});

test("图片网格收到损坏的 undefined 数据时显示空状态而不抛错", () => {
  const html = renderToStaticMarkup(createElement(ImageGrid, { images: undefined }));
  assert.match(html, /暂无生成结果/);
});

test("图片网格使用服务端缩略图但查看器仍保留原图引用", () => {
  const html = renderToStaticMarkup(createElement(ImageGrid, { images: ["/api/files/result.png"] }));
  assert.match(html, /\/api\/files\/result\.png\/thumbnail/);
});

test("部分成功时成功图和失败项都保留", () => {
  const result = apply({
    type: "node-status",
    nodeId: "node-1",
    status: "success",
    images: ["/api/files/one"],
    failures: [{ prompt: "配色 B", error: "超时" }],
    finishedAt: 4_000,
  });
  assert.equal(result.length, 2);
  assert.equal(result[0].status, "success");
  assert.equal(result[1].status, "error");
  assert.equal(result[1].prompt, "配色 B");
  assert.equal(result[1].error, "超时");
});

test("同一终态成功事件重放时按 runId 幂等替换多图与失败卡", () => {
  const running: RecentResult = {
    ...queued,
    id: "replay-record",
    runId: "replay-run",
    status: "running",
  };
  const event: RunEvent = {
    type: "node-status",
    nodeId: running.nodeId,
    status: "success",
    images: ["/api/files/replay-a.png", "/api/files/replay-b.png"],
    prompts: ["版本 A", "版本 B"],
    failures: [{ prompt: "版本 C", error: "生成超时" }],
    startedAt: 2_000,
    finishedAt: 3_000,
  };
  const once = applyRunEventToRecentResults([running], running.id, event);
  const twice = applyRunEventToRecentResults(once, running.id, event);
  assert.deepEqual(twice, once);
  assert.deepEqual(
    twice.map((record) => [record.id, record.image, record.status]),
    [
      [running.id, "/api/files/replay-a.png", "success"],
      [`${running.id}:terminal:image:1`, "/api/files/replay-b.png", "success"],
      [`${running.id}:terminal:failure:0`, "", "error"],
    ],
  );
});

class MockEventSource {
  static instances: MockEventSource[] = [];

  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  emit(payload: unknown, lastEventId: string): void {
    this.onmessage?.({ data: JSON.stringify(payload), lastEventId } as MessageEvent<string>);
  }
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
const originalWindow = globalThis.window;
let statusChecks = 0;
try {
  Object.assign(globalThis, {
    window: {
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    },
    EventSource: MockEventSource,
  });
  globalThis.fetch = async () => {
    statusChecks += 1;
    return Response.json({ runId: "shared-run", finished: false });
  };

  const resumable: RecentResult = {
    ...queued,
    id: "shared-record",
    runId: "shared-run",
    status: "running",
  };
  useFlowStore.setState({ recentResults: [resumable] });

  resumeRecentResults([resumable, resumable]);
  resumeRecentResults([resumable]);
  await waitFor(() => MockEventSource.instances.length === 1, "未建立首条恢复连接");
  assert.equal(statusChecks, 1);
  assert.equal(MockEventSource.instances[0].url, "/api/run-plan/shared-run/events");

  MockEventSource.instances[0].emit(
    { type: "run-error", nodeId: resumable.nodeId, error: "跟踪中断", seq: 1 },
    "1",
  );
  await waitFor(() => MockEventSource.instances[0].closed, "失败后未关闭恢复连接");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  resumeRecentResults([resumable]);
  await waitFor(() => MockEventSource.instances.length === 2, "失败后未释放 runId");
  assert.equal(statusChecks, 2);
  const terminalSuccess = {
    type: "node-status",
    nodeId: resumable.nodeId,
    status: "success",
    images: ["/api/files/recovered-a.png", "/api/files/recovered-b.png"],
    prompts: ["恢复 A", "恢复 B"],
    startedAt: 2_000,
    finishedAt: 3_000,
    seq: 1,
  };
  MockEventSource.instances[1].emit(terminalSuccess, "1");
  MockEventSource.instances[1].emit({ type: "done", seq: 2 }, "2");
  await waitFor(() => MockEventSource.instances[1].closed, "终态后未关闭恢复连接");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const firstTerminalCards = useFlowStore.getState().recentResults.map((record) => ({
    id: record.id,
    image: record.image,
    status: record.status,
  }));
  assert.deepEqual(firstTerminalCards.map((record) => record.image), [
    "/api/files/recovered-a.png",
    "/api/files/recovered-b.png",
  ]);

  resumeRecentResults([resumable]);
  await waitFor(() => MockEventSource.instances.length === 3, "终态后未释放 runId");
  MockEventSource.instances[2].emit(terminalSuccess, "1");
  MockEventSource.instances[2].emit(terminalSuccess, "1");
  MockEventSource.instances[2].emit({ type: "done", seq: 2 }, "2");
  await waitFor(() => MockEventSource.instances[2].closed, "重试连接未关闭");
  assert.deepEqual(
    useFlowStore.getState().recentResults.map((record) => ({
      id: record.id,
      image: record.image,
      status: record.status,
    })),
    firstTerminalCards,
  );
  passed += 1;
  console.log("  ✓ 重叠历史页去重，释放后重放终态事件仍保持幂等");
} finally {
  globalThis.fetch = originalFetch;
  Object.assign(globalThis, { EventSource: originalEventSource, window: originalWindow });
}

console.log(`\n通过 ${passed} 项`);
