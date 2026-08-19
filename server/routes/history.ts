import { Router } from "express";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query, queryOne } from "../lib/database";
import { thumbnailUrlForImage } from "../lib/fileStore";

export const historyRouter = Router();

interface HistoryCursor {
  before: number;
  startedAt: number;
  runId: string;
}

function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): HistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) {
    throw new Error("invalid history cursor");
  }
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<HistoryCursor>;
  if (!Number.isSafeInteger(decoded.before) || Number(decoded.before) < 0 ||
      !Number.isSafeInteger(decoded.startedAt) || Number(decoded.startedAt) < 0 ||
      typeof decoded.runId !== "string" || !decoded.runId) {
    throw new Error("invalid history cursor");
  }
  return { before: Number(decoded.before), startedAt: Number(decoded.startedAt), runId: decoded.runId };
}

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
  let cursor: HistoryCursor | undefined;
  try {
    cursor = decodeCursor(req.query.cursor);
  } catch {
    res.status(400).json({ error: "历史分页游标无效" });
    return;
  }
  const requestedBefore = Number(req.query.before);
  const before = cursor?.before ?? (Number.isFinite(requestedBefore) && requestedBefore >= 0 ? requestedBefore : Date.now());
  const runCandidates = await query<{ id: string; started_at: number }>(`
    SELECT r.id, r.started_at
    FROM generation_runs r
    WHERE ($1::text IS NULL OR r.owner_id = $1)
      AND r.deleted_at IS NULL
      AND r.started_at <= $2
      AND (
        $3::bigint IS NULL OR r.started_at < $3
        OR (r.started_at = $3 AND r.id < $4)
      )
      AND (
        r.status IN ('queued','running')
        OR EXISTS (SELECT 1 FROM generation_outputs output WHERE output.run_id = r.id)
      )
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT $5
  `, [ownerId, before, cursor?.startedAt ?? null, cursor?.runId ?? null, limit + 1]);
  const hasMore = runCandidates.length > limit;
  const pageRuns = runCandidates.slice(0, limit);
  if (pageRuns.length === 0) {
    res.json({ records: [], nextCursor: null, hasMore: false });
    return;
  }
  const rows = await query<Record<string, unknown>>(`
    SELECT r.*, o.id AS output_id, o.image, o.prompt AS output_prompt,
      o.status AS output_status, o.error AS output_error, u.display_name AS owner_name
    FROM generation_runs r
    JOIN users u ON u.id = r.owner_id
    LEFT JOIN generation_outputs o ON o.run_id = r.id
    WHERE r.id = ANY($1::text[])
    ORDER BY r.started_at DESC, r.id DESC, o.created_at ASC, o.id ASC
  `, [pageRuns.map((run) => run.id)]);
  const records = rows.map((row) => ({
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
  }));
  const lastRun = pageRuns.at(-1);
  res.json({
    records,
    nextCursor: hasMore && lastRun
      ? encodeCursor({ before, startedAt: lastRun.started_at, runId: lastRun.id })
      : null,
    hasMore,
  });
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
