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
`);
const now = new Date().toISOString();
source.prepare(`
  INSERT INTO users VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run("legacy-user", "legacy-admin", "旧管理员", "admin", hashPassword("Legacy1234"), 0, 1, null, now, now);
source.prepare(`
  INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run("legacy-project", "legacy-user", "旧项目", JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }), now, now, null, null);
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

const users = await query<{ account_id: string }>("SELECT account_id FROM users ORDER BY account_id");
assert.deepEqual(users, [{ account_id: "legacy-admin" }]);
assert.equal(fs.existsSync(sqlitePath), true);
console.log("  ✓ 导入后不重复创建管理员且原 SQLite 文件保持不变");

await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
