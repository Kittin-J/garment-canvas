import assert from "node:assert/strict";
import {
  pendingExportImages,
  resultExportFilename,
  saveImagesToDirectory,
  supportsDirectoryPicker,
} from "../src/lib/resultExport";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

console.log("结果图本地导出工具测试");

await test("/api/files 引用用文件 id 作稳定文件名", () => {
  assert.equal(resultExportFilename("/api/files/abc123.png"), "garment-abc123.png");
  assert.equal(resultExportFilename("/api/files/xY_9-z"), "garment-xY_9-z");
});

await test("非 files 引用使用稳定哈希命名，分批保存不会覆盖其他图片", () => {
  const first = resultExportFilename("data:image/webp;base64,AAAA");
  const second = resultExportFilename("data:image/webp;base64,BBBB");
  assert.match(first, /^garment-result-[a-z0-9]{7}\.webp$/);
  assert.equal(first, resultExportFilename("data:image/webp;base64,AAAA"));
  assert.notEqual(first, second);
});

await test("pendingExportImages 只返回未保存过的新图并保持顺序", () => {
  const saved = new Set(["/api/files/a", "/api/files/b"]);
  assert.deepEqual(
    pendingExportImages(saved, ["/api/files/a", "/api/files/c", "/api/files/b", "/api/files/d"]),
    ["/api/files/c", "/api/files/d"],
  );
  assert.deepEqual(pendingExportImages(saved, ["/api/files/a", "/api/files/b"]), []);
});

await test("写盘结果只返回真正成功的引用，失败图片可继续重试", async () => {
  const originalFetch = globalThis.fetch;
  const written: string[] = [];
  globalThis.fetch = (async (ref: string | URL | Request) => {
    const value = String(ref);
    if (value.endsWith("failed")) return new Response("no", { status: 500 });
    return new Response("image", { status: 200 });
  }) as typeof fetch;
  const handle = {
    async getFileHandle(name: string) {
      return {
        async createWritable() {
          return {
            async write() { written.push(name); },
            async close() {},
          };
        },
      };
    },
  } as unknown as FileSystemDirectoryHandle;
  try {
    const result = await saveImagesToDirectory(handle, ["/api/files/success.png", "/api/files/failed"]);
    assert.equal(result.saved, 1);
    assert.deepEqual(result.savedImages, ["/api/files/success.png"]);
    assert.equal(result.errors.length, 1);
    assert.deepEqual(written, ["garment-success.png"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test("Node 环境下不支持文件夹选择器（前端会回退为逐张下载）", () => {
  assert.equal(supportsDirectoryPicker(), false);
});

console.log(`\n通过 ${passed} 项`);
