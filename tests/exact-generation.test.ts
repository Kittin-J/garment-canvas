import assert from "node:assert/strict";
import sharp from "sharp";
import { postProcessGeneratedOutputImages } from "../server/engine/runner";
import {
  EXACT_ASPECT_DIMENSIONS,
  fitGeneratedImageToAspect,
  normalizeExactAspectRatio,
  normalizeUpscaleSize,
  upscaleImageToLongEdge,
} from "../server/lib/imagePostProcessing";
import { MAX_IMAGE_BYTES, validateImageDataUrl } from "../server/lib/imageValidation";
import {
  MAX_CONCURRENT_IMAGE_PROCESSING,
  withImageProcessingSlot,
} from "../server/lib/imageProcessingLimit";
import { generateExactImages } from "../server/providers/exact";
import {
  postProcessDirectGenerateImages,
  validateDirectGenerateRequest,
} from "../server/routes/generate";
import { requestedCountForStep } from "../server/routes/runPlan";
import { ProviderError } from "../server/providers/base";
import { imageExtensionFromReference } from "../src/lib/imageFormat";
import type { AIProvider } from "../src/types/workflow";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function fixtureDataUrl(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 55, g: 125, b: 85 } },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function imageInfo(dataUrl: string) {
  const { buffer } = validateImageDataUrl(dataUrl);
  return { metadata: await sharp(buffer).metadata(), byteLength: buffer.byteLength };
}

console.log("精确批量生成回归测试");

await test("上游忽略 n 每次只回一张时，AI 改款仍补足用户选择数量", async () => {
  let calls = 0;
  const provider: AIProvider = {
    id: "stub",
    async generate() { throw new Error("unexpected generate"); },
    async edit() {
      calls += 1;
      return { images: [`image-${calls}`], model: "stub-model" };
    },
  };
  const result = await generateExactImages(provider, {
    prompt: "改款", referenceImages: ["data:image/png;base64,AA=="], batchSize: 4,
  }, 4);
  assert.deepEqual(result.images, ["image-1", "image-2", "image-3", "image-4"]);
  assert.equal(result.providerRequests, 4);
  assert.deepEqual(result.failures, []);
});

await test("文生图同样补足数量，不只修复图生图节点", async () => {
  let calls = 0;
  const provider: AIProvider = {
    id: "stub",
    async generate() {
      calls += 1;
      return { images: [`generated-${calls}`], model: "stub-model" };
    },
    async edit() { throw new Error("unexpected edit"); },
  };
  const result = await generateExactImages(provider, { prompt: "服装效果图" }, 2);
  assert.equal(result.images.length, 2);
  assert.equal(calls, 2);
});

await test("内容安全拒绝是确定失败，不会为同一输入重复付费调用", async () => {
  let calls = 0;
  const provider: AIProvider = {
    id: "stub",
    async generate() {
      calls += 1;
      throw new ProviderError("内容拒绝", undefined, "stub", "content_refused");
    },
    async edit() { throw new Error("unexpected edit"); },
  };
  await assert.rejects(() => generateExactImages(provider, { prompt: "被拒绝" }, 4), ProviderError);
  assert.equal(calls, 1);
});

await test("印花裂变缺省 requested_count 与实际默认 4 张一致", async () => {
  assert.equal(requestedCountForStep("print-mutate", {}), 4);
  assert.equal(requestedCountForStep("print-mutate", { count: 7 }), 7);
});

await test("直连与 DAG 的 AI 批量生成统一限制为最多 8 张", async () => {
  assert.equal(requestedCountForStep("sketch-to-render", { batchSize: 8 }), 8);
  assert.equal(requestedCountForStep("ai-modify", { batchSize: 99 }), 8);
});

await test("部分成功保留图片并明确记录 N/M", async () => {
  let calls = 0;
  const provider: AIProvider = {
    id: "stub",
    async generate() {
      calls += 1;
      if (calls <= 2) return { images: [`ok-${calls}`], model: "stub-model" };
      throw new Error("gateway timeout");
    },
    async edit() { throw new Error("unexpected edit"); },
  };
  const result = await generateExactImages(provider, { prompt: "四张" }, 4);
  assert.deepEqual(result.images, ["ok-1", "ok-2"]);
  assert.ok(result.failures.some((message) => message.includes("2/4")));
});

await test("五种用户画幅均输出精确像素尺寸和比例", async () => {
  const source = await fixtureDataUrl(120, 200);
  for (const [ratio, expected] of Object.entries(EXACT_ASPECT_DIMENSIONS)) {
    const output = await fitGeneratedImageToAspect(source, ratio);
    const { metadata, byteLength } = await imageInfo(output);
    assert.equal(metadata.width, expected.width, ratio);
    assert.equal(metadata.height, expected.height, ratio);
    const [ratioWidth, ratioHeight] = ratio.split(":").map(Number);
    assert.equal(expected.width * ratioHeight, expected.height * ratioWidth, ratio);
    assert.ok(byteLength <= MAX_IMAGE_BYTES, `${ratio} output must stay within 20 MB`);
  }
});

