import fs from "node:fs";
import Database from "better-sqlite3";
import type { PoolClient } from "pg";
import { config } from "../config";

const TABLES: Array<{ name: string; columns: string[] }> = [
  { name: "users", columns: ["id", "account_id", "display_name", "role", "password_hash", "must_change_password", "active", "deleted_at", "created_at", "updated_at"] },
  { name: "sessions", columns: ["token_hash", "user_id", "created_at", "expires_at"] },
  { name: "projects", columns: ["id", "owner_id", "name", "flow_json", "updated_at", "created_at", "deleted_at", "purge_after"] },
  { name: "files", columns: ["id", "owner_id", "source_type", "project_id", "node_id", "run_id", "created_at"] },
  { name: "assets", columns: ["id", "owner_id", "scope", "name", "category", "image", "source_note", "created_at", "deleted_at", "purge_after"] },
  { name: "project_asset_refs", columns: ["project_id", "asset_id", "created_at"] },
  { name: "generation_runs", columns: ["id", "owner_id", "project_id", "project_name", "node_id", "node_label", "kind", "prompt", "parameters_json", "reference_images_json", "model", "requested_count", "successful_count", "provider_requests", "status", "error", "started_at", "finished_at"] },
  { name: "generation_outputs", columns: ["id", "run_id", "image", "prompt", "status", "error", "created_at"] },
  { name: "usage_events", columns: ["id", "owner_id", "run_id", "project_id", "node_id", "model", "successful_count", "provider_requests", "duration_ms", "created_at"] },
];

function sqliteTableExists(source: Database.Database, table: string): boolean {
  return Boolean(source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

async function importTable(source: Database.Database, client: PoolClient, name: string, columns: string[]): Promise<number> {
  if (!sqliteTableExists(source, name)) return 0;
  const rows = source.prepare(`SELECT ${columns.join(", ")} FROM ${name}`).all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return 0;
  const columnSql = columns.map((column) => `"${column}"`).join(", ");
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  for (const row of rows) {
    const valuesSql = name === "project_asset_refs"
      ? `SELECT ${placeholders}
         WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1)
           AND EXISTS (SELECT 1 FROM assets WHERE id = $2)`
      : `VALUES (${placeholders})`;
    await client.query(
      `INSERT INTO "${name}" (${columnSql}) ${valuesSql} ON CONFLICT DO NOTHING`,
      columns.map((column) => row[column] ?? null),
    );
  }
  return rows.length;
}

/** PostgreSQL 首次初始化事务内导入升级前的 SQLite 数据库；原文件只读保留。 */
export async function importSqliteIfNeeded(client: PoolClient): Promise<number | undefined> {
  const target = (await client.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM users")).rows[0];
  if ((target?.count ?? 0) > 0) return undefined;
  const sourcePath = config.sqliteImportPath();
  if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size === 0) return undefined;

  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    if (!sqliteTableExists(source, "users")) return undefined;
    let imported = 0;
    for (const table of TABLES) imported += await importTable(source, client, table.name, table.columns);
    return imported;
  } catch (error) {
    throw new Error(`SQLite 数据迁移到 PostgreSQL 失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    source.close();
  }
}
