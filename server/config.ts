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

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

export interface ImageProviderCapabilities {
  supportsBatchN: boolean;
  maxBatchSize: number;
  supportsMultiReference: boolean;
  supportsImageArray: boolean;
  maxReferenceImages: number;
}

export const config = {
  /** change2pro 中转站 */
  change2proBaseUrl: () =>
    (process.env.CHANGE2PRO_BASE_URL ?? "https://your-change2pro-host/v1").replace(/\/+$/, ""),
  change2proApiKey: () => required("CHANGE2PRO_API_KEY"),

  /** nanobanana 可用独立 Key（如中转站按平台分组发 Key），缺省回退主 Key */
  nanobananaApiKey: () =>
    process.env.NANOBANANA_API_KEY || required("CHANGE2PRO_API_KEY"),

  // 不再假定任意 OpenAI 兼容网关都存在某个固定模型；部署必须明确声明模型 ID。
  nanobananaModel: () => required("NANOBANANA_MODEL"),
  image2Model: () => required("IMAGE2_MODEL"),
  nanobananaCapabilities: (): ImageProviderCapabilities => ({
    supportsBatchN: booleanEnv("NANOBANANA_SUPPORTS_N", false),
    maxBatchSize: boundedIntegerEnv("NANOBANANA_MAX_BATCH", 1, 1, 4),
    supportsMultiReference: booleanEnv("NANOBANANA_SUPPORTS_MULTI_REFERENCE", true),
    supportsImageArray: booleanEnv("NANOBANANA_SUPPORTS_IMAGE_ARRAY", true),
    maxReferenceImages: boundedIntegerEnv("NANOBANANA_MAX_REFERENCE_IMAGES", 8, 1, 8),
  }),
  image2Capabilities: (): ImageProviderCapabilities => ({
    supportsBatchN: booleanEnv("IMAGE2_SUPPORTS_N", false),
    maxBatchSize: boundedIntegerEnv("IMAGE2_MAX_BATCH", 1, 1, 4),
    supportsMultiReference: booleanEnv("IMAGE2_SUPPORTS_MULTI_REFERENCE", true),
    supportsImageArray: booleanEnv("IMAGE2_SUPPORTS_IMAGE_ARRAY", true),
    maxReferenceImages: boundedIntegerEnv("IMAGE2_MAX_REFERENCE_IMAGES", 8, 1, 8),
  }),

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
  aiTimeoutMs: () => Number(process.env.AI_TIMEOUT_MS ?? 300_000),
  /** 失败重试次数（不含首次） */
  aiMaxRetries: () => Number(process.env.AI_MAX_RETRIES ?? 2),

  /** 不发外部请求的 AI 配置就绪检查，供 readiness 使用。 */
  aiConfigReady: () => {
    const key = process.env.CHANGE2PRO_API_KEY || process.env.NANOBANANA_API_KEY;
    const baseUrl = process.env.CHANGE2PRO_BASE_URL ?? "";
    if (
      !key || !baseUrl || /your-change2pro-host/i.test(baseUrl) ||
      !process.env.IMAGE2_MODEL?.trim() || !process.env.NANOBANANA_MODEL?.trim()
    ) return false;
    try {
      const url = new URL(baseUrl);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  },
} as const;
