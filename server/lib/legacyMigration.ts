import fs from "node:fs";
import path from "node:path";
import { config } from "../config";
import { db } from "./database";
import { validateAndMigrateFlow } from "./workflowSchema";
import { isLocalImageReference } from "./imageValidation";
import { nanoid } from "nanoid";

/** 将现有匿名 JSON 数据一次性归档进新数据模型；重复启动保持幂等。 */
export function migrateLegacyData(): void {
  const database = db();
  const admin = database.prepare(`
    SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1
  `).get() as { id: string } | undefined;
  if (!admin) return;
  const now = new Date().toISOString();

  const uploads = path.join(config.dataDir(), "uploads");
  if (fs.existsSync(uploads)) {
    const insertFile = database.prepare(`
      INSERT OR IGNORE INTO files (id, owner_id, source_type, created_at) VALUES (?, NULL, 'legacy', ?)
    `);
    const findAsset = database.prepare("SELECT id FROM assets WHERE image = ? LIMIT 1");
    const insertLegacyAsset = database.prepare(`
      INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
      VALUES (?, NULL, 'global', ?, 'reference', ?, '从升级前服务器文件迁移', ?)
    `);
    database.transaction(() => {
      for (const file of fs.readdirSync(uploads)) {
        const id = path.basename(file);
        insertFile.run(id, now);
        const image = `/api/files/${id}`;
        if (!findAsset.get(image)) insertLegacyAsset.run(nanoid(10), `历史素材-${path.parse(id).name}`, image, now);
      }
    })();
  }

  const projects = path.join(config.dataDir(), "projects");
  if (fs.existsSync(projects)) {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    database.transaction(() => {
      for (const file of fs.readdirSync(projects)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(projects, file), "utf-8")) as {
            id?: unknown; name?: unknown; flow?: unknown; updatedAt?: unknown;
          };
          if (typeof raw.id !== "string" || typeof raw.name !== "string") continue;
          const flow = validateAndMigrateFlow(raw.flow);
          const updatedAt = typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
            ? raw.updatedAt : now;
          insert.run(raw.id, admin.id, raw.name, JSON.stringify(flow), updatedAt, updatedAt);
        } catch {
          // 损坏的旧文件继续留在磁盘，绝不在迁移时删除。
        }
      }
    })();
  }

  const assets = path.join(config.dataDir(), "assets");
  if (fs.existsSync(assets)) {
    const insert = database.prepare(`
      INSERT OR IGNORE INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
      VALUES (?, NULL, 'global', ?, ?, ?, ?, ?)
    `);
    const findByImage = database.prepare("SELECT id FROM assets WHERE image = ? LIMIT 1");
    const updateByImage = database.prepare(`
      UPDATE assets SET name = ?, category = ?, source_note = ?, scope = 'global', owner_id = NULL WHERE image = ?
    `);
    database.transaction(() => {
      for (const file of fs.readdirSync(assets)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(assets, file), "utf-8")) as Record<string, unknown>;
          if (typeof raw.id !== "string" || typeof raw.name !== "string" ||
              !["print", "fabric", "reference"].includes(String(raw.category)) ||
              typeof raw.image !== "string" || !isLocalImageReference(raw.image)) continue;
          const note = typeof raw.sourceNote === "string" ? raw.sourceNote : null;
          if (findByImage.get(raw.image)) updateByImage.run(raw.name, raw.category, note, raw.image);
          else insert.run(raw.id, raw.name, raw.category, raw.image, note, typeof raw.createdAt === "string" ? raw.createdAt : now);
        } catch {
          // 同上：只跳过，不覆盖或删除旧数据。
        }
      }
    })();
  }
}
