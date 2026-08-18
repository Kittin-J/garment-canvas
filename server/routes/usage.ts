import { Router } from "express";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { query } from "../lib/database";

export const usageRouter = Router();

interface UsageRow {
  id: string; owner_id: string; account_id: string; display_name: string;
  run_id: string; project_id: string | null; node_id: string; model: string | null;
  successful_count: number; provider_requests: number; duration_ms: number; created_at: string;
}

async function queryRows(ownerId: string | null, from: string | null, to: string | null): Promise<UsageRow[]> {
  return query<UsageRow>(`
    SELECT e.*, u.account_id, u.display_name
    FROM usage_events e JOIN users u ON u.id = e.owner_id
    WHERE ($1::text IS NULL OR e.owner_id = $1)
      AND e.deleted_at IS NULL
      AND ($2::text IS NULL OR e.created_at >= $2)
      AND ($3::text IS NULL OR e.created_at <= $3)
    ORDER BY e.created_at DESC
  `, [ownerId, from, to]);
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  // Excel/LibreOffice 即使看到带双引号的 CSV 字段，仍可能执行公式。
  // 只对字符串做文本化，避免把合法的负数数值改变成字符串。
  const safeText = typeof value === "string" && /^\s*[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}

usageRouter.get("/", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = requestUser(req);
  const selected = typeof req.query.userId === "string" ? req.query.userId : undefined;
  if (selected && user.role !== "admin" && selected !== user.id) {
    res.status(403).json({ error: "无权查看其他用户消耗" });
    return;
  }
  const ownerId = selected ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const from = typeof req.query.from === "string" && Number.isFinite(Date.parse(req.query.from)) ? req.query.from : null;
  const to = typeof req.query.to === "string" && Number.isFinite(Date.parse(req.query.to)) ? req.query.to : null;
  const rows = await queryRows(ownerId, from, to);
  if (req.query.format === "csv") {
    const header = ["记录ID", "账号", "用户", "生成任务", "项目", "节点", "模型", "成功图片数", "服务商请求数", "耗时毫秒", "时间"];
    const lines = [header, ...rows.map((row) => [
      row.id, row.account_id, row.display_name, row.run_id, row.project_id, row.node_id,
      row.model, row.successful_count, row.provider_requests, row.duration_ms, row.created_at,
    ])].map((line) => line.map(csvCell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="usage-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(`\uFEFF${lines.join("\r\n")}`);
    return;
  }
  res.json(rows.map((row) => ({
    id: row.id,
    userId: row.owner_id,
    accountId: row.account_id,
    displayName: row.display_name,
    runId: row.run_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    model: row.model,
    successfulCount: row.successful_count,
    providerRequests: row.provider_requests,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  })));
}));
