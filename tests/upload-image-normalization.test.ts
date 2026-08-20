import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import sharp from "sharp";
import type { AIProvider, NodeExecution } from "../src/types/workflow";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-upload-normalization-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "normalization-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, initializeDatabase, query, queryOne } = await import("../server/lib/database");
const { filesRouter } = await import("../server/routes/files");
const { uploadsDir } = await import("../server/lib/fileStore");
const { executeStep, resolveImageRefs } = await import("../server/engine/runner");
const { validateImageDataUrl } = await import("../server/lib/imageValidation");
const {
  normalizeUploadImageDataUrl,
  UPLOAD_MAX_LONG_EDGE,
  UPLOAD_TARGET_BYTES,
} = await import("../server/lib/uploadImageNormalization");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function dataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

async function startFilesServer(ownerId: string) {
  const app = express();
  app.use(express.json({ limit: "50mb" }));
  app.use((req, _res, next) => {
    const id = req.headers["x-test-owner"] === "missing" ? "missing-owner" : ownerId;
    (req as Request & { authUser: unknown }).authUser = {
      id, accountId: id, displayName: id, role: "admin", mustChangePassword: false,
    };
    next();
  });
  app.use("/api/files", filesRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

console.log("用户上传图片标准化回归测试");
await initializeDatabase();

await test("JPEG、PNG、WebP 与 GIF 统一转为标准 JPEG/PNG，动画只取首帧", async () => {
  const jpeg = await sharp({ create: { width: 120, height: 80, channels: 3, background: "red" } })
    .jpeg().toBuffer();
  const opaquePng = await sharp({ create: { width: 90, height: 70, channels: 3, background: "green" } })
    .png().toBuffer();
  const webp = await sharp({ create: { width: 80, height: 60, channels: 3, background: "blue" } })
    .webp().toBuffer();
  const frames = Buffer.alloc(2 * 4 * 3);
  for (let index = 0; index < 4; index += 1) frames[index * 3] = 255;
  for (let index = 4; index < 8; index += 1) frames[index * 3 + 2] = 255;
  const gif = await sharp(frames, { raw: { width: 2, height: 4, channels: 3, pageHeight: 2 } })
    .gif({ delay: [100, 100], loop: 0 }).toBuffer();

  for (const [mime, buffer] of [
    ["image/jpeg", jpeg], ["image/png", opaquePng], ["image/webp", webp], ["image/gif", gif],
  ] as const) {
    const normalized = await normalizeUploadImageDataUrl(dataUrl(mime, buffer));
    assert.equal(normalized.mimeType, "image/jpeg");
    assert.ok(normalized.byteLength <= UPLOAD_TARGET_BYTES);
    const metadata = await sharp(normalized.buffer).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.ok((metadata.pages ?? 1) === 1);
  }

  const normalizedGif = await normalizeUploadImageDataUrl(dataUrl("image/gif", gif));
  const firstPixel = await sharp(normalizedGif.buffer).raw().toBuffer();
  assert.ok(firstPixel[0] > 200 && firstPixel[2] < 40, "GIF 输出应来自红色第一帧");
});

await test("有效 Alpha 保留为 PNG，完全不透明 Alpha 转为 JPEG", async () => {
  const transparent = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 150, b: 80, alpha: 0.5 } },
  }).png().toBuffer();
  const opaqueAlpha = await sharp({
    create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 150, b: 80, alpha: 1 } },
  }).png().toBuffer();

  const preserved = await normalizeUploadImageDataUrl(dataUrl("image/png", transparent));
  assert.equal(preserved.mimeType, "image/png");
  const alpha = await sharp(preserved.buffer).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  assert.ok(alpha.some((value) => value < 255));

  const flattened = await normalizeUploadImageDataUrl(dataUrl("image/png", opaqueAlpha));
  assert.equal(flattened.mimeType, "image/jpeg");
});

