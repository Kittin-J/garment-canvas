import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { mountProductionFrontend } from "../server/lib/staticFrontend";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-static-"));
const assets = path.join(temp, "assets");
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(temp, "index.html"), "<!doctype html><title>fixture</title><div id=\"root\"></div>");
fs.writeFileSync(path.join(temp, "favicon.ico"), Buffer.from([0x00, 0x00, 0x01, 0x00, 0x00, 0x00]));
fs.writeFileSync(path.join(assets, "index-ABCDEFGH.js"), "console.log('fixture')");
fs.writeFileSync(path.join(assets, "index-ABCDEFGH.css"), "body{}");

const app = express();
mountProductionFrontend(app, temp);
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const address = server.address() as AddressInfo;
const base = `http://127.0.0.1:${address.port}`;

try {
  const asset = await fetch(`${base}/assets/index-ABCDEFGH.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  for (const pathname of ["/assets/removed-old.js", "/removed-old.css", "/favicon-missing.ico"]) {
    const missing = await fetch(`${base}${pathname}`, { headers: { accept: "text/html" } });
    assert.equal(missing.status, 404, pathname);
    assert.doesNotMatch(await missing.text(), /<div id="root">/);
  }

  const navigation = await fetch(`${base}/projects/example`, { headers: { accept: "text/html" } });
  assert.equal(navigation.status, 200);
  assert.equal(navigation.headers.get("cache-control"), "no-store");
  assert.match(await navigation.text(), /fixture/);

  for (const accept of ["*/*", "application/json", "text/html;q=0, */*;q=1"]) {
    const probe = await fetch(`${base}/projects/example`, { headers: { accept } });
    assert.equal(probe.status, 404, accept);
    assert.doesNotMatch(await probe.text(), /fixture/);
  }

  const directIndex = await fetch(`${base}/index.html`);
  assert.equal(directIndex.status, 200);
  assert.equal(directIndex.headers.get("cache-control"), "no-store");

  const favicon = await fetch(`${base}/favicon.ico`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("cache-control"), "no-cache");
  assert.match(favicon.headers.get("content-type") ?? "", /^image\/(?:x-icon|vnd\.microsoft\.icon)/);
  assert.deepEqual([...new Uint8Array(await favicon.arrayBuffer()).slice(0, 4)], [0x00, 0x00, 0x01, 0x00]);

  const sourceIndex = fs.readFileSync(path.resolve("index.html"), "utf8");
  assert.match(sourceIndex, /garment-canvas-version-recovery/);
  assert.ok(
    sourceIndex.indexOf("garment-canvas-version-recovery") < sourceIndex.indexOf("/src/main.tsx"),
    "版本恢复脚本必须在前端入口前注册",
  );
  assert.ok(fs.statSync(path.resolve("public/favicon.ico")).size > 0);
  console.log("静态资源缓存、404 与版本恢复回归测试\n  ✓ 全部通过");
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(temp, { recursive: true, force: true });
}
