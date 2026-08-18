import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import { queryOne, transaction } from "./database";
import { isLocalImageReference } from "./imageValidation";
import { validateAndMigrateFlow } from "./workflowSchema";

/** 将升级前匿名 JSON 数据一次性归档进 PostgreSQL；重复启动保持幂等。 */
export async function migrateLegacyData(): Promise<void> {
  const admin = await queryOne<{ id: string }>(`
    SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1
  `);
  if (!admin) return;
  const now = new Date().toISOString();

  const uploads = path.join(config.dataDir(), "uploads");
  if (fs.existsSync(uploads)) {
    await transaction(async (client) => {
      for (const file of fs.readdirSync(uploads)) {
        const id = path.basename(file);
        await client.query(`
          INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, NULL, 'legacy', $2)
          ON CONFLICT (id) DO NOTHING
        `, [id, now]);
        const image = `/api/files/${id}`;
        const existing = await queryOne<{ id: string }>("SELECT id FROM assets WHERE image = $1 LIMIT 1", [image], client);
        if (!existing) {
          await client.query(`
            INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
            VALUES ($1, NULL, 'global', $2, 'reference', $3, '从升级前服务器文件迁移', $4)
          `, [nanoid(10), `历史素材-${path.parse(id).name}`, image, now]);
        }
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
          const existing = await queryOne<{ id: string }>("SELECT id FROM assets WHERE image = $1 LIMIT 1", [raw.image], client);
          if (!existing) {
            await client.query(`
              INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
              VALUES ($1, NULL, 'global', $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
            `, [raw.id, raw.name, raw.category, raw.image, note, typeof raw.createdAt === "string" ? raw.createdAt : now]);
          }
        } catch {
          // 同上：只跳过，不覆盖或删除旧数据。
        }
      }
    });
  }
}
