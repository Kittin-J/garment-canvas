import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-schema-migrations-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "migration-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, initializeDatabase, query, queryOne } = await import("../server/lib/database");

console.log("PostgreSQL 18 编号迁移回归测试");
await initializeDatabase();

const versions = await query<{ version: number; name: string }>(
  "SELECT version, name FROM schema_migrations ORDER BY version",
);
assert.deepEqual(versions, [
  { version: 1, name: "initial_schema" },
  { version: 2, name: "project_asset_refs_project_foreign_key" },
  { version: 3, name: "revoked_session_reasons" },
]);
console.log("  ✓ 新数据库记录全部编号迁移");

const admin = await queryOne<{ id: string }>("SELECT id FROM users WHERE account_id = 'migration-admin'");
assert.ok(admin);
const now = new Date().toISOString();
await query(`
  INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
  VALUES ('migration-asset', $1, 'private', '迁移素材', 'reference', '/api/files/migration.png', $2)
`, [admin.id, now]);

await query("ALTER TABLE project_asset_refs DROP CONSTRAINT project_asset_refs_project_id_fkey");
await query("DELETE FROM schema_migrations WHERE version = 2");
await query(`
  INSERT INTO project_asset_refs (project_id, asset_id, created_at)
  VALUES ('orphan-project', 'migration-asset', $1)
`, [now]);
await closeDatabaseForTests();
await initializeDatabase();

const orphan = await queryOne<{ count: number }>(
  "SELECT COUNT(*)::int AS count FROM project_asset_refs WHERE project_id = 'orphan-project'",
);
assert.equal(orphan?.count, 0);
const foreignKey = await queryOne<{ delete_action: string }>(`
  SELECT confdeltype AS delete_action
  FROM pg_constraint
  WHERE conname = 'project_asset_refs_project_id_fkey'
    AND conrelid = 'project_asset_refs'::regclass
`);
assert.equal(foreignKey?.delete_action, "c");
console.log("  ✓ 升级会清理孤立引用并恢复 ON DELETE CASCADE 外键");

await query(`
  INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
  VALUES ('cascade-project', $1, 'Cascade', '{"schemaVersion":1,"nodes":[],"edges":[]}', $2, $2)
`, [admin.id, now]);
await query(`
  INSERT INTO project_asset_refs (project_id, asset_id, created_at)
  VALUES ('cascade-project', 'migration-asset', $1)
`, [now]);
await query("DELETE FROM projects WHERE id = 'cascade-project'");
const cascaded = await queryOne<{ count: number }>(
  "SELECT COUNT(*)::int AS count FROM project_asset_refs WHERE project_id = 'cascade-project'",
);
assert.equal(cascaded?.count, 0);
console.log("  ✓ 删除项目会级联移除素材引用");

await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
