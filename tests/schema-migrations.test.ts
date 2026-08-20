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
const { migrateLegacyData } = await import("../server/lib/legacyMigration");

console.log("PostgreSQL 18 编号迁移回归测试");
await initializeDatabase();

const versions = await query<{ version: number; name: string }>(
  "SELECT version, name FROM schema_migrations ORDER BY version",
);
assert.deepEqual(versions, [
  { version: 1, name: "initial_schema" },
  { version: 2, name: "project_asset_refs_project_foreign_key" },
  { version: 3, name: "revoked_session_reasons" },
  { version: 4, name: "active_account_id_unique" },
  { version: 5, name: "account_data_retention_tombstones" },
  { version: 6, name: "durable_generation_queue" },
  { version: 7, name: "provider_output_size_metadata" },
  { version: 8, name: "normalized_upload_metadata" },
]);
console.log("  ✓ 新数据库记录全部编号迁移");

const queueTables = await query<{ table_name: string }>(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('generation_run_steps','generation_jobs','generation_run_events')
  ORDER BY table_name
`);
assert.deepEqual(queueTables, [
  { table_name: "generation_jobs" },
  { table_name: "generation_run_events" },
  { table_name: "generation_run_steps" },
]);
const runStatusConstraint = await queryOne<{ definition: string }>(`
  SELECT pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE conname = 'generation_runs_status_check'
`);
assert.match(runStatusConstraint?.definition ?? "", /retry_wait/);
assert.match(runStatusConstraint?.definition ?? "", /outcome_unknown/);
const retryConstraint = await queryOne<{ definition: string }>(`
  SELECT pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE conrelid = 'generation_jobs'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%retry_count%'
`);
assert.match(retryConstraint?.definition ?? "", /retry_count.*(?:0|2)/);
assert.match(retryConstraint?.definition ?? "", />= 0/);
assert.match(retryConstraint?.definition ?? "", /<= 2/);
console.log("  ✓ 持久队列表、状态约束与最多两次重试约束已建立");
const sizeColumns = await query<{ table_name: string; column_name: string }>(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND (
    (table_name = 'generation_run_steps' AND column_name = 'provider_output_sizes_json') OR
    (table_name = 'generation_outputs' AND column_name = 'provider_output_size')
  )
  ORDER BY table_name, column_name
`);
assert.deepEqual(sizeColumns, [
  { table_name: "generation_outputs", column_name: "provider_output_size" },
  { table_name: "generation_run_steps", column_name: "provider_output_sizes_json" },
]);
console.log("  ✓ 上游实际输出尺寸元数据列已建立");
const uploadColumns = await query<{ column_name: string }>(`
  SELECT column_name FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'files'
    AND column_name IN ('mime_type','width','height','byte_length','normalized')
  ORDER BY column_name
`);
assert.deepEqual(uploadColumns, [
  { column_name: "byte_length" },
  { column_name: "height" },
  { column_name: "mime_type" },
  { column_name: "normalized" },
  { column_name: "width" },
]);
console.log("  ✓ 用户上传标准化元数据列已建立");

const admin = await queryOne<{ id: string }>("SELECT id FROM users WHERE account_id = 'migration-admin'");
assert.ok(admin);
const now = new Date().toISOString();
fs.mkdirSync(path.join(temp, "uploads"), { recursive: true });
fs.writeFileSync(path.join(temp, "uploads", "legacy-rich.png"), "legacy-image");
await query(`
  INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
  VALUES ('migration-asset', $1, 'private', '迁移素材', 'reference', '/api/files/migration.png', $2)
`, [admin.id, now]);

fs.mkdirSync(path.join(temp, "assets"), { recursive: true });
fs.writeFileSync(path.join(temp, "assets", "legacy-rich.json"), JSON.stringify({
  id: "legacy-rich", name: "原始面料素材", category: "fabric",
  image: "/api/files/legacy-rich.png", sourceNote: "原始分类与备注必须保留", createdAt: now,
}));
fs.writeFileSync(path.join(temp, "assets", "private.json"), JSON.stringify({
  id: "legacy-private", name: "旧文件名", category: "reference",
  image: "/api/files/migration.png", sourceNote: "旧备注",
}));
await migrateLegacyData();
const migratedAsset = await queryOne<Record<string, unknown>>(`
  SELECT id, owner_id, scope, name, category, source_note
  FROM assets WHERE image = '/api/files/legacy-rich.png'
`);
assert.deepEqual(migratedAsset, {
  id: "legacy-rich",
  owner_id: null,
  scope: "global",
  name: "原始面料素材",
  category: "fabric",
  source_note: "原始分类与备注必须保留",
});
assert.ok(await queryOne("SELECT id FROM files WHERE id = 'legacy-rich.png'"));
fs.writeFileSync(path.join(temp, "uploads", "legacy-placeholder.png"), "legacy-placeholder");
fs.writeFileSync(path.join(temp, "assets", "legacy-placeholder.json"), JSON.stringify({
  id: "legacy-placeholder-original", name: "旧版原始印花", category: "print",
  image: "/api/files/legacy-placeholder.png", sourceNote: "旧版原始备注", createdAt: now,
}));
await query(`
  INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
  VALUES ('legacy-placeholder-row', NULL, 'global', '历史素材-legacy-placeholder', 'reference',
    '/api/files/legacy-placeholder.png', '从升级前服务器文件迁移', $1)
`, [now]);
await migrateLegacyData();
assert.equal((await queryOne<{ count: number }>(
  "SELECT COUNT(*)::int AS count FROM assets WHERE image = '/api/files/legacy-rich.png'",
))?.count, 1);
assert.deepEqual(await queryOne<Record<string, unknown>>(`
  SELECT id, name, category, source_note FROM assets
  WHERE image = '/api/files/legacy-placeholder.png'
`), {
  id: "legacy-placeholder-row",
  name: "旧版原始印花",
  category: "print",
  source_note: "旧版原始备注",
});
console.log("  ✓ legacy 素材 JSON 优先于上传目录占位记录且重复启动保持幂等");

const preserved = await queryOne<Record<string, unknown>>(
  "SELECT owner_id, scope, name, category, source_note FROM assets WHERE image = '/api/files/migration.png'",
);
assert.deepEqual(preserved, {
  owner_id: admin.id,
  scope: "private",
  name: "迁移素材",
  category: "reference",
  source_note: null,
});
console.log("  ✓ legacy 迁移不会在重复启动时夺取现有素材归属");

await query(`
  INSERT INTO users (
    id, account_id, display_name, role, password_hash, must_change_password,
    active, deleted_at, created_at, updated_at
  ) VALUES ('deleted-reusable', 'reusable-account', '旧账号', 'user', 'test', 0, 0, $1, $1, $1)
`, [now]);
await query(`
  INSERT INTO users (
    id, account_id, display_name, role, password_hash, must_change_password,
    active, created_at, updated_at
  ) VALUES ('active-reusable', 'reusable-account', '新账号', 'user', 'test', 1, 1, $1, $1)
`, [now]);
const reusable = await query<{ id: string }>(
  "SELECT id FROM users WHERE account_id = 'reusable-account' ORDER BY id",
);
assert.deepEqual(reusable, [{ id: "active-reusable" }, { id: "deleted-reusable" }]);
console.log("  ✓ 软删除账号不会永久占用登录名");

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