await test("固定画幅使用 contain 保留完整内容，不将竖图拉伸成方图", async () => {
  const border = Buffer.from(
    '<svg width="100" height="200"><rect x="2" y="2" width="96" height="196" fill="none" stroke="#ff0000" stroke-width="4"/></svg>',
  );
  const input = await sharp({
    create: { width: 100, height: 200, channels: 3, background: { r: 20, g: 180, b: 40 } },
  }).composite([{ input: border }]).png().toBuffer();
  const output = await fitGeneratedImageToAspect(
    `data:image/png;base64,${input.toString("base64")}`,
    "1:1",
  );
  const { buffer } = validateImageDataUrl(output);
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const redColumns: number[] = [];
  const y = Math.floor(info.height / 2);
  for (let x = 0; x < info.width; x += 1) {
    const offset = (y * info.width + x) * info.channels;
    if (data[offset] > 150 && data[offset + 1] < 110 && data[offset + 2] < 110) redColumns.push(x);
  }
  assert.ok(redColumns.length > 0, "fixture border should remain visible");
  assert.ok(Math.min(...redColumns) > 230, "left padding should remain instead of stretching content");
  assert.ok(Math.max(...redColumns) < 794, "right padding should remain instead of stretching content");
});

await test("高清放大保持原比例，2K/4K 长边精确且文件不超 20 MB", async () => {
  const portrait2K = await upscaleImageToLongEdge(await fixtureDataUrl(100, 200), "2K");
  const portraitInfo = await imageInfo(portrait2K);
  assert.equal(portraitInfo.metadata.width, 1024);
  assert.equal(portraitInfo.metadata.height, 2048);
  assert.ok(portraitInfo.byteLength <= MAX_IMAGE_BYTES);

  const landscape4K = await upscaleImageToLongEdge(await fixtureDataUrl(320, 180), "4K");
  const landscapeInfo = await imageInfo(landscape4K);
  assert.equal(landscapeInfo.metadata.width, 4096);
  assert.equal(landscapeInfo.metadata.height, 2304);
  assert.ok(landscapeInfo.byteLength <= MAX_IMAGE_BYTES);
});

await test("runner 仅对生成/改款画幅和高清放大应用尺寸后处理", async () => {
  const portrait = await fixtureDataUrl(100, 200);
  const sketch = await postProcessGeneratedOutputImages("sketch-to-render", { aspectRatio: "9:16" }, [portrait]);
  assert.deepEqual((await imageInfo(sketch[0])).metadata.width, 864);
  assert.deepEqual((await imageInfo(sketch[0])).metadata.height, 1536);

  const landscape = await fixtureDataUrl(200, 100);
  const modify = await postProcessGeneratedOutputImages("ai-modify", { aspectRatio: "16:9" }, [landscape]);
  assert.equal((await imageInfo(modify[0])).metadata.width, 1536);
  assert.equal((await imageInfo(modify[0])).metadata.height, 864);

  const upscale = await postProcessGeneratedOutputImages("upscale", { imageSize: "2K" }, [landscape]);
  assert.equal((await imageInfo(upscale[0])).metadata.width, 2048);
  assert.equal((await imageInfo(upscale[0])).metadata.height, 1024);

  const untouched = [portrait];
  assert.strictEqual(await postProcessGeneratedOutputImages("print-extract", {}, untouched), untouched);
});

await test("直接生成接口对显式节点种类严格校验尺寸参数", async () => {
  assert.deepEqual(
    validateDirectGenerateRequest("sketch-to-render", { prompt: "效果图", aspectRatio: "3:4" }),
    { ok: true, kind: "sketch-to-render" },
  );
  assert.deepEqual(
    validateDirectGenerateRequest("upscale", { prompt: "放大", imageSize: "4K" }),
    { ok: true, kind: "upscale" },
  );
  assert.deepEqual(
    validateDirectGenerateRequest(undefined, { prompt: "旧请求没有 kind" }),
    { ok: true },
  );
  assert.equal(validateDirectGenerateRequest("result", { prompt: "非 AI 节点" }).ok, false);
  assert.equal(
    validateDirectGenerateRequest("sketch-to-render", { prompt: "缺少比例" }).ok,
    false,
  );
  assert.equal(
    validateDirectGenerateRequest("ai-modify", { prompt: "错误比例", aspectRatio: "2:3" }).ok,
    false,
  );
  assert.equal(
    validateDirectGenerateRequest("upscale", { prompt: "错误尺寸", imageSize: "8K" }).ok,
    false,
  );
  assert.deepEqual(
    validateDirectGenerateRequest("print-mutate", { prompt: "其他 AI 节点不要尺寸参数" }),
    { ok: true, kind: "print-mutate" },
  );
});

