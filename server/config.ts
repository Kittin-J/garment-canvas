/**
 * 集中管理环境变量。未安装 dotenv，这里手动解析项目根目录 .env（key=value），
 * process.env 中已存在的值优先。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根目录（server/ 的上一级） */
export const ROOT_DIR = path.resolve(__dirname, "..");

function loadDotEnv(): void {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}

export const config = {
  /** API易图片接口；路径由本地模型知识库逐模型声明。 */
  apiyiBaseUrl: () => (process.env.APIYI_BASE_URL ?? "https://api.apiyi.com").replace(/\/+$/, ""),
  apiyiApiKey: () => required("APIYI_API_KEY"),

  port: () => Number(process.env.PORT ?? 3001),
  dataDir: () => path.resolve(ROOT_DIR, process.env.DATA_DIR ?? "./data"),
  databaseUrl: () => process.env.DATABASE_URL?.trim() || undefined,
  databaseHost: () => process.env.PGHOST?.trim() || "127.0.0.1",
  databasePort: () => Number(process.env.PGPORT ?? process.env.POSTGRES_HOST_PORT ?? 54329),
  databaseName: () => process.env.PGDATABASE?.trim() || process.env.POSTGRES_DB?.trim() || "garment_canvas",
  databaseUser: () => process.env.PGUSER?.trim() || process.env.POSTGRES_USER?.trim() || "garment_canvas",
  databasePassword: () => process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD ?? "",
  databasePoolSize: () => Math.max(1, Math.min(50, Number(process.env.DATABASE_POOL_SIZE) || 10)),
  sqliteImportPath: () => path.resolve(config.dataDir(), process.env.SQLITE_IMPORT_FILE ?? "garment-canvas.db"),
  initialAdminAccountId: () => process.env.INITIAL_ADMIN_ACCOUNT_ID?.trim() ?? "",
  initialAdminPassword: () => process.env.INITIAL_ADMIN_PASSWORD ?? "",
  /** 生产模式是否只提供 API；true 时不要求或托管前端 dist。 */
  apiOnly: () => process.env.API_ONLY === "true",

  /** AI 调用超时（中转站网关限制，可配） */
  aiTimeoutMs: (fallback = 300_000) => Number(process.env.AI_TIMEOUT_MS ?? fallback),

  /** 不发外部请求的 AI 配置就绪检查，供 readiness 使用。 */
  aiConfigReady: () => {
    const key = process.env.APIYI_API_KEY?.trim();
    const baseUrl = config.apiyiBaseUrl();
    if (!key) return false;
    try {
      const url = new URL(baseUrl);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  },
} as const;
