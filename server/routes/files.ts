/**
 * 文件上传/读取：
 *   POST /api/files      { dataUrl } → { id, url }（base64 JSON，body limit 50mb）
 *   GET  /api/files/:id  读取图片（id 含扩展名，如 abc12.png）
 */
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { isSupportedImageFile, mimeOfFile, saveDataUrl, uploadsDir } from "../lib/fileStore";
import { ProviderError } from "../providers/base";
import { ImageValidationError } from "../lib/imageValidation";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne } from "../lib/database";

export const filesRouter = Router();

filesRouter.post("/", asyncHandler(async (req, res) => {
  const { dataUrl } = req.body as { dataUrl?: string };
  if (!dataUrl) {
    res.status(400).json({ error: "dataUrl is required" });
    return;
  }
  try {
    const saved = saveDataUrl(dataUrl);
    await query(`
      INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, $2, 'upload', $3)
    `, [saved.id, requestUser(req).id, new Date().toISOString()]);
    res.json(saved);
  } catch (err) {
    if (err instanceof ProviderError || err instanceof ImageValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}));

filesRouter.get("/:id", asyncHandler(async (req, res) => {
  const id = path.basename(req.params.id); // 防路径穿越
  if (id !== req.params.id || !isSupportedImageFile(id)) {
    res.status(400).json({ error: "invalid file id" });
    return;
  }
  const filePath = path.join(uploadsDir(), id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  const user = requestUser(req);
  const access = await queryOne<{ owner_id: string | null; shared: boolean }>(`
    SELECT f.owner_id,
      EXISTS(SELECT 1 FROM assets a WHERE a.image = $1 AND a.deleted_at IS NULL AND a.scope IN ('global','shared')) AS shared
    FROM files f WHERE f.id = $2
  `, [`/api/files/${id}`, id]);
  if (access && access.owner_id !== null && access.owner_id !== user.id && user.role !== "admin" && !access.shared) {
    res.status(403).json({ error: "无权访问此文件" });
    return;
  }
  res.setHeader("Content-Type", mimeOfFile(id));
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs.createReadStream(filePath).pipe(res);
}));
