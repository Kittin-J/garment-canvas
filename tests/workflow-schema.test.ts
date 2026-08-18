import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeJsonAtomicSync } from "../server/lib/atomicJson";
import {
  assertUrlAllowed,
  downloadImageToDataUrl,
  ensureThumbnail,
  isGlobalIpAddress,
  type HostLookup,
  type ImageFetch,
} from "../server/lib/fileStore";
import {
  ImageValidationError,
  isLocalImageReference,
  validateImageDataUrl,
} from "../server/lib/imageValidation";
import { validateAndMigrateFlow, WorkflowValidationError } from "../server/lib/workflowSchema";
import { ensureBuiltinTemplates } from "../server/routes/templates";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString("base64")}`;

let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try {
    await run();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

const legacyAiFlow = () => ({
  nodes: [
    {
      id: "n1",
      type: "ai-modify",
      position: { x: 1, y: 2 },
      data: { kind: "ai-modify", label: "改款", status: "idle", prompt: "", outputImages: [] },
    },
  ],
  edges: [],
});

async function main() {
  console.log("工作流 Schema / 图片 / SSRF 回归测试");

  await test("无版本 v0 确定性迁移到 v1，并补 ai-modify 默认字段", () => {
    const first = validateAndMigrateFlow(legacyAiFlow());
    const second = validateAndMigrateFlow(first);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.nodes[0].data.kind, "ai-modify");
    if (first.nodes[0].data.kind !== "ai-modify") throw new Error("unexpected node kind");
    assert.equal(first.nodes[0].data.aspectRatio, "1:1");
    assert.equal(first.nodes[0].data.batchSize, 1);
    assert.deepEqual(second, first);
  });

  await test("拒绝未知版本、kind/type 不符、非法批量与悬空边", () => {
    assert.throws(() => validateAndMigrateFlow({ ...legacyAiFlow(), schemaVersion: 99 }), WorkflowValidationError);
    const mismatch = legacyAiFlow();
    mismatch.nodes[0].data.kind = "result" as "ai-modify";
    assert.throws(() => validateAndMigrateFlow(mismatch), /must equal node type/);
    const batch = legacyAiFlow();
    Object.assign(batch.nodes[0].data, { batchSize: 3 });
    assert.throws(() => validateAndMigrateFlow(batch), /batchSize/);
    const dangling = legacyAiFlow();
    dangling.edges.push({ id: "e1", source: "n1", target: "missing" } as never);
    assert.throws(() => validateAndMigrateFlow(dangling), /target not found/);
    const spoofedImage = legacyAiFlow();
    Object.assign(spoofedImage.nodes[0].data, {
      outputImages: [`data:image/jpeg;base64,${PNG.toString("base64")}`],
    });
    assert.throws(() => validateAndMigrateFlow(spoofedImage), /MIME\/signature mismatch/);
  });

  await test("运行态不会写进项目：queued/running/error 读取时归一为 idle", () => {
    for (const status of ["queued", "running", "error"] as const) {
      const flow = legacyAiFlow();
      Object.assign(flow.nodes[0].data, { status, error: "transient failure" });
      const normalized = validateAndMigrateFlow(flow);
      assert.equal(normalized.nodes[0].data.status, "idle");
      assert.equal(normalized.nodes[0].data.error, undefined);
    }
  });

  await test("工作流 Schema 拒绝超过节点上限的参考图连接", () => {
    const flow = legacyAiFlow();
    for (let index = 0; index < 9; index += 1) {
      flow.nodes.push({
        id: `ref${index}`,
        type: "image-input",
        position: { x: 0, y: index * 10 },
        data: {
          kind: "image-input",
          label: `ref${index}`,
          status: "idle",
          imageRole: "reference",
        },
      } as never);
      flow.edges.push({ id: `e${index}`, source: `ref${index}`, target: "n1" } as never);
    }
    assert.throws(() => validateAndMigrateFlow(flow), /accepts at most 8 incoming image connections/);
  });

  await test("图片上传节点只接受单个 imageUrl 字段", () => {
    const flow = {
      nodes: [{
        id: "upload",
        type: "image-input",
        position: { x: 0, y: 0 },
        data: {
          kind: "image-input",
          label: "单图上传",
          status: "idle",
          imageRole: "reference",
          imageUrl: ["/api/files/one.png", "/api/files/two.png"],
        },
      }],
      edges: [],
    };
    assert.throws(() => validateAndMigrateFlow(flow), /imageUrl/);
  });

  await test("干净检出也可迁移旧项目，并校验仓库内置模板", () => {
    // 不依赖被 .gitignore 排除的 data/projects；旧项目夹具必须由测试自己提供。
    const legacyProject = {
      id: "legacy-project",
      name: "旧项目",
      updatedAt: "2026-01-01T00:00:00.000Z",
      flow: legacyAiFlow(),
    };
    assert.equal(validateAndMigrateFlow(legacyProject.flow).schemaVersion, 1);

    const builtinRoot = "data/templates/builtin";
    const builtinFiles = fs.readdirSync(builtinRoot).filter((name) => name.endsWith(".json"));
    assert.equal(builtinFiles.length, 6, "仓库应包含六份内置模板");
    for (const file of builtinFiles) {
      const value = JSON.parse(fs.readFileSync(path.join(builtinRoot, file), "utf-8")) as { flow: unknown };
      assert.equal(validateAndMigrateFlow(value.flow).schemaVersion, 1, `${builtinRoot}/${file}`);
    }
    for (const [file, expected] of [
      ["builtin-person-scene-transfer.json", ["subject", "scene"]],
      ["builtin-pattern-style-transfer.json", ["pattern", "style"]],
    ] as const) {
      const transfer = JSON.parse(fs.readFileSync(path.join(builtinRoot, file), "utf-8")) as {
        flow: { edges: Array<{ source: string; target: string }> };
      };
      assert.deepEqual(
        transfer.flow.edges.filter((edge) => edge.target === "transfer").map((edge) => edge.source),
        expected,
        `${file} 必须按图1、图2顺序传入参考图`,
      );
    }
    const textToImage = JSON.parse(
      fs.readFileSync(path.join(builtinRoot, "builtin-text-to-image.json"), "utf-8"),
    ) as { flow: { nodes: Array<{ id: string; data: { prompt?: string } }>; edges: unknown[] } };
    const generateNode = textToImage.flow.nodes.find((node) => node.id === "generate");
    assert.ok(generateNode?.data.prompt?.trim(), "文生图模板必须提供可编辑的示例提示词");
    assert.equal(textToImage.flow.edges.length, 1, "文生图结果应自动汇总到结果节点");
  });

  await test("已有数据目录增量补齐新内置模板且不覆盖现有文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-templates-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      const builtinDir = path.join(dir, "templates", "builtin");
      fs.mkdirSync(builtinDir, { recursive: true });
      const existingPath = path.join(builtinDir, "builtin-sketch-recolor.json");
      fs.writeFileSync(existingPath, "preserve-existing", "utf-8");
      fs.writeFileSync(path.join(builtinDir, "builtin-style-transfer.json"), "deprecated", "utf-8");

      ensureBuiltinTemplates();

      assert.equal(fs.readFileSync(existingPath, "utf-8"), "preserve-existing");
      assert.equal(fs.existsSync(path.join(builtinDir, "builtin-style-transfer.json")), false);
      assert.deepEqual(
        fs.readdirSync(builtinDir).filter((name) => name.endsWith(".json")).sort(),
        [
          "builtin-pattern-style-transfer.json",
          "builtin-person-scene-transfer.json",
          "builtin-sketch-recolor.json",
          "builtin-sketch-upscale.json",
          "builtin-text-recolor.json",
          "builtin-text-to-image.json",
        ],
      );
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("图片 dataURL 校验 MIME、魔数、base64 和体积", () => {
    const parsed = validateImageDataUrl(PNG_DATA_URL);
    assert.equal(parsed.mime, "image/png");
    assert.deepEqual(parsed.buffer, PNG);
    assert.throws(() => validateImageDataUrl(`data:image/jpeg;base64,${PNG.toString("base64")}`), /mismatch/);
    assert.throws(() => validateImageDataUrl("data:image/png;base64,abc$"), ImageValidationError);
    assert.throws(() => validateImageDataUrl(PNG_DATA_URL, PNG.length - 1), /too large/);
    assert.equal(isLocalImageReference("/api/files/abc_12-x.png"), true);
    assert.equal(isLocalImageReference("https://example.com/a.png"), false);
    assert.equal(isLocalImageReference("/api/files/../secret.png"), false);
  });

  await test("原子 JSON 写入留下完整目标且无临时文件", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-json-"));
    try {
      const target = path.join(dir, "project.json");
      writeJsonAtomicSync(target, { version: 1 });
      writeJsonAtomicSync(target, { version: 2, nested: { ok: true } });
      assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf-8")), { version: 2, nested: { ok: true } });
      assert.deepEqual(fs.readdirSync(dir), ["project.json"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("服务端为原图生成可复用 WebP 缩略图缓存", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-thumbnails-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      const uploads = path.join(dir, "uploads");
      fs.mkdirSync(uploads, { recursive: true });
      fs.writeFileSync(path.join(uploads, "source.png"), PNG);
      const first = await ensureThumbnail("source.png");
      const second = await ensureThumbnail("source.png");
      assert.equal(first, second);
      const bytes = fs.readFileSync(first);
      assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
      assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("缩略图拒绝超过四千万像素的输入且不留下临时文件", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-thumbnail-limit-"));
    const originalDataDir = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = dir;
      const uploads = path.join(dir, "uploads");
      fs.mkdirSync(uploads, { recursive: true });
      const oversizedPng = Buffer.from(PNG);
      oversizedPng.writeUInt32BE(10_000, 16);
      oversizedPng.writeUInt32BE(5_000, 20);
      fs.writeFileSync(path.join(uploads, "oversized.png"), oversizedPng);

      await assert.rejects(() => ensureThumbnail("oversized.png"), /pixel limit/i);
      assert.deepEqual(fs.readdirSync(path.join(dir, "thumbnails")), []);
    } finally {
      if (originalDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = originalDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test("IP 分类拒绝内网、回环、链路本地、ULA 和 IPv4-mapped", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.1", "::1", "fe80::1", "fd00::1", "::192.168.1.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "2002:c0a8:101::"]) {
      assert.equal(isGlobalIpAddress(address), false, address);
    }
    assert.equal(isGlobalIpAddress("8.8.8.8"), true);
    assert.equal(isGlobalIpAddress("2606:4700:4700::1111"), true);
  });

  await test("域名任一 DNS 地址非 global 即阻断", async () => {
    await assert.rejects(
      () => assertUrlAllowed("https://images.example/a.png", async () => ["93.184.216.34", "192.168.1.2"]),
      /blocked non-global/,
    );
    const allowed = await assertUrlAllowed("https://images.example/a.png", async () => ["93.184.216.34"]);
    assert.equal(allowed.hostname, "images.example");
  });

  await test("手动重定向在请求下一跳前重新解析并阻断私网", async () => {
    const calls: string[] = [];
    const lookup: HostLookup = async (host) => host === "public.example" ? ["93.184.216.34"] : ["192.168.1.1"];
    const fetcher: ImageFetch = async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "http://nas.internal/photo.png" } });
    };
    await assert.rejects(
      () => downloadImageToDataUrl("https://public.example/photo.png", { lookup, fetch: fetcher }),
      /private\/metadata|non-global/,
    );
    assert.equal(calls.length, 1, "私网重定向目标不应被请求");
  });

  await test("合法逐跳重定向返回经魔数验证的图片", async () => {
    const calls: string[] = [];
    const lookup: HostLookup = async () => ["93.184.216.34"];
    const fetcher: ImageFetch = async (input, init) => {
      calls.push(String(input));
      assert.equal(init?.redirect, "manual");
      if (calls.length === 1) return new Response(null, { status: 302, headers: { location: "/final.png" } });
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG.length) } });
    };
    const result = await downloadImageToDataUrl("https://images.example/start", { lookup, fetch: fetcher });
    assert.equal(result, PNG_DATA_URL);
    assert.deepEqual(calls, ["https://images.example/start", "https://images.example/final.png"]);
  });

  console.log(`\n通过 ${passed} 项`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
