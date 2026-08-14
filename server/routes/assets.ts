import { Router } from "express";
import { nanoid } from "nanoid";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne } from "../lib/database";
import { saveDataUrl } from "../lib/fileStore";
import { ImageValidationError, isLocalImageReference } from "../lib/imageValidation";
import type { Asset } from "../../src/types/workflow";

export const assetsRouter = Router();
const CATEGORIES: Asset["category"][] = ["print", "fabric", "reference"];
const TRASH_DAYS = 15;

interface AssetRow {
  id: string; owner_id: string | null; owner_name: string | null;
  scope: "global" | "private" | "shared"; name: string; category: Asset["category"];
  image: string; source_note: string | null; created_at: string; deleted_at: string | null; purge_after: string | null;
}

function mapAsset(row: AssetRow, currentUserId: string) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    scope: row.scope,
    name: row.name,
    category: row.category,
    image: row.image,
    ...(row.source_note ? { sourceNote: row.source_note } : {}),
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    canManage: row.scope === "global" ? false : row.owner_id === currentUserId,
  };
}

async function purgeExpiredAssets(): Promise<void> {
  await query(`
    DELETE FROM assets WHERE purge_after IS NOT NULL AND purge_after <= $1
      AND NOT EXISTS (SELECT 1 FROM project_asset_refs r WHERE r.asset_id = assets.id)
  `, [new Date().toISOString()]);
}

assetsRouter.get("/", asyncHandler(async (req, res) => {
  await purgeExpiredAssets();
  const user = requestUser(req);
  const category = req.query.category as string | undefined;
  if (category && !CATEGORIES.includes(category as Asset["category"])) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
    return;
  }
  const includeDeleted = req.query.deleted === "true";
  const rows = await query<AssetRow>(`
    SELECT a.*, u.display_name AS owner_name
    FROM assets a LEFT JOIN users u ON u.id = a.owner_id
    WHERE ($1::text IS NULL OR a.category = $1)
      AND (${includeDeleted ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL"})
      AND ($2 = 'admin' OR a.scope IN ('global','shared') OR a.owner_id = $3)
    ORDER BY a.created_at DESC
  `, [category ?? null, user.role, user.id]);
  res.json(rows.map((row) => ({
    ...mapAsset(row, user.id),
    canManage: row.scope === "global" ? user.role === "admin" : row.owner_id === user.id,
  })));
}));

assetsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { name, category, image, sourceNote, scope } = req.body as {
    name?: string; category?: Asset["category"]; image?: string; sourceNote?: string;
    scope?: "global" | "private" | "shared";
  };
  if (typeof name !== "string" || !name.trim() || name.length > 200 || !category ||
      !CATEGORIES.includes(category) || typeof image !== "string" || !image) {
    res.status(400).json({ error: "name, category and image are required" });
    return;
  }
  if (scope === "global" && user.role !== "admin") {
    res.status(403).json({ error: "只有管理员可以创建通用素材" });
    return;
  }
  try {
    if (sourceNote !== undefined && (typeof sourceNote !== "string" || sourceNote.length > 2_000)) {
      throw new ImageValidationError("sourceNote must be a string of at most 2000 characters");
    }
    const saved = image.startsWith("data:") ? saveDataUrl(image) : undefined;
    const imageUrl = saved?.url ?? (isLocalImageReference(image) ? image : "");
    if (!imageUrl) throw new ImageValidationError("image must be a local image reference or valid image dataURL");
    if (saved) {
      await query(`
        INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, $2, 'asset', $3)
        ON CONFLICT (id) DO NOTHING
      `, [saved.id, user.id, new Date().toISOString()]);
    }
    const id = nanoid(10);
    const createdAt = new Date().toISOString();
    const finalScope = scope === "global" && user.role === "admin" ? "global" : scope === "shared" ? "shared" : "private";
    await query(`
      INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, finalScope === "global" ? null : user.id, finalScope, name.trim(), category, imageUrl, sourceNote ?? null, createdAt]);
    res.status(201).json({ ok: true, id });
  } catch (error) {
    res.status(error instanceof ImageValidationError ? 400 : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

assetsRouter.patch("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne<{ owner_id: string | null; scope: "global" | "private" | "shared" }>(
    "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NULL",
    [req.params.id],
  );
  if (!row) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
  if (!canManage) {
    res.status(403).json({ error: "无权修改此素材" });
    return;
  }
  const { name, scope } = req.body as { name?: string; scope?: "global" | "private" | "shared" };
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 200)) {
    res.status(400).json({ error: "素材名称无效" });
    return;
  }
  if (scope === "global" && user.role !== "admin") {
    res.status(403).json({ error: "只有管理员可以设置通用素材" });
    return;
  }
  const nextScope = scope ?? row.scope;
  await query("UPDATE assets SET name = COALESCE($1, name), scope = $2, owner_id = $3 WHERE id = $4", [
    name?.trim() ?? null, nextScope, nextScope === "global" ? null : (row.owner_id ?? user.id), req.params.id,
  ]);
  res.json({ ok: true });
}));

assetsRouter.post("/:id/references", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { projectId } = req.body as { projectId?: string };
  if (typeof projectId !== "string" || !projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  const asset = await queryOne<{ id: string }>(`
    SELECT id FROM assets WHERE id = $1 AND deleted_at IS NULL
      AND (scope IN ('global','shared') OR owner_id = $2 OR $3 = 'admin')
  `, [req.params.id, user.id, user.role]);
  if (!asset) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  await query(`
    INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES ($1, $2, $3)
    ON CONFLICT (project_id, asset_id) DO NOTHING
  `, [projectId, req.params.id, new Date().toISOString()]);
  res.json({ ok: true });
}));

assetsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne<{ owner_id: string | null; scope: "global" | "private" | "shared" }>(
    "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NULL",
    [req.params.id],
  );
  if (!row) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
  if (!canManage) {
    res.status(403).json({ error: "无权删除此素材" });
    return;
  }
  const ref = await queryOne<{ project_id: string }>(
    "SELECT project_id FROM project_asset_refs WHERE asset_id = $1 LIMIT 1",
    [req.params.id],
  );
  if (ref) {
    res.status(409).json({ error: "素材正在被项目使用，不能删除" });
    return;
  }
  const deletedAt = new Date();
  const purgeAfter = new Date(deletedAt.getTime() + TRASH_DAYS * 24 * 60 * 60 * 1000);
  await query("UPDATE assets SET deleted_at = $1, purge_after = $2 WHERE id = $3", [
    deletedAt.toISOString(), purgeAfter.toISOString(), req.params.id,
  ]);
  res.json({ ok: true, purgeAfter: purgeAfter.toISOString() });
}));

assetsRouter.post("/:id/restore", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne<{ owner_id: string | null; scope: "global" | "private" | "shared" }>(
    "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NOT NULL",
    [req.params.id],
  );
  if (!row) {
    res.status(404).json({ error: "回收站中没有此素材" });
    return;
  }
  const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
  if (!canManage) {
    res.status(403).json({ error: "无权恢复此素材" });
    return;
  }
  await query("UPDATE assets SET deleted_at = NULL, purge_after = NULL WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));