await test("直接生成接口复用 runner 的精确比例与 2K/4K 后处理", async () => {
  const portrait = await fixtureDataUrl(100, 200);
  const sketch = await postProcessDirectGenerateImages(
    "sketch-to-render",
    { prompt: "效果图", aspectRatio: "9:16" },
    [portrait],
  );
  assert.equal((await imageInfo(sketch[0])).metadata.width, 864);
  assert.equal((await imageInfo(sketch[0])).metadata.height, 1536);

  const landscape = await fixtureDataUrl(200, 100);
  const modify = await postProcessDirectGenerateImages(
    "ai-modify",
    { prompt: "改款", aspectRatio: "16:9" },
    [landscape],
  );
  assert.equal((await imageInfo(modify[0])).metadata.width, 1536);
  assert.equal((await imageInfo(modify[0])).metadata.height, 864);

  const upscale = await postProcessDirectGenerateImages(
    "upscale",
    { prompt: "高清放大", imageSize: "4K" },
    [landscape],
  );
  assert.equal((await imageInfo(upscale[0])).metadata.width, 4096);
  assert.equal((await imageInfo(upscale[0])).metadata.height, 2048);

  const untouched = [portrait];
  assert.strictEqual(
    await postProcessDirectGenerateImages("fabric-recolor", { prompt: "换色" }, untouched),
    untouched,
  );
  assert.strictEqual(
    await postProcessDirectGenerateImages(undefined, { prompt: "旧请求保持原始输出" }, untouched),
    untouched,
  );
});

await test("runner 对旧项目缺省或无效尺寸参数安全回退", async () => {
  assert.equal(normalizeExactAspectRatio(undefined), "1:1");
  assert.equal(normalizeExactAspectRatio("2:3"), "1:1");
  assert.equal(normalizeUpscaleSize(undefined), "2K");
  assert.equal(normalizeUpscaleSize("8K"), "2K");

  const portrait = await fixtureDataUrl(100, 200);
  const missingAspect = await postProcessGeneratedOutputImages("ai-modify", {}, [portrait]);
  const aspectInfo = await imageInfo(missingAspect[0]);
  assert.equal(aspectInfo.metadata.width, 1024);
  assert.equal(aspectInfo.metadata.height, 1024);

  const landscape = await fixtureDataUrl(200, 100);
  const invalidUpscale = await postProcessGeneratedOutputImages("upscale", { imageSize: "8K" }, [landscape]);
  const upscaleInfo = await imageInfo(invalidUpscale[0]);
  assert.equal(upscaleInfo.metadata.width, 2048);
  assert.equal(upscaleInfo.metadata.height, 1024);
});

await test("结果下载能从 data URL 和本地文件 URL 推导真实扩展名", async () => {
  assert.equal(imageExtensionFromReference("data:image/webp;base64,UklGRg=="), "webp");
  assert.equal(imageExtensionFromReference("data:image/jpeg;base64,/9j/"), "jpg");
  assert.equal(imageExtensionFromReference("/api/files/result.PNG"), "png");
  assert.equal(imageExtensionFromReference("/api/files/result.jpeg?download=1"), "jpg");
  assert.equal(imageExtensionFromReference("http://127.0.0.1:3002/api/files/result.gif"), "gif");
  assert.equal(imageExtensionFromReference("https://cdn.example/result.webp"), undefined);
  assert.equal(imageExtensionFromReference("data:image/svg+xml;base64,PHN2Zz4="), undefined);
});

await test("本地图像处理队列最多同时执行两项并在异常后释放名额", async () => {
  let active = 0;
  let peak = 0;
  let releaseFirstWave: (() => void) | undefined;
  const firstWave = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
  let started = 0;
  let firstWaveStarted: (() => void) | undefined;
  const firstWaveReady = new Promise<void>((resolve) => { firstWaveStarted = resolve; });

  const jobs = Array.from({ length: 5 }, (_, index) => withImageProcessingSlot(async () => {
    active += 1;
    peak = Math.max(peak, active);
    started += 1;
    if (started === MAX_CONCURRENT_IMAGE_PROCESSING) firstWaveStarted?.();
    try {
      if (index < MAX_CONCURRENT_IMAGE_PROCESSING) await firstWave;
      if (index === 2) throw new Error("expected test failure");
    } finally {
      active -= 1;
    }
  }));

  await firstWaveReady;
  assert.equal(started, MAX_CONCURRENT_IMAGE_PROCESSING);
  releaseFirstWave?.();
  const settled = await Promise.allSettled(jobs);
  assert.equal(peak, MAX_CONCURRENT_IMAGE_PROCESSING);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);

  await withImageProcessingSlot(async () => undefined);
});

console.log(`\n通过 ${passed} 项`);
