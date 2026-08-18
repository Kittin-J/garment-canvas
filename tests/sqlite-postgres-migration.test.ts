import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";
import { hashPassword } from "../server/lib/password";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-sqlite-import-"));
const sqlitePath = path.join(temp, "legacy.db");
const source = new Database(sqlitePath);
source.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    role TEXT NOT NULL, password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL,
    active INTEGER NOT NULL, deleted_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE projects (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, flow_json TEXT NOT NULL,
    updated_at TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT, purge_after TEXT
  );
  CREATE TABLE assets (
    id TEXT PRIMARY KEY, owner_id TEXT, scope TEXT NOT NULL, name TEXT NOT NULL,
    category TEXT NOT NULL, image TEXT NOT NULL, source_note TEXT, created_at TEXT NOT NULL,
    deleted_at TEXT, purge_after TEXT
  );
  CREATE TABLE project_asset_refs (
    project_id TEXT NOT NULL, asset_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (project_id, asset_id)
  );
`);
const now = new Date().toISOString();
source.prepare(`
  INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run("legacy-user", "legacy-admin", "旧管理员", "admin", hashPassword("Legacy1234"), 0, 1, null, now, now);
source.prepare(`
  INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run("legacy-project", "legacy-user", "旧项目", JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }), now, now, null, null);
source.prepare(`
  INSERT INTO assets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  "legacy-asset",
  "legacy-user",
  "private",
  "旧素材",
  "reference",
  "/api/files/legacy.png",
  null,
  now,
  null,
  null,
);
source.prepare("INSERT INTO project_asset_refs VALUES (?, ?, ?)")
  .run("legacy-project", "legacy-asset", now);
source.prepare("INSERT INTO project_asset_refs VALUES (?, ?, ?)")
  .run("missing-project", "legacy-asset", now);
source.prepare("INSERT INTO project_asset_refs VALUES (?, ?, ?)")
  .run("legacy-project", "missing-asset", now);
source.close();

process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "legacy.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "new-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, initializeDatabase, query, queryOne } = await import("../server/lib/database");
await initializeDatabase();

console.log("SQLite → PostgreSQL 升级迁移测试");
const legacyUser = await queryOne<Record<string, unknown>>("SELECT * FROM users WHERE id = $1", ["legacy-user"]);
assert.equal(legacyUser?.account_id, "legacy-admin");
console.log("  ✓ 保留旧用户账号与密码哈希");

const legacyProject = await queryOne<Record<string, unknown>>("SELECT * FROM projects WHERE id = $1", ["legacy-project"]);
assert.equal(legacyProject?.owner_id, "legacy-user");
assert.equal(legacyProject?.name, "旧项目");
console.log("  ✓ 保留旧项目及用户归属");

const importedRefs = await query<{ project_id: string; asset_id: string }>(`
  SELECT project_id, asset_id FROM project_asset_refs ORDER BY project_id, asset_id
`);
assert.deepEqual(importedRefs, [{ project_id: "legacy-project", asset_id: "legacy-asset" }]);
const projectForeignKey = await queryOne<{ delete_action: string }>(`
  SELECT confdeltype AS delete_action
  FROM pg_constraint
  WHERE conname = 'project_asset_refs_project_id_fkey'
    AND conrelid = 'project_asset_refs'::regclass
`);
assert.equal(projectForeignKey?.delete_action, "c");
console.log("  ✓ 导入后清理孤立素材引用并建立项目级联外键");

const users = await query<{ account_id: string }>("SELECT account_id FROM users ORDER BY account_id");
assert.deepEqual(users, [{ account_id: "legacy-admin" }]);
assert.equal(fs.existsSync(sqlitePath), true);
console.log("  ✓ 导入后不重复创建管理员且原 SQLite 文件保持不变");

await closeDatabaseForTests();

// 模拟 PostgreSQL 已空启动并完成全部编号迁移，随后才恢复旧 SQLite 数据包。
await resetPostgresTestDatabase();
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "";
process.env.INITIAL_ADMIN_PASSWORD = "";
await initializeDatabase();
const preAppliedVersions = await query<{ version: number }>(
  "SELECT version FROM schema_migrations ORDER BY version",
);
assert.deepEqual(preAppliedVersions.map((row) => row.version), [1, 2, 3, 4]);
assert.equal((await queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM users"))?.count, 0);
await closeDatabaseForTests();

process.env.SQLITE_IMPORT_FILE = "legacy.db";
await initializeDatabase();
assert.equal((await queryOne<{ account_id: string }>(
  "SELECT account_id FROM users WHERE id = 'legacy-user'",
))?.account_id, "legacy-admin");
assert.deepEqual(
  await query<{ project_id: string; asset_id: string }>(`
    SELECT project_id, asset_id FROM project_asset_refs ORDER BY project_id, asset_id
  `),
  [{ project_id: "legacy-project", asset_id: "legacy-asset" }],
);
console.log("  ✓ 编号迁移已存在时，后挂 SQLite 仍只导入父记录完整的素材引用");

await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
