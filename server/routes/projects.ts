import { Router } from "express";
import { nanoid } from "nanoid";
import { db } from "../lib/database";
import { requestUser } from "../lib/auth";
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

function syncAssetRefs(projectId: string, flow: PersistedWorkflow): void {
  const refs = imageRefs(flow);
  const database = db();
  const assets = database.prepare("SELECT id, image FROM assets WHERE deleted_at IS NULL").all() as Array<{ id: string; image: string }>;
  const wanted = assets.filter((asset) => refs.has(asset.image)).map((asset) => asset.id);
  const now = new Date().toISOString();
  database.transaction(() => {
    database.prepare("DELETE FROM project_asset_refs WHERE project_id = ?").run(projectId);
    const insert = database.prepare("INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES (?, ?, ?)");
    wanted.forEach((assetId) => insert.run(projectId, assetId, now));
  })();
}

function purgeExpiredProjects(): void {
  const database = db();
  const ids = database.prepare("SELECT id FROM projects WHERE purge_after IS NOT NULL AND purge_after <= ?")
    .all(new Date().toISOString()) as Array<{ id: string }>;
  database.transaction(() => {
    ids.forEach(({ id }) => {
      database.prepare("DELETE FROM project_asset_refs WHERE project_id = ?").run(id);
      database.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
  })();
}

projectsRouter.post("/", (req, res) => {
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
    const existing = db().prepare("SELECT owner_id FROM projects WHERE id = ? AND deleted_at IS NULL")
      .get(projectId) as { owner_id: string } | undefined;
    if (existing && existing.owner_id !== user.id) {
      res.status(403).json({ error: "管理员只能查看其他用户项目，不能修改" });
      return;
    }
    const now = new Date().toISOString();
    db().prepare(`
      INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, flow_json = excluded.flow_json, updated_at = excluded.updated_at
    `).run(projectId, user.id, name.trim(), JSON.stringify(normalized), now, now);
    syncAssetRefs(projectId, normalized);
    res.json({ ok: true, id: projectId });
  } catch (error) {
    res.status(error instanceof WorkflowValidationError ? 400 : 500)
      .json({ error: error instanceof Error ? error.message : String(error) });
  }
});

projectsRouter.get("/", (req, res) => {
  purgeExpiredProjects();
  const user = requestUser(req);
  const rows = db().prepare(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.deleted_at IS NULL AND (? = 'admin' OR p.owner_id = ?)
    ORDER BY p.updated_at DESC
  `).all(user.role, user.id) as Array<Omit<ProjectRow, "flow_json">>;
  res.json(rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    readOnly: row.owner_id !== user.id,
    updatedAt: row.updated_at,
  })));
});

projectsRouter.get("/:id", (req, res) => {
  const user = requestUser(req);
  const row = db().prepare(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.flow_json, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.id = ? AND p.deleted_at IS NULL
  `).get(req.params.id) as ProjectRow | undefined;
  if (!row) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (row.owner_id !== user.id && user.role !== "admin") {
    res.status(403).json({ error: "无权查看此项目" });
    return;
  }
  try {
    res.json({
      id: row.id, name: row.name, flow: JSON.parse(row.flow_json), updatedAt: row.updated_at,
      ownerId: row.owner_id, ownerName: row.owner_name, readOnly: row.owner_id !== user.id,
    });
  } catch {
    res.status(422).json({ error: "项目数据损坏" });
  }
});
