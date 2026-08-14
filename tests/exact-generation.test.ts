import assert from "node:assert/strict";
import { generateExactImages } from "../server/providers/exact";
import type { AIProvider } from "../src/types/workflow";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
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

console.log(`\n通过 ${passed} 项`);
