import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import { queryOne, transaction } from "./database";
import { isLocalImageReference } from "./imageValidation";
import { validateAndMigrateFlow } from "./workflowSchema";

const LEGACY_PLACEHOLDER_NOTE = "从升级前服务器文件迁移";

/** 将升级前匿名 JSON 数据一次性归档进 PostgreSQL；重复启动保持幂等。 */
export async function migrateLegacyData(): Promise<void> {
  const admin = await queryOne<{ id: string }>(`
    SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1
  `);
  if (!admin) return;
  const now = new Date().toISOString();

  const uploads = path.join(config.dataDir(), "uploads");
  const uploadFiles = fs.existsSync(uploads) ? fs.readdirSync(uploads) : [];
  if (uploadFiles.length > 0) {
    await transaction(async (client) => {
      for (const file of uploadFiles) {
        const id = path.basename(file);
        await client.query(`
          INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, NULL, 'legacy', $2)
          ON CONFLICT (id) DO NOTHING
        `, [id, now]);
      }
    });
  }

  const projects = path.join(config.dataDir(), "projects");
  if (fs.existsSync(projects)) {
    await transaction(async (client) => {
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
          await client.query(`
            INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING
          `, [raw.id, admin.id, raw.name, JSON.stringify(flow), updatedAt]);
        } catch {
          // 损坏旧文件继续留在磁盘，绝不在迁移时删除。
        }
      }
    });
  }

  const assets = path.join(config.dataDir(), "assets");
  if (fs.existsSync(assets)) {
    await transaction(async (client) => {
      for (const file of fs.readdirSync(assets)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(assets, file), "utf-8")) as Record<string, unknown>;
          if (typeof raw.id !== "string" || typeof raw.name !== "string" ||
              !["print", "fabric", "reference"].includes(String(raw.category)) ||
              typeof raw.image !== "string" || !isLocalImageReference(raw.image)) continue;
          const note = typeof raw.sourceNote === "string" ? raw.sourceNote : null;
          const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : now;
          const existing = await queryOne<{
            id: string; owner_id: string | null; scope: string; name: string; source_note: string | null;
          }>(
            "SELECT id, owner_id, scope, name, source_note FROM assets WHERE image = $1 LIMIT 1",
            [raw.image],
            client,
          );
          if (!existing) {
            await client.query(`
              INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
              VALUES ($1, NULL, 'global', $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
            `, [raw.id, raw.name, raw.category, raw.image, note, createdAt]);
          } else if (
            existing.owner_id === null &&
            existing.scope === "global" &&
            existing.name === `历史素材-${path.parse(path.basename(raw.image)).name}` &&
            existing.source_note === LEGACY_PLACEHOLDER_NOTE
          ) {
            // 兼容已经运行过旧迁移的实例：只修复自动生成的占位记录，不覆盖用户素材。
            await client.query(`
              UPDATE assets SET name = $1, category = $2, source_note = $3, created_at = $4
              WHERE id = $5
            `, [raw.name, raw.category, note, createdAt, existing.id]);
          }
        } catch {
          // 同上：只跳过，不覆盖或删除旧数据。
        }
      }
    });
  }

  // 权威素材 JSON 导入完成后，才为没有元数据的孤立上传补通用占位素材。
  if (uploadFiles.length > 0) {
    await transaction(async (client) => {
      for (const file of uploadFiles) {
        const id = path.basename(file);
        const image = `/api/files/${id}`;
        const existing = await queryOne<{ id: string }>(
          "SELECT id FROM assets WHERE image = $1 LIMIT 1",
          [image],
          client,
        );
        if (!existing) {
          await client.query(`
            INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
            VALUES ($1, NULL, 'global', $2, 'reference', $3, $4, $5)
          `, [nanoid(10), `历史素材-${path.parse(id).name}`, image, LEGACY_PLACEHOLDER_NOTE, now]);
        }
      }
    });
  }
}
