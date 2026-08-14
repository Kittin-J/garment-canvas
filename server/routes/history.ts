import { Router } from "express";
import { requestUser } from "../lib/auth";
import { db } from "../lib/database";

export const historyRouter = Router();

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

historyRouter.get("/", (req, res) => {
  const user = requestUser(req);
  const requestedUserId = typeof req.query.userId === "string" ? req.query.userId : undefined;
  if (requestedUserId && user.role !== "admin" && requestedUserId !== user.id) {
    res.status(403).json({ error: "无权查看其他用户记录" });
    return;
  }
  const ownerId = requestedUserId ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = db().prepare(`
    SELECT r.*, o.id AS output_id, o.image, o.prompt AS output_prompt,
      o.status AS output_status, o.error AS output_error, u.display_name AS owner_name
    FROM generation_runs r
    JOIN users u ON u.id = r.owner_id
    LEFT JOIN generation_outputs o ON o.run_id = r.id
    WHERE (? IS NULL OR r.owner_id = ?)
      AND (o.id IS NOT NULL OR r.status IN ('queued','running'))
    ORDER BY r.started_at DESC, o.created_at ASC
    LIMIT ? OFFSET ?
  `).all(ownerId, ownerId, limit, offset) as Array<Record<string, unknown>>;
  res.json(rows.map((row) => ({
    id: (row.output_id as string | null) ?? (row.id as string),
    runId: row.id,
    image: (row.image as string | null) ?? "",
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    kind: row.kind,
    projectId: row.project_id,
    projectName: row.project_name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    prompt: (row.output_prompt as string | null) ?? row.prompt,
    parameters: parseJson<Record<string, unknown>>(row.parameters_json, {}),
    referenceImages: parseJson<string[]>(row.reference_images_json, []),
    model: row.model,
    requestedCount: row.requested_count,
    successfulCount: row.successful_count,
    providerRequests: row.provider_requests,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: (row.output_status as string | null) ?? row.status,
    error: (row.output_error as string | null) ?? row.error,
  })));
});

historyRouter.delete("/:id", (req, res) => {
  const user = requestUser(req);
  const row = db().prepare(`
    SELECT r.owner_id, r.id AS run_id FROM generation_outputs o
    JOIN generation_runs r ON r.id = o.run_id WHERE o.id = ?
  `).get(req.params.id) as { owner_id: string; run_id: string } | undefined;
  if (!row || row.owner_id !== user.id) {
    res.status(row ? 403 : 404).json({ error: row ? "只能删除自己的生成历史" : "记录不存在" });
    return;
  }
  // 消耗流水通过 run_id 独立保留；只删除这张历史卡片。
  db().prepare("DELETE FROM generation_outputs WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});
