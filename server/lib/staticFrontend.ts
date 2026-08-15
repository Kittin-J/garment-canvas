import express, { type Express } from "express";
import path from "node:path";

const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

function explicitlyAcceptsHtml(req: express.Request): boolean {
  const accept = req.get("Accept") ?? "";
  return /\btext\/html\b/i.test(accept) && req.accepts("html") === "html";
}

/** 生产前端托管：哈希资源长期缓存，HTML 永不缓存，资源请求不得落入 SPA。 */
export function mountProductionFrontend(app: Express, distDir: string): void {
  const distIndex = path.join(distDir, "index.html");
  const assetsDir = path.join(distDir, "assets") + path.sep;

  app.use(express.static(distDir, {
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (path.resolve(filePath) === path.resolve(distIndex)) {
        res.setHeader("Cache-Control", "no-store");
      } else if (filePath.startsWith(assetsDir) && HASHED_ASSET.test(path.basename(filePath))) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }));

  // 旧版本页面请求已被部署移除的 JS/CSS 时必须得到真实 404，不能收到 index.html。
  app.use("/assets", (_req, res) => {
    res.status(404).type("text/plain").send("Asset not found");
  });

  app.get("*", (req, res) => {
    const isResourcePath = path.extname(req.path) !== "";
    if (isResourcePath || !explicitlyAcceptsHtml(req)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(distIndex);
  });
}