await test("EXIF 方向落实到像素且长边收敛到 4096", async () => {
  const oriented = await sharp({ create: { width: 300, height: 500, channels: 3, background: "navy" } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const normalizedOriented = await normalizeUploadImageDataUrl(dataUrl("image/jpeg", oriented));
  assert.deepEqual([normalizedOriented.width, normalizedOriented.height], [500, 300]);
  assert.equal((await sharp(normalizedOriented.buffer).metadata()).orientation, undefined);

  const large = await sharp({ create: { width: 5000, height: 1000, channels: 3, background: "white" } })
    .jpeg().toBuffer();
  const normalizedLarge = await normalizeUploadImageDataUrl(dataUrl("image/jpeg", large));
  assert.equal(Math.max(normalizedLarge.width, normalizedLarge.height), UPLOAD_MAX_LONG_EDGE);
  assert.ok(normalizedLarge.byteLength <= UPLOAD_TARGET_BYTES);
});

await test("高熵图片通过质量与尺寸循环收敛到 1.5MB", async () => {
  const width = 1400;
  const height = 1400;
  const noisy = await sharp(randomBytes(width * height * 3), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: "4:4:4" }).toBuffer();
  const normalized = await normalizeUploadImageDataUrl(dataUrl("image/jpeg", noisy));
  assert.ok(normalized.byteLength <= UPLOAD_TARGET_BYTES);
  assert.ok(normalized.width <= width && normalized.height <= height);
});

await test("超过 40MP 的输入在解码门禁拒绝", async () => {
  const oversized = await sharp({
    create: { width: 6400, height: 6300, channels: 3, background: "white" },
  }).jpeg({ quality: 20 }).toBuffer();
  await assert.rejects(
    () => normalizeUploadImageDataUrl(dataUrl("image/jpeg", oversized)),
    /图片像素过大/,
  );
});

await test("上传接口仅在标准化与数据库写入都成功后返回 URL", async () => {
  const admin = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE account_id = 'normalization-admin'",
  );
  assert.ok(admin);
  const server = await startFilesServer(admin.id);
  try {
    const broken = dataUrl("image/png", Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
    ]));
    const rejected = await fetch(`${server.baseUrl}/api/files`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: broken }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM files"))?.count, 0);
    assert.deepEqual(fs.readdirSync(uploadsDir()), []);

    const source = await sharp({ create: { width: 96, height: 64, channels: 3, background: "#336699" } })
      .webp().toBuffer();
    const accepted = await fetch(`${server.baseUrl}/api/files`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: dataUrl("image/webp", source) }),
    });
    assert.equal(accepted.status, 200);
    const body = await accepted.json() as {
      id: string; url: string; mimeType: string; width: number; height: number; byteLength: number; normalized: boolean;
    };
    assert.equal(body.normalized, true);
    assert.equal(body.mimeType, "image/jpeg");
    assert.deepEqual([body.width, body.height], [96, 64]);
    assert.equal(fs.statSync(path.join(uploadsDir(), body.id)).size, body.byteLength);
    assert.deepEqual(await queryOne<Record<string, unknown>>(`
      SELECT mime_type, width, height, byte_length, normalized FROM files WHERE id = $1
    `, [body.id]), {
      mime_type: body.mimeType, width: body.width, height: body.height,
      byte_length: body.byteLength, normalized: true,
    });

    const beforeFiles = fs.readdirSync(uploadsDir()).sort();
    const databaseFailure = await fetch(`${server.baseUrl}/api/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-owner": "missing" },
      body: JSON.stringify({ dataUrl: dataUrl("image/webp", source) }),
    });
    assert.equal(databaseFailure.status, 500);
    assert.deepEqual(fs.readdirSync(uploadsDir()).sort(), beforeFiles);
  } finally {
    await server.close();
  }
});

await test("Provider 调用前会标准化旧素材请求副本，失败时不会发起付费调用", async () => {
  const admin = await queryOne<{ id: string }>(
    "SELECT id FROM users WHERE account_id = 'normalization-admin'",
  );
  assert.ok(admin);

  const legacyId = "legacy-runtime-input.webp";
  const legacyBuffer = await sharp({
    create: { width: 5000, height: 1000, channels: 3, background: "#735b42" },
  }).webp({ quality: 96 }).toBuffer();
  fs.writeFileSync(path.join(uploadsDir(), legacyId), legacyBuffer);
  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, $2, 'legacy', $3)
  `, [legacyId, admin.id, new Date().toISOString()]);

  const [prepared] = await resolveImageRefs([`/api/files/${legacyId}`]);
  const preparedImage = validateImageDataUrl(prepared);
  const preparedMetadata = await sharp(preparedImage.buffer).metadata();
  assert.equal(preparedImage.mime, "image/jpeg");
  assert.equal(Math.max(preparedMetadata.width ?? 0, preparedMetadata.height ?? 0), UPLOAD_MAX_LONG_EDGE);
  assert.ok(preparedImage.buffer.byteLength <= UPLOAD_TARGET_BYTES);
  assert.deepEqual(fs.readFileSync(path.join(uploadsDir(), legacyId)), legacyBuffer, "运行时适配不能改写原素材");

  let paidCalls = 0;
  let receivedReference = "";
  const provider: AIProvider = {
    id: "normalization-gate-test",
    async generate() {
      paidCalls += 1;
      return { images: [prepared], model: "normalization-gate-test" };
    },
    async edit(request) {
      paidCalls += 1;
      receivedReference = request.referenceImages?.[0] ?? "";
      return { images: [prepared], model: "normalization-gate-test" };
    },
  };
  const step: NodeExecution = {
    nodeId: "normalization-gate",
    kind: "print-extract",
    inputImages: [`/api/files/${legacyId}`],
    params: { prompt: "提取主图案" },
  };
  await executeStep(step, step.inputImages, () => provider);
  assert.equal(paidCalls, 1);
  assert.equal(validateImageDataUrl(receivedReference).mime, "image/jpeg");

  const brokenId = "legacy-broken-input.png";
  const brokenBuffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
  ]);
  fs.writeFileSync(path.join(uploadsDir(), brokenId), brokenBuffer);
  await query(`
    INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, $2, 'legacy', $3)
  `, [brokenId, admin.id, new Date().toISOString()]);
  const brokenStep: NodeExecution = {
    ...step,
    nodeId: "normalization-gate-broken",
    inputImages: [`/api/files/${brokenId}`],
  };
  await assert.rejects(
    () => executeStep(brokenStep, brokenStep.inputImages, () => provider),
    /无法完成标准化处理|无法读取图片|corrupt|invalid/i,
  );
  assert.equal(paidCalls, 1, "素材标准化失败时不得调用 Provider");
});

await test("前端未拿到 normalized:true 时不会把图片写入节点", () => {
  const source = fs.readFileSync(new URL("../src/components/nodes/ImageInputNode.tsx", import.meta.url), "utf8");
  assert.match(source, /data\.normalized !== true[\s\S]*服务端未完成素材标准化/);
  assert.match(source, /const upload = await uploadFile\(file\)[\s\S]*imageUrl: upload\.url/);
});

await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
console.log(`通过 ${passed} 项上传图片标准化测试`);
