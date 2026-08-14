import { Router } from "express";
import { requestUser } from "../lib/auth";
import { db } from "../lib/database";

export const usageRouter = Router();

interface UsageRow {
  id: string; owner_id: string; account_id: string; display_name: string;
  run_id: string; project_id: string | null; node_id: string; model: string | null;
  successful_count: number; provider_requests: number; duration_ms: number; created_at: string;
}

function queryRows(ownerId: string | null, from: string | null, to: string | null): UsageRow[] {
  return db().prepare(`
    SELECT e.*, u.account_id, u.display_name
    FROM usage_events e JOIN users u ON u.id = e.owner_id
    WHERE (? IS NULL OR e.owner_id = ?)
      AND (? IS NULL OR e.created_at >= ?)
      AND (? IS NULL OR e.created_at <= ?)
    ORDER BY e.created_at DESC
  `).all(ownerId, ownerId, from, from, to, to) as UsageRow[];
}

function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

usageRouter.get("/", (req, res) => {
  const user = requestUser(req);
  const selected = typeof req.query.userId === "string" ? req.query.userId : undefined;
  if (selected && user.role !== "admin" && selected !== user.id) {
    res.status(403).json({ error: "无权查看其他用户消耗" });
    return;
  }
  const ownerId = selected ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const from = typeof req.query.from === "string" && Number.isFinite(Date.parse(req.query.from)) ? req.query.from : null;
  const to = typeof req.query.to === "string" && Number.isFinite(Date.parse(req.query.to)) ? req.query.to : null;
  const rows = queryRows(ownerId, from, to);
  if (req.query.format === "csv") {
    const header = ["记录ID", "账号", "用户", "生成任务", "项目", "节点", "模型", "成功图片数", "服务商请求数", "耗时毫秒", "时间"];
    const lines = [header, ...rows.map((row) => [
      row.id, row.account_id, row.display_name, row.run_id, row.project_id, row.node_id,
      row.model, row.successful_count, row.provider_requests, row.duration_ms, row.created_at,
    ])].map((line) => line.map(csvCell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="usage-${new Date().toISOString().slice(0, 10)}.csv"`);
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
});
