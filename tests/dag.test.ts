/**
 * DAG 回归测试（纯逻辑，不调真实 API）：
 * 1. 线性链路：下游在执行时拿到上游本次产出（而非计划期快照）
 * 2. 分支 DAG：每个下游只收到其直接上游
 * 3. 环检测仍有效
 * 4. 单节点重跑：范围外上游回退快照
 * 5. runs 清理有界（终态 Run 超上限被回收）
 * 运行：node node_modules/tsx/dist/cli.mjs tests/dag.test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { assertPlanInputs, buildExecutionPlan, DagError, type FlowEdge, type FlowNode } from "../server/engine/dag";
import type {
  AIProvider,
  ImageGenRequest,
  NodeExecution,
  NodeKind,
  WorkflowNodeData,
} from "../src/types/workflow";

// 所有测试文件都进入临时目录，绝不读写项目 data/。
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-test-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const { createRun, executeStep, getRunForUser } = await import("../server/engine/runner");
const { uploadsDir } = await import("../server/lib/fileStore");
const TEST_OWNER_ID = "dag-test-owner";

// 造一张真实存在的测试图片（落盘校验需要）。
const SEED_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const SECOND_PNG = await sharp({
  create: { width: 1, height: 1, channels: 3, background: { r: 24, g: 92, b: 180 } },
}).png().toBuffer();
const SEED_DATA_URL = `data:image/png;base64,${SEED_PNG.toString("base64")}`;
const SECOND_DATA_URL = `data:image/png;base64,${SECOND_PNG.toString("base64")}`;
fs.writeFileSync(path.join(uploadsDir(), "seed.png"), SEED_PNG);

let passed = 0;
function ok(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      console.error(`  ✗ ${name}`);
      console.error(err);
      process.exitCode = 1;
    });
}

function imgNode(id: string, imageUrl?: string): FlowNode {
  return {
    id,
    type: "image-input",
    data: {
      kind: "image-input",
      label: id,
      status: "idle",
      imageUrl,
      imageRole: "default",
    } as WorkflowNodeData as FlowNode["data"],
  };
}

function aiNode(id: string, kind: "sketch-to-render" | "ai-modify", outputImages: string[] = []): FlowNode {
  return {
    id,
    type: kind,
    data: {
      kind,
      label: id,
      status: "idle",
      prompt: "test",
      aspectRatio: "1:1",
      batchSize: 1,
      outputImages,
    } as WorkflowNodeData as FlowNode["data"],
  };
}

function resultNode(id: string): FlowNode {
  return {
    id,
    type: "result",
    data: { kind: "result", label: id, status: "idle", images: [] } as WorkflowNodeData as FlowNode["data"],
  };
}

const edge = (source: string, target: string): FlowEdge => ({ source, target });

interface RecordedProviderCall {
  method: "generate" | "edit";
  request: ImageGenRequest;
}

async function runRecordedAiStep(
  kind: Exclude<NodeKind, "image-input" | "result">,
  params: Record<string, unknown>,
  inputImages: string[],
) {
  const calls: RecordedProviderCall[] = [];
  const providerIds: string[] = [];
  const record = (method: RecordedProviderCall["method"], request: ImageGenRequest) => {
    calls.push({
      method,
      request: {
        ...request,
        referenceImages: request.referenceImages ? [...request.referenceImages] : undefined,
      },
    });
    const count = Math.max(1, request.batchSize ?? 1);
    return {
      images: Array.from({ length: count }, () => SEED_DATA_URL),
      model: "runner-stub-model",
    };
  };
  const provider: AIProvider = {
    id: "runner-stub",
    async generate(request) { return record("generate", request); },
    async edit(request) { return record("edit", request); },
  };
  const step: NodeExecution = {
    nodeId: `runner-${kind}`,
    kind,
    inputImages,
    params,
  };
  const result = await executeStep(step, inputImages, (providerId) => {
    providerIds.push(providerId);
    return provider;
  });
  return { calls, providerIds, result };
}

async function main() {
  console.log("DAG 回归测试");

  await ok("线性链路：下游步骤携带上游依赖（ID + 快照）", () => {
    const plan = buildExecutionPlan(
      [imgNode("input", "/api/files/a.png"), aiNode("render", "sketch-to-render"), aiNode("modify", "ai-modify")],
      [edge("input", "render"), edge("render", "modify")],
    );
    const modify = plan.steps.find((s) => s.nodeId === "modify")!;
    // 计划期 render 无产出 → 快照为空，但依赖关系必须保留（运行时解析）
    assert.deepStrictEqual(modify.upstream, [{ nodeId: "render", images: [] }]);
    assert.deepStrictEqual(modify.inputImages, []);
  });

  await ok("分支 DAG：每个下游只挂自己的直接上游", () => {
    const plan = buildExecutionPlan(
      [imgNode("in1", "/a.png"), imgNode("in2", "/b.png"), aiNode("r1", "sketch-to-render"), aiNode("r2", "ai-modify"), resultNode("out")],
      [edge("in1", "r1"), edge("in2", "r2"), edge("r1", "out"), edge("r2", "out")],
    );
    const r1 = plan.steps.find((s) => s.nodeId === "r1")!;
    const r2 = plan.steps.find((s) => s.nodeId === "r2")!;
    const out = plan.steps.find((s) => s.nodeId === "out")!;
    assert.deepStrictEqual(r1.upstream?.map((u) => u.nodeId), ["in1"]);
    assert.deepStrictEqual(r2.upstream?.map((u) => u.nodeId), ["in2"]);
    assert.deepStrictEqual(out.upstream?.map((u) => u.nodeId), ["r1", "r2"]);
  });

  await ok("风格迁移：双参考图按人物、场景的连线顺序传入", () => {
    const transfer = aiNode("transfer", "ai-modify");
    const plan = buildExecutionPlan(
      [
        imgNode("subject", "/api/files/person.png"),
        imgNode("scene", "/api/files/scene.png"),
        transfer,
      ],
      [edge("subject", "transfer"), edge("scene", "transfer")],
    );
    const step = plan.steps.find((item) => item.nodeId === "transfer")!;
    assert.deepStrictEqual(step.upstream, [
      { nodeId: "subject", images: ["/api/files/person.png"] },
      { nodeId: "scene", images: ["/api/files/scene.png"] },
    ]);
    assert.deepStrictEqual(step.inputImages, [
      "/api/files/person.png",
      "/api/files/scene.png",
    ]);
  });

  await ok("带提示词的 AI 节点最多接受 8 张参考图", () => {
    const inputs = Array.from({ length: 9 }, (_, index) =>
      imgNode(`ref${index + 1}`, `/api/files/ref${index + 1}.png`),
    );
    const transfer = aiNode("transfer", "ai-modify");
    const eightEdges = inputs.slice(0, 8).map((node) => edge(node.id, "transfer"));
    const valid = buildExecutionPlan([...inputs.slice(0, 8), transfer], eightEdges, {
      onlyNodeId: "transfer",
      includeDownstream: false,
    });
    assert.doesNotThrow(() => assertPlanInputs(valid, eightEdges));

    const nineEdges = inputs.map((node) => edge(node.id, "transfer"));
    const invalid = buildExecutionPlan([...inputs, transfer], nineEdges, {
      onlyNodeId: "transfer",
      includeDownstream: false,
    });
    assert.throws(() => assertPlanInputs(invalid, nineEdges), /at most 8 reference images/);
  });

  await ok("环检测：A↔B 抛 DagError", () => {
    assert.throws(
      () => buildExecutionPlan([aiNode("a"), aiNode("b")], [edge("a", "b"), edge("b", "a")]),
      DagError,
    );
  });

  await ok("单节点重跑：范围外上游保留快照回退", () => {
    const plan = buildExecutionPlan(
      [aiNode("render", "sketch-to-render", ["/api/files/rendered.png"]), aiNode("modify", "ai-modify")],
      [edge("render", "modify")],
      { onlyNodeId: "modify" },
    );
    assert.strictEqual(plan.steps.length, 1);
    const modify = plan.steps[0];
    assert.deepStrictEqual(modify.upstream, [
      { nodeId: "render", images: ["/api/files/rendered.png"] },
    ]);
  });

  await ok("画布单节点执行：显式关闭下游扩展，避免额外 AI 调用", () => {
    const plan = buildExecutionPlan(
      [
        imgNode("input", "/api/files/seed.png"),
        aiNode("render", "sketch-to-render"),
        aiNode("modify", "ai-modify"),
        resultNode("out"),
      ],
      [edge("input", "render"), edge("render", "modify"), edge("modify", "out")],
      { onlyNodeId: "render", includeDownstream: false },
    );
    assert.deepStrictEqual(plan.steps.map((step) => step.nodeId), ["render"]);
    assert.deepStrictEqual(plan.steps[0].upstream, [
      { nodeId: "input", images: ["/api/files/seed.png"] },
    ]);
  });

  await ok("面料配色计划：保留颜色数组交给后端一色一图", () => {
    const recolor: FlowNode = {
      id: "recolor",
      type: "fabric-recolor",
      data: {
        kind: "fabric-recolor",
        label: "配色",
        status: "idle",
        colors: ["#112233", "#AABBCC"],
        prompt: "",
        outputImages: [],
      },
    };
    const plan = buildExecutionPlan([imgNode("input", "/api/files/seed.png"), recolor], [edge("input", "recolor")]);
    assert.deepStrictEqual(plan.steps.find((step) => step.nodeId === "recolor")?.params.colors, [
      "#112233",
      "#AABBCC",
    ]);
    assert.doesNotThrow(() => assertPlanInputs(plan, [edge("input", "recolor")]));
  });

  await ok("付费节点输入门禁：拒绝空输入与只有 fabric 的配色计划", () => {
    const modifyPlan = buildExecutionPlan([aiNode("modify", "ai-modify")], [], {
      onlyNodeId: "modify",
      includeDownstream: false,
    });
    assert.throws(() => assertPlanInputs(modifyPlan, []), /requires an upstream image/);

    const fabricOnly: FlowNode = {
      id: "recolor",
      type: "fabric-recolor",
      data: {
        kind: "fabric-recolor",
        label: "配色",
        status: "idle",
        colors: ["#112233"],
        prompt: "",
        outputImages: [],
      },
    };
    const fabricEdges = [{ ...edge("fabric", "recolor"), targetHandle: "fabric" }];
    const fabricPlan = buildExecutionPlan(
      [imgNode("fabric", "/api/files/seed.png"), fabricOnly],
      fabricEdges,
      { onlyNodeId: "recolor", includeDownstream: false },
    );
    assert.throws(() => assertPlanInputs(fabricPlan, fabricEdges), /requires a garment image/);
  });

  await ok("文生图：有提示词时允许生成节点无图片输入", () => {
    const plan = buildExecutionPlan([aiNode("generate", "sketch-to-render")], []);
    assert.doesNotThrow(() => assertPlanInputs(plan, []));
    const step = plan.steps[0];
    assert.equal(step.params.prompt, "test");
    assert.deepStrictEqual(step.inputImages, []);
  });

  await ok("runner 草图效果图：有参考图走 edit 并按批量返回", async () => {
    const prompt = "保留轮廓，渲染成真丝礼服";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "sketch-to-render",
      { prompt, aspectRatio: "3:4", batchSize: 2 },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL]);
    assert.strictEqual(calls[0].request.prompt, prompt);
    assert.strictEqual(calls[0].request.aspectRatio, "3:4");
    assert.strictEqual(calls[0].request.batchSize, 2);
    assert.strictEqual(result.images.length, 2);
    assert.deepStrictEqual(result.prompts, [prompt, prompt]);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 文生图：无参考图走 generate 并保留数量", async () => {
    const prompt = "生成一组沙漠金属感礼服";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "sketch-to-render",
      { prompt, aspectRatio: "16:9", batchSize: 2 },
      [],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "generate");
    assert.strictEqual(calls[0].request.referenceImages, undefined);
    assert.strictEqual(calls[0].request.prompt, prompt);
    assert.strictEqual(calls[0].request.batchSize, 2);
    assert.strictEqual(result.images.length, 2);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner AI 改款：多参考图顺序传入 edit 并生成用户数量", async () => {
    const prompt = "改成娃娃领和短袖";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "ai-modify",
      { prompt, aspectRatio: "1:1", batchSize: 4 },
      [SEED_DATA_URL, SECOND_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL, SECOND_DATA_URL]);
    assert.strictEqual(calls[0].request.prompt, prompt);
    assert.strictEqual(calls[0].request.batchSize, 4);
    assert.strictEqual(result.images.length, 4);
    assert.strictEqual(result.prompts?.length, 4);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 面料配色：一色一次 edit，成衣与面料参考均传入", async () => {
    const colors = ["#DE2910", "#002FA7"];
    const { calls, providerIds, result } = await runRecordedAiStep(
      "fabric-recolor",
      { colors, fabricImageUrl: SECOND_DATA_URL },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2"]);
    assert.strictEqual(calls.length, colors.length);
    assert.ok(calls.every((call) => call.method === "edit"));
    assert.ok(calls.every((call) => call.request.batchSize === 1));
    for (const call of calls) {
      assert.deepStrictEqual(call.request.referenceImages, [SEED_DATA_URL, SECOND_DATA_URL]);
    }
    assert.match(calls[0].request.prompt, /中国红\(#DE2910\)/);
    assert.match(calls[1].request.prompt, /克莱因蓝\(#002FA7\)/);
    assert.strictEqual(result.images.length, colors.length);
    assert.deepStrictEqual(result.prompts, calls.map((call) => call.request.prompt));
    assert.strictEqual(result.providerRequests, colors.length);
  });

  await ok("runner 高清放大：单参考图走 edit，固定单图并传递 2K", async () => {
    const { calls, providerIds, result } = await runRecordedAiStep(
      "upscale",
      { imageSize: "2K" },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL]);
    assert.match(calls[0].request.prompt, /放大为超高清版本/);
    assert.strictEqual(calls[0].request.imageSize, "2K");
    assert.strictEqual(calls[0].request.batchSize, 1);
    assert.strictEqual(result.images.length, 1);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 印花提取：参考图走 edit，合并固定与用户提示词", async () => {
    const extra = "只要胸前的主图案";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "print-extract",
      { prompt: extra },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL]);
    assert.match(calls[0].request.prompt, /提取这件衣服上的印花图案/);
    assert.match(calls[0].request.prompt, new RegExp(`补充要求：${extra}`));
    assert.strictEqual(calls[0].request.batchSize, 1);
    assert.strictEqual(result.images.length, 1);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("runner 印花裂变：参考图走 edit，按 count 返回且合并提示词", async () => {
    const extra = "转为水墨风格";
    const { calls, providerIds, result } = await runRecordedAiStep(
      "print-mutate",
      { prompt: extra, count: 3 },
      [SEED_DATA_URL],
    );
    assert.deepStrictEqual(providerIds, ["gpt-image-2"]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].method, "edit");
    assert.deepStrictEqual(calls[0].request.referenceImages, [SEED_DATA_URL]);
    assert.match(calls[0].request.prompt, /生成风格一致的新变体/);
    assert.match(calls[0].request.prompt, new RegExp(`补充要求：${extra}`));
    assert.strictEqual(calls[0].request.batchSize, 3);
    assert.strictEqual(result.images.length, 3);
    assert.strictEqual(result.prompts?.length, 3);
    assert.strictEqual(result.providerRequests, 1);
  });

  await ok("端到端（无 AI）：result 节点收到上游本次产出", async () => {
    // image-input → result：image-input 执行时产出图片，result 必须收到它
    const plan = buildExecutionPlan(
      [imgNode("input", "/api/files/seed.png"), resultNode("out")],
      [edge("input", "out")],
    );
    const run = await createRun(plan, TEST_OWNER_ID);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("run timeout")), 5000);
      run.emitter.on(
        "event",
        (e: { type: string; nodeId?: string; status?: string; images?: string[] }) => {
          if (e.type === "node-status" && e.nodeId === "out" && e.status === "success") {
            assert.deepStrictEqual(e.images, ["/api/files/seed.png"]);
          }
          if (e.type === "done") {
            clearTimeout(timer);
            resolve();
          }
          if (e.type === "run-error") {
            clearTimeout(timer);
            reject(new Error(`run failed: ${(e as { error?: string }).error}`));
          }
        },
      );
    });
  });

  await ok("runs 有界：终态 Run 超上限被清理", async () => {
    // 直接造 60 个终态 Run 再触发一次 createRun 的清理
    const plan = buildExecutionPlan([resultNode("x")], []);
    let oldestRunId = "";
    for (let i = 0; i < 60; i++) {
      const r = await createRun(plan, TEST_OWNER_ID);
      if (i === 0) oldestRunId = r.id;
      r.finished = true;
    }
    await createRun(plan, TEST_OWNER_ID);
    const probe = await createRun(plan, TEST_OWNER_ID);
    assert.ok(getRunForUser(probe.id, TEST_OWNER_ID), "新 Run 必须存在");
    assert.strictEqual(getRunForUser(probe.id, "another-owner"), undefined, "其他用户不能读取 Run");
    assert.strictEqual(getRunForUser(oldestRunId, TEST_OWNER_ID), undefined, "最老的终态 Run 必须已被回收");
  });

  console.log(`\n通过 ${passed} 项`);
}

void main().finally(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));
