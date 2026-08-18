import { Router } from "express";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne } from "../lib/database";
import { thumbnailUrlForImage } from "../lib/fileStore";

export const historyRouter = Router();

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

historyRouter.get("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const requestedUserId = typeof req.query.userId === "string" ? req.query.userId : undefined;
  if (requestedUserId && user.role !== "admin" && requestedUserId !== user.id) {
    res.status(403).json({ error: "无权查看其他用户记录" });
    return;
  }
  const ownerId = requestedUserId ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const requestedBefore = Number(req.query.before);
  const before = Number.isFinite(requestedBefore) && requestedBefore >= 0 ? requestedBefore : Date.now();
  const rows = await query<Record<string, unknown>>(`
    SELECT r.*, o.id AS output_id, o.image, o.prompt AS output_prompt,
      o.status AS output_status, o.error AS output_error, u.display_name AS owner_name
    FROM generation_runs r
    JOIN users u ON u.id = r.owner_id
    LEFT JOIN generation_outputs o ON o.run_id = r.id
    WHERE ($1::text IS NULL OR r.owner_id = $1)
      AND r.started_at <= $2
      AND (o.id IS NOT NULL OR r.status IN ('queued','running'))
    ORDER BY r.started_at DESC, o.created_at ASC
    LIMIT $3 OFFSET $4
  `, [ownerId, before, limit, offset]);
  res.json(rows.map((row) => ({
    id: (row.output_id as string | null) ?? (row.id as string),
    runId: row.id,
    image: (row.image as string | null) ?? "",
    thumbnail: row.image ? thumbnailUrlForImage(row.image as string) : "",
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
}));

historyRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne<{ owner_id: string; run_id: string }>(`
    SELECT r.owner_id, r.id AS run_id FROM generation_outputs o
    JOIN generation_runs r ON r.id = o.run_id WHERE o.id = $1 AND r.owner_id = $2
  `, [req.params.id, user.id]);
  if (!row) {
    res.status(404).json({ error: "记录不存在" });
    return;
  }
  await query("DELETE FROM generation_outputs WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));
