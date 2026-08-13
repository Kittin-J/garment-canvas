import assert from "node:assert/strict";
import {
  applyRunEventToRecentResults,
  type RecentResult,
  type RunEvent,
} from "../src/store/flowStore";

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

console.log(`\n通过 ${passed} 项`);
