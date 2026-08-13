/**
 * 素材库（JSON 文件存储，印花提取等产出的可复用素材）：
 *   GET    /api/assets?category=print|fabric|reference → Asset[]（按 createdAt 倒序）
 *   POST   /api/assets  { name, category, image, sourceNote? } → { ok, id }
 *           image 支持 /api/files/xxx URL 或 dataURL（dataURL 先落盘为 uploads 文件）
 *   PATCH  /api/assets/:id  { name } 重命名 → { ok:true }
 *   DELETE /api/assets/:id  → { ok:true }（只删素材 JSON，不删 uploads 图片，允许多素材共图）
 */
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import { saveDataUrl } from "../lib/fileStore";
import { writeJsonAtomicSync } from "../lib/atomicJson";
import { ImageValidationError, isLocalImageReference } from "../lib/imageValidation";
import type { Asset } from "../../src/types/workflow";

export const assetsRouter = Router();

const CATEGORIES: Asset["category"][] = ["print", "fabric", "reference"];

function assetsDir(): string {
  const dir = path.join(config.dataDir(), "assets");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assetPath(id: string): string {
  return path.join(assetsDir(), `${path.basename(id)}.json`);
}

function readAssets(): Asset[] {
  const dir = assetsDir();
  const list: Asset[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8")) as Record<string, unknown>;
      if (
        typeof raw.id !== "string" || !raw.id ||
        typeof raw.name !== "string" || !raw.name ||
        !CATEGORIES.includes(raw.category as Asset["category"]) ||
        !isLocalImageReference(raw.image) ||
        typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt)) ||
        (raw.sourceNote !== undefined && typeof raw.sourceNote !== "string")
      ) {
        throw new ImageValidationError("invalid asset record");
      }
      list.push(raw as unknown as Asset);
    } catch {
      // 跳过损坏文件
    }
  }
  return list;
}

assetsRouter.get("/", (req, res) => {
  try {
    const category = req.query.category as string | undefined;
    if (category !== undefined && !CATEGORIES.includes(category as Asset["category"])) {
      res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
      return;
    }
    let list = readAssets();
    if (category) {
      list = list.filter((a) => a.category === category);
    }
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

assetsRouter.post("/", (req, res) => {
  const { name, category, image, sourceNote } = req.body as {
    name?: string;
    category?: Asset["category"];
    image?: string;
    sourceNote?: string;
  };
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200 || !category || typeof image !== "string" || !image) {
    res.status(400).json({ error: "name, category and image are required" });
    return;
  }
  if (!CATEGORIES.includes(category)) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
    return;
  }
  try {
    if (sourceNote !== undefined && (typeof sourceNote !== "string" || sourceNote.length > 2_000)) {
      throw new ImageValidationError("sourceNote must be a string of at most 2000 characters");
    }
    // dataURL 先经 MIME/魔数/体积校验并落盘；已有引用只允许本地 uploads。
    const imageUrl = image.startsWith("data:")
      ? saveDataUrl(image).url
      : isLocalImageReference(image)
        ? image
        : (() => { throw new ImageValidationError("image must be a local /api/files reference or valid image dataURL"); })();
    const id = nanoid(10);
    const asset: Asset = {
      id,
      name: name.trim(),
      category,
      image: imageUrl,
      ...(sourceNote ? { sourceNote } : {}),
      createdAt: new Date().toISOString(),
    };
    writeJsonAtomicSync(assetPath(id), asset);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(err instanceof ImageValidationError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

assetsRouter.patch("/:id", (req, res) => {
  const id = req.params.id;
  const filePath = assetPath(id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  const { name } = req.body as { name?: string };
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const asset = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Asset;
    asset.name = name.trim();
    writeJsonAtomicSync(filePath, asset);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

assetsRouter.delete("/:id", (req, res) => {
  const id = req.params.id;
  const filePath = assetPath(id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  try {
    // 只删素材 JSON，不删 uploads 里的图片文件（多素材可能共图）
    fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
