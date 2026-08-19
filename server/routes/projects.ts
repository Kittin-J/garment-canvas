import { Router } from "express";
import { nanoid } from "nanoid";
import type { PoolClient } from "pg";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne, transaction } from "../lib/database";
import { deleteStoredImage } from "../lib/fileStore";
import { validateAndMigrateFlow, WorkflowValidationError } from "../lib/workflowSchema";
import type { PersistedWorkflow } from "../../src/types/workflow";

export const projectsRouter = Router();

interface ProjectRow {
  id: string;
  owner_id: string;
  owner_name: string;
  name: string;
  flow_json: string;
  updated_at: string;
}

function imageRefs(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string" && value.startsWith("/api/files/")) output.add(value);
  else if (Array.isArray(value)) value.forEach((item) => imageRefs(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => imageRefs(item, output));
  return output;
}

async function syncAssetRefs(
  client: PoolClient,
  projectId: string,
  ownerId: string,
  flow: PersistedWorkflow,
): Promise<void> {
  const refs = [...imageRefs(flow)];
  const assets = await query<{ id: string; image: string }>(`
    SELECT id, image FROM assets
    WHERE deleted_at IS NULL AND (scope IN ('global','shared') OR owner_id = $1)
      AND image = ANY($2::text[])
    FOR KEY SHARE
  `, [ownerId, refs], client);
  const wanted = assets.map((asset) => asset.id);
  const now = new Date().toISOString();
  await client.query("DELETE FROM project_asset_refs WHERE project_id = $1", [projectId]);
  for (const assetId of wanted) {
    await client.query(
      "INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES ($1, $2, $3)",
      [projectId, assetId, now],
    );
  }
}

export async function purgeExpiredProjects(): Promise<void> {
  const now = new Date().toISOString();
  const expiredFileIds = await transaction(async (client) => {
    await client.query(`
      DELETE FROM project_asset_refs
      WHERE project_id IN (SELECT id FROM projects WHERE purge_after IS NOT NULL AND purge_after <= $1)
    `, [now]);
    await client.query("DELETE FROM usage_events WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    await client.query("DELETE FROM generation_runs WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    await client.query(`
      DELETE FROM assets
      WHERE purge_after IS NOT NULL AND purge_after <= $1
        AND NOT EXISTS (SELECT 1 FROM project_asset_refs r WHERE r.asset_id = assets.id)
    `, [now]);
    const files = await client.query<{ id: string }>(
      `DELETE FROM files
       WHERE purge_after IS NOT NULL AND purge_after <= $1
         AND NOT EXISTS (
           SELECT 1 FROM assets a
           WHERE a.image = '/api/files/' || files.id
         )
       RETURNING id`,
      [now],
    );
    await client.query("DELETE FROM projects WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    return files.rows.map((row) => row.id);
  });
  expiredFileIds.forEach(deleteStoredImage);
}

projectsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { id, name, flow } = req.body as { id?: string; name?: string; flow?: unknown };
  if (typeof name !== "string" || !name.trim() || name.length > 200 || flow === undefined) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    res.status(400).json({ error: "id must contain only letters, digits, underscore or hyphen" });
    return;
  }
  try {
    const normalized = validateAndMigrateFlow(flow);
    const projectId = id || nanoid(10);
    const now = new Date().toISOString();
    const saved = await transaction(async (client) => {
      const existing = await queryOne<{ owner_id: string }>(
        "SELECT owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [projectId],
        client,
      );
      if (existing && existing.owner_id !== user.id) return false;
      const result = await client.query(`
        INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT(id) DO UPDATE
          SET name = excluded.name, flow_json = excluded.flow_json, updated_at = excluded.updated_at
          WHERE projects.owner_id = excluded.owner_id
        RETURNING id
      `, [projectId, user.id, name.trim(), JSON.stringify(normalized), now]);
      if (result.rowCount !== 1) return false;
      await syncAssetRefs(client, projectId, user.id, normalized);
      return true;
    });
    if (!saved) {
      res.status(403).json({ error: "管理员只能查看其他用户项目，不能修改" });
      return;
    }
    res.json({ ok: true, id: projectId });
  } catch (error) {
    res.status(error instanceof WorkflowValidationError ? 400 : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
}));

projectsRouter.get("/", asyncHandler(async (req, res) => {
  await purgeExpiredProjects();
  const user = requestUser(req);
  const rows = await query<Omit<ProjectRow, "flow_json">>(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.deleted_at IS NULL AND ($1 = 'admin' OR p.owner_id = $2)
    ORDER BY p.updated_at DESC
  `, [user.role, user.id]);
  res.json(rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    readOnly: row.owner_id !== user.id,
    updatedAt: row.updated_at,
  })));
}));

projectsRouter.get("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne<ProjectRow>(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.flow_json, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.id = $1 AND p.deleted_at IS NULL
  `, [req.params.id]);
  if (!row) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (row.owner_id !== user.id && user.role !== "admin") {
    res.status(403).json({ error: "无权查看此项目" });
    return;
  }
  try {
    const flow = validateAndMigrateFlow(JSON.parse(row.flow_json));
    res.json({
      id: row.id, name: row.name, flow, updatedAt: row.updated_at,
      ownerId: row.owner_id, ownerName: row.owner_name, readOnly: row.owner_id !== user.id,
    });
  } catch (error) {
    res.status(422).json({
      error: error instanceof WorkflowValidationError ? `项目数据无法迁移：${error.message}` : "项目数据损坏",
    });
  }
}));
