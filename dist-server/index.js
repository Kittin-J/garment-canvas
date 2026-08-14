// server/index.ts
import express from "express";
import fs8 from "node:fs";
import path8 from "node:path";

// server/config.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var ROOT_DIR = path.resolve(__dirname, "..");
function loadDotEnv() {
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
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}
var config = {
  /** change2pro 中转站 */
  change2proBaseUrl: () => (process.env.CHANGE2PRO_BASE_URL ?? "https://your-change2pro-host/v1").replace(/\/+$/, ""),
  change2proApiKey: () => required("CHANGE2PRO_API_KEY"),
  /** nanobanana 可用独立 Key（如中转站按平台分组发 Key），缺省回退主 Key */
  nanobananaApiKey: () => process.env.NANOBANANA_API_KEY || required("CHANGE2PRO_API_KEY"),
  nanobananaModel: () => process.env.NANOBANANA_MODEL ?? "gpt-image-2",
  image2Model: () => process.env.IMAGE2_MODEL ?? "gpt-image-2",
  port: () => Number(process.env.PORT ?? 3001),
  dataDir: () => path.resolve(ROOT_DIR, process.env.DATA_DIR ?? "./data"),
  databaseUrl: () => process.env.DATABASE_URL?.trim() || void 0,
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
  aiTimeoutMs: () => Number(process.env.AI_TIMEOUT_MS ?? 3e5),
  /** 失败重试次数（不含首次） */
  aiMaxRetries: () => Number(process.env.AI_MAX_RETRIES ?? 2),
  /** 不发外部请求的 AI 配置就绪检查，供 readiness 使用。 */
  aiConfigReady: () => {
    const key = process.env.CHANGE2PRO_API_KEY || process.env.NANOBANANA_API_KEY;
    const baseUrl = process.env.CHANGE2PRO_BASE_URL ?? "";
    if (!key || !baseUrl || /your-change2pro-host/i.test(baseUrl)) return false;
    try {
      const url = new URL(baseUrl);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }
};

// server/routes/generate.ts
import { Router } from "express";

// src/types/workflow.ts
var MAX_REFERENCE_IMAGES = 8;
var WORKFLOW_SCHEMA_VERSION = 1;
var NODE_SPECS = {
  "image-input": {
    kind: "image-input",
    title: "\u56FE\u7247\u4E0A\u4F20",
    description: "\u4E0A\u4F20\u8349\u56FE / \u6B3E\u5F0F\u56FE / \u9762\u6599\u53C2\u8003",
    inputs: 0,
    outputs: "images"
  },
  "sketch-to-render": {
    kind: "sketch-to-render",
    title: "\u8349\u56FE\u2192\u6548\u679C\u56FE",
    description: "AI \u5C06\u7EBF\u7A3F\u6E32\u67D3\u4E3A\u670D\u88C5\u6548\u679C\u56FE",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  "ai-modify": {
    kind: "ai-modify",
    title: "AI \u6539\u6B3E",
    description: "gpt-image-2 \u6539\u9886\u578B/\u8896\u578B/\u957F\u5EA6/\u7EC6\u8282",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  "fabric-recolor": {
    kind: "fabric-recolor",
    title: "\u9762\u6599/\u914D\u8272\u66FF\u6362",
    description: "gpt-image-2 \u66FF\u6362\u9762\u6599\u7EB9\u7406\u4E0E\u914D\u8272",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  upscale: {
    kind: "upscale",
    title: "\u9AD8\u6E05\u653E\u5927",
    description: "AI \u653E\u5927\u81F3 2K/4K\uFF0C\u7CBE\u4FEE\u7EC6\u8282",
    providerId: "gpt-image-2",
    inputs: 1,
    outputs: "images"
  },
  "print-extract": {
    kind: "print-extract",
    title: "\u5370\u82B1\u63D0\u53D6",
    description: "gpt-image-2 \u4ECE\u670D\u88C5\u4E0A\u62A0\u51FA\u5370\u82B1\uFF0C\u5E73\u94FA\u5C55\u5F00\u5B58\u7D20\u6750",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  "print-mutate": {
    kind: "print-mutate",
    title: "\u5370\u82B1\u88C2\u53D8",
    description: "gpt-image-2 \u57FA\u4E8E\u5370\u82B1\u751F\u6210 1~8 \u5F20\u98CE\u683C\u4E00\u81F4\u7684\u53D8\u4F53",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  result: {
    kind: "result",
    title: "\u7ED3\u679C",
    description: "\u6C47\u603B\u5C55\u793A\u4E0E\u5BFC\u51FA",
    inputs: 4,
    outputs: "none"
  }
};

// server/providers/base.ts
var ProviderError = class extends Error {
  constructor(message, status, providerId) {
    super(message);
    this.status = status;
    this.providerId = providerId;
    this.name = "ProviderError";
  }
  status;
  providerId;
};
var NotImplementedError = class extends ProviderError {
  constructor(feature) {
    super(`Not implemented: ${feature}`);
    this.name = "NotImplementedError";
  }
};
async function fetchWithRetry(url, initFactory, opts) {
  const timeoutMs = opts?.timeoutMs ?? config.aiTimeoutMs();
  const maxRetries = opts?.maxRetries ?? config.aiMaxRetries();
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(500 * 2 ** (attempt - 1));
    }
    try {
      const res = await fetch(url, {
        ...initFactory(),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => "");
        throw new ProviderError(
          `HTTP ${res.status}: ${body.slice(0, 500)}`,
          res.status,
          opts?.providerId
        );
      }
      if (res.status >= 500) {
        const body = await res.text().catch(() => "");
        lastError = new ProviderError(
          `HTTP ${res.status}: ${body.slice(0, 500)}`,
          res.status,
          opts?.providerId
        );
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof ProviderError && err.status !== void 0 && err.status < 500) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new ProviderError(String(lastError), void 0, opts?.providerId);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !m[2]) {
    throw new ProviderError("Invalid dataURL (expected base64)");
  }
  const mime = m[1] || "image/png";
  const base64 = m[3];
  return { mime, base64, buffer: Buffer.from(base64, "base64") };
}
function toDataUrl(base64, mime = "image/png") {
  return `data:${mime};base64,${base64}`;
}
function aspectRatioToSize(aspectRatio) {
  switch (aspectRatio) {
    case "3:4":
    case "9:16":
      return "1024x1536";
    case "4:3":
    case "16:9":
      return "1536x1024";
    default:
      return "1024x1024";
  }
}

// server/providers/nanobanana.ts
var PROVIDER_ID = "nanobanana";
async function generateOnce(req) {
  const url = `${config.change2proBaseUrl()}/images/generations`;
  const res = await fetchWithRetry(
    url,
    () => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.nanobananaApiKey()}`
      },
      body: JSON.stringify({
        model: config.nanobananaModel(),
        prompt: req.prompt,
        n: 1,
        size: aspectRatioToSize(req.aspectRatio),
        quality: "low",
        output_format: "png"
      })
    }),
    { providerId: PROVIDER_ID }
  );
  const json = await res.json();
  if (json.error) {
    throw new ProviderError(json.error.message ?? "images api error", json.error.code, PROVIDER_ID);
  }
  const images = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) images.push(toDataUrl(item.b64_json));
    else if (item.url) images.push(item.url);
  }
  if (images.length === 0) {
    throw new ProviderError("nanobanana returned no image", void 0, PROVIDER_ID);
  }
  return images;
}
var nanobananaProvider = {
  id: PROVIDER_ID,
  /** 文生图；batchSize 通过多次调用实现 */
  async generate(req) {
    const n = Math.max(1, Math.min(req.batchSize ?? 1, 4));
    const settled = await Promise.all(Array.from({ length: n }, () => generateOnce(req)));
    return {
      images: settled.flat(),
      model: config.nanobananaModel()
    };
  },
  /** 图生图：使用 /images/edits multipart 接口。 */
  async edit(req) {
    if (!req.referenceImages?.length) {
      throw new ProviderError("edit requires referenceImages", 400, PROVIDER_ID);
    }
    if (req.referenceImages.length > MAX_REFERENCE_IMAGES) {
      throw new ProviderError(`edit supports at most ${MAX_REFERENCE_IMAGES} reference images`, 400, PROVIDER_ID);
    }
    const url = `${config.change2proBaseUrl()}/images/edits`;
    const res = await fetchWithRetry(
      url,
      () => {
        const form = new FormData();
        form.append("model", config.nanobananaModel());
        form.append("prompt", req.prompt);
        form.append("size", aspectRatioToSize(req.aspectRatio));
        form.append("n", String(Math.max(1, Math.min(req.batchSize ?? 1, 4))));
        req.referenceImages.forEach((ref, index) => {
          const { mime, buffer } = parseDataUrl(ref);
          const ext = mime.split("/")[1] ?? "png";
          form.append(
            "image[]",
            new Blob([new Uint8Array(buffer)], { type: mime }),
            `ref-${index}.${ext}`
          );
        });
        if (req.mask) {
          const { mime, buffer } = parseDataUrl(req.mask);
          form.append("mask", new Blob([new Uint8Array(buffer)], { type: mime }), "mask.png");
        }
        return {
          method: "POST",
          headers: { Authorization: `Bearer ${config.nanobananaApiKey()}` },
          body: form
        };
      },
      { providerId: PROVIDER_ID }
    );
    const json = await res.json();
    if (json.error) {
      throw new ProviderError(json.error.message ?? "images api error", json.error.code, PROVIDER_ID);
    }
    const images = [];
    for (const item of json.data ?? []) {
      if (item.b64_json) images.push(toDataUrl(item.b64_json));
      else if (item.url) images.push(item.url);
    }
    if (images.length === 0) {
      throw new ProviderError("nanobanana returned no image", void 0, PROVIDER_ID);
    }
    return { images, model: config.nanobananaModel() };
  }
};

// server/providers/image2.ts
var PROVIDER_ID2 = "gpt-image-2";
function parseImagesResponse(json) {
  if (json.error) {
    throw new ProviderError(json.error.message ?? "images api error", void 0, PROVIDER_ID2);
  }
  const images = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) images.push(toDataUrl(item.b64_json));
    else if (item.url) images.push(item.url);
  }
  if (images.length === 0) {
    throw new ProviderError("gpt-image-2 returned no image", void 0, PROVIDER_ID2);
  }
  return images;
}
var image2Provider = {
  id: PROVIDER_ID2,
  /** 无参考图：/v1/images/generations */
  async generate(req) {
    const url = `${config.change2proBaseUrl()}/images/generations`;
    const res = await fetchWithRetry(
      url,
      () => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.change2proApiKey()}`
        },
        body: JSON.stringify({
          model: config.image2Model(),
          prompt: req.prompt,
          n: Math.max(1, Math.min(req.batchSize ?? 1, 4)),
          size: aspectRatioToSize(req.aspectRatio),
          quality: "low",
          output_format: "png"
        })
      }),
      { providerId: PROVIDER_ID2 }
    );
    const json = await res.json();
    return { images: parseImagesResponse(json), model: config.image2Model() };
  },
  /** 有参考图：/v1/images/edits，multipart form 上传 */
  async edit(req) {
    if (!req.referenceImages?.length) {
      throw new ProviderError("edit requires referenceImages", 400, PROVIDER_ID2);
    }
    if (req.referenceImages.length > MAX_REFERENCE_IMAGES) {
      throw new ProviderError(`edit supports at most ${MAX_REFERENCE_IMAGES} reference images`, 400, PROVIDER_ID2);
    }
    const url = `${config.change2proBaseUrl()}/images/edits`;
    const res = await fetchWithRetry(
      url,
      () => {
        const form = new FormData();
        form.append("model", config.image2Model());
        form.append("prompt", req.prompt);
        form.append("size", aspectRatioToSize(req.aspectRatio));
        form.append("n", String(Math.max(1, Math.min(req.batchSize ?? 1, 4))));
        req.referenceImages.forEach((ref, i) => {
          const { mime, buffer } = parseDataUrl(ref);
          const ext = mime.split("/")[1] ?? "png";
          form.append("image[]", new Blob([new Uint8Array(buffer)], { type: mime }), `ref-${i}.${ext}`);
        });
        if (req.mask) {
          const { mime, buffer } = parseDataUrl(req.mask);
          form.append("mask", new Blob([new Uint8Array(buffer)], { type: mime }), "mask.png");
        }
        return {
          method: "POST",
          headers: { Authorization: `Bearer ${config.change2proApiKey()}` },
          body: form
        };
      },
      { providerId: PROVIDER_ID2 }
    );
    const json = await res.json();
    return { images: parseImagesResponse(json), model: config.image2Model() };
  }
};

// server/providers/index.ts
var comfyuiStub = {
  id: "comfyui-local",
  generate() {
    throw new NotImplementedError("comfyui-local provider (reserved for P1)");
  },
  edit() {
    throw new NotImplementedError("comfyui-local provider (reserved for P1)");
  }
};
var providers = {
  nanobanana: nanobananaProvider,
  "gpt-image-2": image2Provider,
  "comfyui-local": comfyuiStub
};
function getProvider(id) {
  const p = providers[id];
  if (!p) {
    throw new ProviderError(`Unknown provider id: ${id}`, 400);
  }
  return p;
}

// server/providers/exact.ts
async function generateExactImages(provider, request, requestedCount) {
  const target = Math.max(1, Math.min(8, Math.floor(requestedCount) || 1));
  const images = [];
  const failures = [];
  let model = provider.id;
  let providerRequests = 0;
  let firstError;
  const maxAttempts = target + 3;
  while (images.length < target && providerRequests < maxAttempts) {
    const remaining = target - images.length;
    const current = { ...request, batchSize: Math.min(4, remaining) };
    providerRequests += 1;
    try {
      const result = current.referenceImages?.length ? await provider.edit(current) : await provider.generate(current);
      model = result.model;
      const accepted = result.images.filter(Boolean).slice(0, remaining);
      images.push(...accepted);
      if (accepted.length === 0) failures.push("\u6A21\u578B\u672A\u8FD4\u56DE\u56FE\u7247");
    } catch (error) {
      firstError ??= error;
      failures.push(error instanceof Error ? error.message : String(error));
      if (error instanceof ProviderError && error.status !== void 0 && error.status >= 400 && error.status < 500) break;
    }
  }
  if (images.length === 0) throw firstError instanceof Error ? firstError : new Error(failures[0] ?? "\u6A21\u578B\u672A\u8FD4\u56DE\u56FE\u7247");
  if (images.length < target) failures.push(`\u53EA\u751F\u6210\u4E86 ${images.length}/${target} \u5F20\u56FE\u7247`);
  return { images, model, providerRequests, failures };
}

// server/lib/fileStore.ts
import fs2 from "node:fs";
import path2 from "node:path";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { nanoid } from "nanoid";

// server/lib/imageValidation.ts
var ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
var ImageValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ImageValidationError";
  }
};
function hasMagic(buffer, bytes, offset = 0) {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}
function detectImageMime(buffer) {
  if (buffer.length >= 8 && hasMagic(buffer, [137, 80, 78, 71, 13, 10, 26, 10])) {
    return "image/png";
  }
  if (buffer.length >= 3 && hasMagic(buffer, [255, 216, 255])) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 6) {
    const signature = buffer.toString("ascii", 0, 6);
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return null;
}
function validateImageDataUrl(dataUrl, maxBytes = MAX_IMAGE_BYTES) {
  if (typeof dataUrl !== "string") throw new ImageValidationError("image dataURL must be a string");
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) throw new ImageValidationError("invalid image dataURL (strict base64 required)");
  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.includes(mime)) {
    throw new ImageValidationError(`unsupported image MIME: ${mime}`);
  }
  const encoded = match[2];
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    throw new ImageValidationError("invalid image base64 payload");
  }
  if (encoded.includes("=") && !/^[A-Za-z0-9+/]+={1,2}$/.test(encoded)) {
    throw new ImageValidationError("invalid image base64 padding");
  }
  const estimatedBytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (estimatedBytes > maxBytes) throw new ImageValidationError(`image too large (limit ${maxBytes} bytes)`);
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.length !== estimatedBytes) {
    throw new ImageValidationError("invalid image base64 payload");
  }
  if (buffer.toString("base64") !== encoded) {
    throw new ImageValidationError("non-canonical image base64 payload");
  }
  const detected = detectImageMime(buffer);
  if (!detected) throw new ImageValidationError("unrecognized image file signature");
  if (detected !== mime) {
    throw new ImageValidationError(`image MIME/signature mismatch: declared ${mime}, detected ${detected}`);
  }
  return { mime, buffer };
}
function isLocalImageReference(value) {
  if (typeof value !== "string") return false;
  return /^\/api\/files\/[A-Za-z0-9_-]{1,128}\.(?:png|jpe?g|webp|gif)$/.test(value);
}

// server/lib/fileStore.ts
var MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};
var EXT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
};
function uploadsDir() {
  const dir = path2.join(config.dataDir(), "uploads");
  fs2.mkdirSync(dir, { recursive: true });
  return dir;
}
function saveDataUrl(dataUrl) {
  const { mime, buffer } = validateImageDataUrl(dataUrl);
  const ext = MIME_EXT[mime];
  const id = `${nanoid(12)}.${ext}`;
  const filePath = path2.join(uploadsDir(), id);
  const fd = fs2.openSync(filePath, "wx", 384);
  try {
    fs2.writeFileSync(fd, buffer);
    fs2.fsyncSync(fd);
  } catch (error) {
    try {
      fs2.unlinkSync(filePath);
    } catch {
    }
    throw error;
  } finally {
    fs2.closeSync(fd);
  }
  return { id, url: `/api/files/${id}` };
}
function resolveToDataUrl(ref) {
  if (!ref.startsWith("/api/files/")) return ref;
  const id = path2.basename(ref);
  const filePath = path2.join(uploadsDir(), id);
  if (!fs2.existsSync(filePath)) {
    throw new Error(`referenced file not found: ${id}`);
  }
  const ext = path2.extname(id).slice(1).toLowerCase();
  const expectedMime = EXT_MIME[ext];
  if (!expectedMime) throw new Error(`unsupported referenced file type: ${ext}`);
  const buffer = fs2.readFileSync(filePath);
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`referenced image too large: ${id}`);
  const mime = detectImageMime(buffer);
  if (!mime || mime !== expectedMime) throw new Error(`referenced file is not a valid ${expectedMime} image: ${id}`);
  const base64 = buffer.toString("base64");
  return `data:${mime};base64,${base64}`;
}
function mimeOfFile(id) {
  const ext = path2.extname(id).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? "image/png";
}
function isSupportedImageFile(id) {
  return Object.prototype.hasOwnProperty.call(EXT_MIME, path2.extname(id).slice(1).toLowerCase());
}
var MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
var DOWNLOAD_TIMEOUT_MS = 3e4;
var MAX_REDIRECTS = 5;
function ipv4Number(address) {
  const pieces = address.split(".");
  if (pieces.length !== 4) return null;
  let result = 0;
  for (const piece of pieces) {
    if (!/^\d{1,3}$/.test(piece)) return null;
    const value = Number(piece);
    if (value < 0 || value > 255) return null;
    result = result * 256 + value;
  }
  return result >>> 0;
}
function inV4Cidr(value, base, prefix) {
  const block = 2 ** (32 - prefix);
  return Math.floor(value / block) === Math.floor(base / block);
}
function expandIpv6(address) {
  const pieces = address.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || pieces.length === 1 && missing !== 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}
function isGlobalIpAddress(raw) {
  let address = raw.toLowerCase().split("%")[0];
  if (address.startsWith("::") && address.includes(".")) {
    const embedded = address.slice(address.lastIndexOf(":") + 1);
    return isGlobalIpAddress(embedded);
  }
  if (address.startsWith("::ffff:")) {
    const mapped = address.slice(7);
    if (isIP(mapped) === 4) return isGlobalIpAddress(mapped);
    const groups2 = mapped.split(":");
    if (groups2.length === 2 && groups2.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const value = Number.parseInt(groups2[0], 16) * 65536 + Number.parseInt(groups2[1], 16) >>> 0;
      return isGlobalIpAddress(`${value >>> 24}.${value >>> 16 & 255}.${value >>> 8 & 255}.${value & 255}`);
    }
    return false;
  }
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    if (value === null) return false;
    const blocked = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4]
    ];
    return !blocked.some(([base, prefix]) => inV4Cidr(value, ipv4Number(base), prefix));
  }
  if (isIP(address) !== 6) return false;
  const groups = expandIpv6(address);
  if (!groups) return false;
  const first = groups[0];
  if (address === "::" || address === "::1") return false;
  if (first === 0 && groups.slice(1, 5).every((group) => group === 0)) return false;
  if ((first & 65024) === 64512) return false;
  if ((first & 65472) === 65152) return false;
  if ((first & 65280) === 65280) return false;
  if (first === 8193 && groups[1] === 3512) return false;
  if (first === 8193 && groups[1] === 0) return false;
  if (first === 8194) return false;
  return true;
}
async function defaultHostLookup(hostname) {
  return (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}
async function pinnedFetch(u, init, address) {
  return await new Promise((resolve, reject) => {
    const client = u.protocol === "https:" ? https : http;
    const request = client.request(
      u,
      {
        method: "GET",
        headers: { accept: "image/*", host: u.host },
        signal: init.signal ?? void 0,
        lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
        ...u.protocol === "https:" ? { servername: u.hostname } : {}
      },
      (response) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        response.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.byteLength;
          if (total > MAX_DOWNLOAD_BYTES) {
            settled = true;
            response.destroy(new Error(`image too large: more than ${MAX_DOWNLOAD_BYTES} bytes`));
            reject(new Error(`image too large: more than ${MAX_DOWNLOAD_BYTES} bytes`));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", (error) => {
          if (!settled) reject(error);
        });
        response.once("end", () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks, total);
          resolve({
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            status: response.statusCode ?? 0,
            headers: { get: (name) => {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(", ") : value ?? null;
            } },
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
          });
        });
      }
    );
    request.once("error", reject);
    request.end();
  });
}
async function assertUrlAllowed(raw, lookup = defaultHostLookup) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked protocol: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "metadata.google.internal" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error(`blocked private/metadata host: ${host}`);
  }
  const addresses = isIP(host) ? [host] : await lookup(host);
  if (addresses.length === 0) throw new Error(`hostname did not resolve: ${host}`);
  const blocked = addresses.find((address) => !isGlobalIpAddress(address));
  if (blocked) throw new Error(`blocked non-global address for ${host}: ${blocked}`);
  return u;
}
async function downloadImageToDataUrl(raw, dependencies) {
  const lookup = dependencies?.lookup ?? defaultHostLookup;
  const fetcher = dependencies?.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let u = await assertUrlAllowed(raw, lookup);
    let res;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const addresses = isIP(u.hostname) ? [u.hostname] : await lookup(u.hostname);
      const blocked = addresses.find((address) => !isGlobalIpAddress(address));
      if (addresses.length === 0 || blocked) throw new Error(`blocked non-global address for ${u.hostname}: ${blocked ?? "no addresses"}`);
      res = fetcher ? await fetcher(u, { signal: ctrl.signal, redirect: "manual" }) : await pinnedFetch(u, { signal: ctrl.signal, redirect: "manual" }, addresses[0]);
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      if (redirects === MAX_REDIRECTS) throw new Error(`too many image redirects (limit ${MAX_REDIRECTS})`);
      const location = res.headers.get("location");
      if (!location) throw new Error(`image redirect missing Location header: HTTP ${res.status}`);
      u = await assertUrlAllowed(new URL(location, u), lookup);
    }
    if (!res) throw new Error("image download did not produce a response");
    if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) {
      throw new Error(`not an image response: ${mime || "unknown content-type"}`);
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`image too large: ${contentLength} bytes (limit ${MAX_DOWNLOAD_BYTES})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error("empty image response");
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`image too large: ${buf.byteLength} bytes (limit ${MAX_DOWNLOAD_BYTES})`);
    }
    const detected = detectImageMime(buf);
    if (!detected || detected !== mime) throw new Error(`image MIME/signature mismatch: declared ${mime || "unknown"}, detected ${detected || "unknown"}`);
    return toDataUrl(buf.toString("base64"), detected);
  } finally {
    clearTimeout(timer);
  }
}
async function normalizeImageRef(ref) {
  if (ref.startsWith("data:")) {
    const { mime, buffer } = validateImageDataUrl(ref);
    return toDataUrl(buffer.toString("base64"), mime);
  }
  if (ref.startsWith("/api/files/")) return resolveToDataUrl(ref);
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    return downloadImageToDataUrl(ref);
  }
  throw new Error(`unsupported image reference: ${ref.slice(0, 80)}`);
}
async function persistImageRef(ref) {
  if (ref.startsWith("/api/files/")) return ref;
  const dataUrl = await normalizeImageRef(ref);
  return saveDataUrl(dataUrl).url;
}

// server/routes/generate.ts
import { nanoid as nanoid4 } from "nanoid";

// server/lib/auth.ts
import { createHash, randomBytes as randomBytes2 } from "node:crypto";

// server/lib/database.ts
import pg from "pg";
import { nanoid as nanoid2 } from "nanoid";

// server/lib/password.ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
var KEY_LENGTH = 64;
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
function verifyPassword(password, encoded) {
  const [algorithm, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
function validatePassword(password) {
  if (password.length < 10) return "\u5BC6\u7801\u81F3\u5C11\u9700\u8981 10 \u4F4D";
  if (password.length > 200) return "\u5BC6\u7801\u4E0D\u80FD\u8D85\u8FC7 200 \u4F4D";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "\u5BC6\u7801\u5FC5\u987B\u540C\u65F6\u5305\u542B\u5B57\u6BCD\u548C\u6570\u5B57";
  return void 0;
}

// server/lib/sqliteImport.ts
import fs3 from "node:fs";
import Database from "better-sqlite3";
var TABLES = [
  { name: "users", columns: ["id", "account_id", "display_name", "role", "password_hash", "must_change_password", "active", "deleted_at", "created_at", "updated_at"] },
  { name: "sessions", columns: ["token_hash", "user_id", "created_at", "expires_at"] },
  { name: "projects", columns: ["id", "owner_id", "name", "flow_json", "updated_at", "created_at", "deleted_at", "purge_after"] },
  { name: "files", columns: ["id", "owner_id", "source_type", "project_id", "node_id", "run_id", "created_at"] },
  { name: "assets", columns: ["id", "owner_id", "scope", "name", "category", "image", "source_note", "created_at", "deleted_at", "purge_after"] },
  { name: "project_asset_refs", columns: ["project_id", "asset_id", "created_at"] },
  { name: "generation_runs", columns: ["id", "owner_id", "project_id", "project_name", "node_id", "node_label", "kind", "prompt", "parameters_json", "reference_images_json", "model", "requested_count", "successful_count", "provider_requests", "status", "error", "started_at", "finished_at"] },
  { name: "generation_outputs", columns: ["id", "run_id", "image", "prompt", "status", "error", "created_at"] },
  { name: "usage_events", columns: ["id", "owner_id", "run_id", "project_id", "node_id", "model", "successful_count", "provider_requests", "duration_ms", "created_at"] }
];
function sqliteTableExists(source, table) {
  return Boolean(source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
async function importTable(source, client, name, columns) {
  if (!sqliteTableExists(source, name)) return 0;
  const rows = source.prepare(`SELECT ${columns.join(", ")} FROM ${name}`).all();
  if (rows.length === 0) return 0;
  const columnSql = columns.map((column) => `"${column}"`).join(", ");
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  for (const row of rows) {
    await client.query(
      `INSERT INTO "${name}" (${columnSql}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
      columns.map((column) => row[column] ?? null)
    );
  }
  return rows.length;
}
async function importSqliteIfNeeded() {
  const target = await queryOne("SELECT COUNT(*)::int AS count FROM users");
  if ((target?.count ?? 0) > 0) return;
  const sourcePath = config.sqliteImportPath();
  if (!fs3.existsSync(sourcePath) || fs3.statSync(sourcePath).size === 0) return;
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const client = await db().connect();
  try {
    if (!sqliteTableExists(source, "users")) return;
    await client.query("BEGIN");
    let imported = 0;
    for (const table of TABLES) imported += await importTable(source, client, table.name, table.columns);
    await client.query("COMMIT");
    console.log(`[garment-canvas] imported ${imported} rows from SQLite into PostgreSQL`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`SQLite \u6570\u636E\u8FC1\u79FB\u5230 PostgreSQL \u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  } finally {
    source.close();
    client.release();
  }
}

// server/lib/database.ts
var { Pool, types } = pg;
types.setTypeParser(20, Number);
var pool;
var initialization;
function db() {
  if (!pool) {
    const connectionString = config.databaseUrl();
    pool = new Pool({
      ...connectionString ? { connectionString } : {
        host: config.databaseHost(),
        port: config.databasePort(),
        database: config.databaseName(),
        user: config.databaseUser(),
        password: config.databasePassword()
      },
      max: config.databasePoolSize(),
      connectionTimeoutMillis: 1e4,
      idleTimeoutMillis: 3e4
    });
    pool.on("error", (error) => console.error("[garment-canvas] PostgreSQL idle client error", error));
  }
  return pool;
}
async function query(text, values = [], client = db()) {
  return (await client.query(text, values)).rows;
}
async function queryOne(text, values = [], client = db()) {
  return (await client.query(text, values)).rows[0];
}
async function transaction(fn) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function initializeDatabase() {
  initialization ??= (async () => {
    await migrate();
    await importSqliteIfNeeded();
    await bootstrapInitialAdmin();
  })();
  return initialization;
}
async function migrate() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','user')),
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      flow_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id),
      source_type TEXT NOT NULL DEFAULT 'upload',
      project_id TEXT,
      node_id TEXT,
      run_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS files_owner_idx ON files(owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id),
      scope TEXT NOT NULL CHECK (scope IN ('global','private','shared')),
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('print','fabric','reference')),
      image TEXT NOT NULL,
      source_note TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS assets_scope_owner_idx ON assets(scope, owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_asset_refs (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS generation_runs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT,
      project_name TEXT,
      node_id TEXT NOT NULL,
      node_label TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      parameters_json TEXT,
      reference_images_json TEXT,
      model TEXT,
      requested_count INTEGER NOT NULL DEFAULT 1,
      successful_count INTEGER NOT NULL DEFAULT 0,
      provider_requests INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('queued','running','success','error')),
      error TEXT,
      started_at BIGINT NOT NULL,
      finished_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS generation_runs_owner_idx ON generation_runs(owner_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS generation_outputs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
      image TEXT NOT NULL DEFAULT '',
      prompt TEXT,
      status TEXT NOT NULL CHECK (status IN ('success','error')),
      error TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generation_outputs_run_idx ON generation_outputs(run_id, created_at);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES generation_runs(id) ON DELETE RESTRICT,
      project_id TEXT,
      node_id TEXT NOT NULL,
      model TEXT,
      successful_count INTEGER NOT NULL CHECK (successful_count > 0),
      provider_requests INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_owner_idx ON usage_events(owner_id, created_at DESC);
  `);
}
async function bootstrapInitialAdmin() {
  const row = await queryOne("SELECT COUNT(*)::int AS count FROM users");
  if ((row?.count ?? 0) > 0) return;
  const accountId = config.initialAdminAccountId();
  const password = config.initialAdminPassword();
  if (!accountId || !password) return;
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(`INITIAL_ADMIN_PASSWORD \u4E0D\u7B26\u5408\u8981\u6C42\uFF1A${passwordError}`);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db().query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
    VALUES ($1, $2, $3, 'admin', $4, 1, 1, $5, $5)
    ON CONFLICT (account_id) DO NOTHING
  `, [nanoid2(12), accountId, "\u7BA1\u7406\u5458", hashPassword(password), now]);
}
async function hasUsers() {
  const row = await queryOne("SELECT EXISTS(SELECT 1 FROM users) AS ok");
  return row?.ok === true;
}
async function databaseReady() {
  try {
    await db().query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// server/lib/auth.ts
var SESSION_COOKIE = "gc_session";
var SESSION_DAYS = 30;
function sessionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}
function cookieValue(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return void 0;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return void 0;
}
async function createSession(userId) {
  const token = randomBytes2(32).toString("base64url");
  const now = /* @__PURE__ */ new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1e3).toISOString();
  await transaction(async (client) => {
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await client.query(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [sessionHash(token), userId, now.toISOString(), expiresAt]
    );
  });
  return { token, expiresAt };
}
function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "true";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1e3
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
}
async function revokeRequestSession(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [sessionHash(token)]);
}
async function revokeUserSessions(userId) {
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}
async function authenticatedUser(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return void 0;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const row = await queryOne(`
    SELECT u.id, u.account_id, u.display_name, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = 1 AND u.deleted_at IS NULL
  `, [sessionHash(token), now]);
  if (!row) return void 0;
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1
  };
}
function requireAuth(req, res, next) {
  void authenticatedUser(req).then((user) => {
    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ error: "\u8BF7\u5148\u767B\u5F55", code: "UNAUTHENTICATED" });
      return;
    }
    req.authUser = user;
    next();
  }).catch(next);
}
function requirePasswordChanged(req, res, next) {
  const user = req.authUser;
  if (user.mustChangePassword) {
    res.status(403).json({ error: "\u9996\u6B21\u767B\u5F55\u5FC5\u987B\u4FEE\u6539\u5BC6\u7801", code: "PASSWORD_CHANGE_REQUIRED" });
    return;
  }
  next();
}
function requireAdmin(req, res, next) {
  const user = req.authUser;
  if (user.role !== "admin") {
    res.status(403).json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650", code: "FORBIDDEN" });
    return;
  }
  next();
}
function requestUser(req) {
  return req.authUser;
}
async function pruneExpiredSessions() {
  await query("DELETE FROM sessions WHERE expires_at <= $1", [(/* @__PURE__ */ new Date()).toISOString()]);
}

// server/lib/generationRecords.ts
import { nanoid as nanoid3 } from "nanoid";
import path3 from "node:path";
async function createGenerationRecord(runId, context, startedAt) {
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, project_id, project_name, node_id, node_label, kind, prompt,
      parameters_json, reference_images_json, requested_count, status, started_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12)
  `, [
    runId,
    context.userId,
    context.projectId ?? null,
    context.projectName ?? null,
    context.nodeId,
    context.nodeLabel,
    context.kind,
    context.prompt ?? null,
    JSON.stringify(context.parameters ?? {}),
    JSON.stringify(context.referenceImages ?? []),
    context.requestedCount,
    startedAt
  ]);
}
async function markGenerationRunning(runId, startedAt) {
  await query("UPDATE generation_runs SET status = 'running', started_at = $1 WHERE id = $2", [startedAt, runId]);
}
async function registerGeneratedFiles(context, runId, nodeId, images, createdAt) {
  const createdAtIso = new Date(createdAt).toISOString();
  await transaction(async (client) => {
    for (const image of images) {
      if (!image.startsWith("/api/files/")) continue;
      await client.query(`
        INSERT INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
        VALUES ($1, $2, 'generated', $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING
      `, [path3.basename(image), context.userId, context.projectId ?? null, nodeId, runId, createdAtIso]);
    }
  });
}
async function completeGenerationRecord(args) {
  await transaction(async (client) => {
    const run = await queryOne(
      "SELECT owner_id, project_id, node_id FROM generation_runs WHERE id = $1 FOR UPDATE",
      [args.runId],
      client
    );
    if (!run) return;
    await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [args.runId]);
    for (const [index, image] of args.images.entries()) {
      await client.query(`
        INSERT INTO generation_outputs (id, run_id, image, prompt, status, error, created_at)
        VALUES ($1, $2, $3, $4, 'success', NULL, $5)
      `, [nanoid3(12), args.runId, image, args.prompts?.[index] ?? null, args.finishedAt + index]);
      if (image.startsWith("/api/files/")) {
        await client.query(`
          INSERT INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
          VALUES ($1, $2, 'generated', $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `, [path3.basename(image), run.owner_id, run.project_id, run.node_id, args.runId, new Date(args.finishedAt).toISOString()]);
      }
    }
    for (const [index, failure] of (args.failures ?? []).entries()) {
      await client.query(`
        INSERT INTO generation_outputs (id, run_id, image, prompt, status, error, created_at)
        VALUES ($1, $2, '', $3, 'error', $4, $5)
      `, [nanoid3(12), args.runId, failure.prompt ?? null, failure.error, args.finishedAt + args.images.length + index]);
    }
    const warning = args.failures?.length ? `${args.failures.length} \u4E2A\u751F\u6210\u4EFB\u52A1\u5931\u8D25` : null;
    await client.query(`
      UPDATE generation_runs SET status = 'success', successful_count = $1, provider_requests = $2,
        model = $3, error = $4, finished_at = $5 WHERE id = $6
    `, [args.images.length, args.providerRequests, args.model ?? null, warning, args.finishedAt, args.runId]);
    if (args.images.length > 0) {
      await client.query(`
        INSERT INTO usage_events (
          id, owner_id, run_id, project_id, node_id, model, successful_count,
          provider_requests, duration_ms, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (run_id) DO UPDATE SET
          model = excluded.model,
          successful_count = excluded.successful_count,
          provider_requests = excluded.provider_requests,
          duration_ms = excluded.duration_ms,
          created_at = excluded.created_at
      `, [
        nanoid3(12),
        run.owner_id,
        args.runId,
        run.project_id,
        run.node_id,
        args.model ?? null,
        args.images.length,
        args.providerRequests,
        Math.max(0, args.finishedAt - args.startedAt),
        new Date(args.finishedAt).toISOString()
      ]);
    }
  });
}
async function failGenerationRecord(runId, error, finishedAt) {
  await transaction(async (client) => {
    await client.query("UPDATE generation_runs SET status = 'error', error = $1, finished_at = $2 WHERE id = $3", [
      error,
      finishedAt,
      runId
    ]);
    await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [runId]);
    await client.query(`
      INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
      SELECT $1, id, '', 'error', $2, $3 FROM generation_runs WHERE id = $4
    `, [nanoid3(12), error, finishedAt, runId]);
  });
}

// server/routes/generate.ts
var generateRouter = Router();
generateRouter.post("/", async (req, res) => {
  const { providerId, request, projectId, projectName, nodeId, nodeLabel, kind } = req.body;
  if (!providerId || !request?.prompt) {
    res.status(400).json({ error: "providerId and request.prompt are required" });
    return;
  }
  if (request.referenceImages && request.referenceImages.length > MAX_REFERENCE_IMAGES) {
    res.status(400).json({ error: `referenceImages must contain at most ${MAX_REFERENCE_IMAGES} images` });
    return;
  }
  const runId = nanoid4(10);
  const startedAt = Date.now();
  const requestedCount = Math.max(1, Math.min(8, Number(request.batchSize) || 1));
  await createGenerationRecord(runId, {
    userId: requestUser(req).id,
    projectId,
    projectName,
    nodeId: nodeId ?? "direct-generate",
    nodeLabel: nodeLabel ?? "\u76F4\u63A5\u751F\u6210",
    kind: kind ?? "sketch-to-render",
    prompt: request.prompt,
    parameters: request,
    referenceImages: request.referenceImages,
    requestedCount
  }, startedAt);
  await markGenerationRunning(runId, startedAt);
  try {
    const provider = getProvider(providerId);
    const resolved = {
      ...request,
      referenceImages: request.referenceImages ? await Promise.all(request.referenceImages.map(normalizeImageRef)) : void 0,
      mask: request.mask ? await normalizeImageRef(request.mask) : void 0
    };
    const raw = await generateExactImages(provider, resolved, requestedCount);
    const images = await Promise.all(raw.images.map(persistImageRef));
    const finishedAt = Date.now();
    const failures = raw.failures.map((error) => ({ prompt: request.prompt, error }));
    await completeGenerationRecord({
      runId,
      images,
      prompts: images.map(() => request.prompt),
      failures,
      model: raw.model,
      providerRequests: raw.providerRequests,
      startedAt,
      finishedAt
    });
    res.json({ ...raw, images, runId });
  } catch (err) {
    await failGenerationRecord(runId, err instanceof Error ? err.message : String(err), Date.now());
    if (err instanceof ProviderError) {
      res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: err.message,
        providerId: err.providerId ?? providerId
      });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});

// server/routes/runPlan.ts
import { Router as Router2 } from "express";

// server/engine/dag.ts
var DagError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DagError";
  }
};
function assertPlanInputs(plan, edges) {
  const executingNodeIds = new Set(plan.steps.map((step) => step.nodeId));
  for (const step of plan.steps) {
    const spec = NODE_SPECS[step.kind];
    if (!spec.providerId) continue;
    const usableImages = (step.upstream ?? []).flatMap(
      (upstream) => executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images
    );
    if (usableImages.length > MAX_REFERENCE_IMAGES) {
      throw new DagError(`Node ${step.nodeId} accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
    }
    if (step.kind === "sketch-to-render" && usableImages.length === 0) {
      const prompt = typeof step.params.prompt === "string" ? step.params.prompt.trim() : "";
      if (!prompt) throw new DagError(`Node ${step.nodeId} requires an image or a prompt`);
      continue;
    }
    if (step.kind === "fabric-recolor") {
      const garmentEdges = edges.filter(
        (edge) => edge.target === step.nodeId && edge.targetHandle !== "fabric"
      );
      const garmentIds = new Set(garmentEdges.map((edge) => edge.source));
      const garmentImages = (step.upstream ?? []).filter((upstream) => garmentIds.has(upstream.nodeId)).flatMap(
        (upstream) => executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images
      );
      if (garmentImages.length === 0) {
        throw new DagError(`Node ${step.nodeId} requires a garment image`);
      }
      continue;
    }
    if (usableImages.length === 0) {
      throw new DagError(`Node ${step.nodeId} requires an upstream image`);
    }
  }
}
function buildExecutionPlan(nodes, edges, opts) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (!nodeMap.has(e.source)) throw new DagError(`Edge source not found: ${e.source}`);
    if (!nodeMap.has(e.target)) throw new DagError(`Edge target not found: ${e.target}`);
  }
  let scope = null;
  if (opts?.onlyNodeId) {
    if (!nodeMap.has(opts.onlyNodeId)) {
      throw new DagError(`Node not found: ${opts.onlyNodeId}`);
    }
    scope = /* @__PURE__ */ new Set([opts.onlyNodeId]);
    if (opts.includeDownstream !== false) {
      const queue2 = [opts.onlyNodeId];
      while (queue2.length) {
        const cur = queue2.shift();
        for (const e of edges) {
          if (e.source === cur && !scope.has(e.target)) {
            scope.add(e.target);
            queue2.push(e.target);
          }
        }
      }
    }
  }
  const inScope = (id) => scope === null || scope.has(id);
  const scopedNodes = nodes.filter((n) => inScope(n.id));
  const scopedEdges = edges.filter((e) => inScope(e.source) && inScope(e.target));
  const indegree = /* @__PURE__ */ new Map();
  for (const n of scopedNodes) indegree.set(n.id, 0);
  for (const e of scopedEdges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  const queue = scopedNodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    for (const e of scopedEdges) {
      if (e.source !== id) continue;
      const d = (indegree.get(e.target) ?? 0) - 1;
      indegree.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  if (sorted.length !== scopedNodes.length) {
    const remaining = scopedNodes.filter((n) => !sorted.includes(n.id)).map((n) => n.id);
    throw new DagError(`Cycle detected in workflow, involved nodes: ${remaining.join(", ")}`);
  }
  const steps = sorted.map((id) => {
    const node = nodeMap.get(id);
    const data = node.data;
    const upstream = [];
    for (const e of edges) {
      if (e.target !== id) continue;
      const srcData = nodeMap.get(e.source).data;
      upstream.push({ nodeId: e.source, images: extractOutputImages(srcData) });
    }
    return {
      nodeId: id,
      kind: data.kind,
      inputImages: upstream.flatMap((u) => u.images),
      upstream,
      params: extractParams(data)
    };
  });
  return { steps };
}
function extractOutputImages(data) {
  switch (data.kind) {
    case "image-input":
      return data.imageUrl ? [data.imageUrl] : [];
    case "sketch-to-render":
    case "ai-modify":
    case "fabric-recolor":
    case "upscale":
    case "print-extract":
    case "print-mutate":
      return data.outputImages ?? [];
    case "result":
      return data.images ?? [];
  }
}
function extractParams(data) {
  switch (data.kind) {
    case "image-input":
      return { imageUrl: data.imageUrl, imageRole: data.imageRole };
    case "sketch-to-render":
      return { prompt: data.prompt, aspectRatio: data.aspectRatio, batchSize: data.batchSize };
    case "ai-modify":
      return { prompt: data.prompt, aspectRatio: data.aspectRatio, batchSize: data.batchSize };
    case "fabric-recolor":
      return {
        prompt: data.prompt,
        colors: data.colors,
        fabricImageUrl: data.fabricImageUrl
      };
    case "upscale":
      return { imageSize: data.imageSize };
    case "print-extract":
      return { prompt: data.prompt };
    case "print-mutate":
      return { prompt: data.prompt, count: data.count };
    case "result":
      return { note: data.note };
  }
}

// server/engine/runner.ts
import { EventEmitter } from "node:events";
import { nanoid as nanoid5 } from "nanoid";

// src/lib/colors.ts
var COLOR_CATEGORIES = [
  {
    id: "neutral",
    label: "\u4E2D\u6027\u57FA\u7840\u8272",
    swatches: [
      { name: "\u78B3\u7D20\u9ED1", hex: "#161616" },
      { name: "\u68D5\u9ED1", hex: "#2B1D16" },
      { name: "\u70AD\u9ED1", hex: "#1A1A1A" },
      { name: "\u66AE\u8272\u7070", hex: "#6B6B70" },
      { name: "\u70DF\u7070", hex: "#6E6E6E" },
      { name: "\u6DF1\u6D77\u9E25\u7070", hex: "#8B9296" },
      { name: "\u6C34\u6CE5\u7070", hex: "#9A9A98" },
      { name: "\u5927\u8C61\u7070", hex: "#8A8378" },
      { name: "\u66AE\u6C99\u7070", hex: "#A39B8B" },
      { name: "\u4E91\u70DF\u7070", hex: "#B9B7B2" },
      { name: "\u6D45\u7070", hex: "#C8C8C8" },
      { name: "\u73CD\u73E0\u767D", hex: "#F2EFE9" },
      { name: "\u71D5\u9EA6\u767D", hex: "#EDE6D6" },
      { name: "\u739B\u7459\u767D", hex: "#E9E4DA" },
      { name: "\u7C73\u767D", hex: "#F5F0E6" },
      { name: "\u67D4\u548C\u7C73", hex: "#E5DCC8" },
      { name: "\u5976\u674F\u7C73", hex: "#F0E4CE" },
      { name: "\u7EAF\u767D", hex: "#FFFFFF" },
      { name: "\u9999\u69DF\u8272", hex: "#F0DCB8" },
      { name: "\u9A7C\u8272", hex: "#C19A6B" },
      { name: "\u5361\u5176", hex: "#B8A47E" },
      { name: "\u5496\u5561", hex: "#6F4E37" },
      { name: "\u6989\u6728\u8272", hex: "#A67B4F" },
      { name: "\u7126\u7CD6", hex: "#A0522D" }
    ]
  },
  {
    id: "warm",
    label: "\u6696\u8272\u7CFB",
    swatches: [
      // 红
      { name: "\u7194\u5CA9\u7EA2", hex: "#B03A2E" },
      { name: "\u4E2D\u56FD\u7EA2", hex: "#DE2910" },
      { name: "\u6B63\u7EA2", hex: "#C8102E" },
      { name: "\u6A31\u6843\u7EA2", hex: "#C2183C" },
      { name: "\u6CE2\u826E\u7B2C\u7EA2", hex: "#5C1A24" },
      { name: "\u9152\u7EA2", hex: "#722F37" },
      { name: "\u6885\u6D1B\u8461\u8404\u9152\u7EA2", hex: "#6E2438" },
      { name: "\u7816\u7EA2", hex: "#B5493A" },
      // 粉
      { name: "\u8393\u679C\u7C89", hex: "#D98CA6" },
      { name: "\u82AD\u6BD4\u7C89", hex: "#E0219C" },
      { name: "\u73CA\u745A\u7C89", hex: "#F88379" },
      { name: "\u85D5\u7C89", hex: "#E8C4C4" },
      { name: "\u73AB\u7470\u8336", hex: "#C08585" },
      { name: "\u96FE\u73AB\u7470\u8272", hex: "#B48A8C" },
      { name: "\u7070\u7C89\u73AB", hex: "#C4A4A8" },
      { name: "\u73AB\u7470\u91D1", hex: "#B76E79" },
      // 橙
      { name: "\u7231\u9A6C\u4ED5\u6A59", hex: "#F37021" },
      { name: "\u6A58\u6A59", hex: "#E8752A" },
      { name: "\u67F3\u6A59\u6C41\u6A58", hex: "#F28C28" },
      { name: "\u9999\u74DC\u6A59", hex: "#F2A65A" },
      { name: "\u67D4\u548C\u6843", hex: "#F5CBA7" },
      // 黄/金
      { name: "\u82A6\u82C7\u9EC4", hex: "#D9C97A" },
      { name: "\u900F\u660E\u9EC4", hex: "#F5E663" },
      { name: "\u9E45\u9EC4", hex: "#F2D16B" },
      { name: "\u59DC\u9EC4", hex: "#D9A441" },
      { name: "\u91D1\u9EA6\u9EC4", hex: "#D9B24A" },
      { name: "\u7425\u73C0\u9EC4", hex: "#D99400" },
      { name: "\u91D1\u68D5\u6988\u8272", hex: "#C9A227" },
      { name: "\u91D1\u5408\u6B22", hex: "#C77F2F" },
      { name: "\u9999\u69DF\u91D1", hex: "#D4C5A0" },
      // 棕/赭
      { name: "\u8D64\u8910\u8D6D", hex: "#8C4A2F" },
      { name: "\u6817\u8D64\u8272", hex: "#7A3B2E" },
      { name: "\u7EA2\u68D5\u8272", hex: "#8B3A2A" },
      { name: "\u62FF\u94C1\u68D5", hex: "#9C7A5B" },
      { name: "\u8DEF\u6613\u5A01\u767B\u68D5", hex: "#4E3424" },
      { name: "\u51E1\u6234\u514B\u68D5", hex: "#3D2B1F" },
      { name: "\u6DF1\u7119\u68D5", hex: "#4A2E1E" },
      { name: "\u5DE7\u514B\u529B\u8272", hex: "#5C3A24" },
      { name: "\u7194\u5CA9\u70DF\u96FE", hex: "#7A6E6A" }
    ]
  },
  {
    id: "cool",
    label: "\u51B7\u8272\u7CFB",
    swatches: [
      // 绿
      { name: "\u7FE0\u7389\u7EFF", hex: "#2E8B6E" },
      { name: "\u58A8\u7EFF", hex: "#1F3D2B" },
      { name: "\u6DF1\u82D4\u7EFF", hex: "#3B4A2F" },
      { name: "\u6DF1\u6A44\u6984\u7EFF", hex: "#4A5423" },
      { name: "\u6A44\u6984\u7EFF", hex: "#6B7C4A" },
      { name: "\u83B3\u841D\u7EFF", hex: "#6E7F4E" },
      { name: "\u8C5A\u8349\u7EFF", hex: "#8A9A4B" },
      { name: "\u8584\u8377\u7EFF", hex: "#98D8C8" },
      // 蓝
      { name: "\u8482\u8299\u5C3C\u84DD", hex: "#81D8D0" },
      { name: "\u6D77\u6EE8\u84DD", hex: "#4FA3C2" },
      { name: "\u5361\u5E03\u91CC\u84DD", hex: "#3579A8" },
      { name: "\u8FDC\u5C71\u84DD", hex: "#7B9BB8" },
      { name: "\u96FE\u973E\u84DD", hex: "#8FA8BF" },
      { name: "\u725B\u4ED4\u84DD", hex: "#3B5B7C" },
      { name: "\u85CF\u9752", hex: "#1B2A4A" },
      { name: "\u7FA4\u9752", hex: "#4166B0" },
      { name: "\u514B\u83B1\u56E0\u84DD", hex: "#002FA7" },
      { name: "\u7075\u6C14\u975B\u84DD", hex: "#3F4E8C" },
      // 紫
      { name: "\u82CB\u83DC\u7D2B", hex: "#9B2D5F" },
      { name: "\u7D2B\u7F57\u5170\u8272", hex: "#7F5AA2" },
      { name: "\u85B0\u8863\u8349\u7D2B", hex: "#B4A7D6" },
      { name: "\u9999\u828B\u7D2B", hex: "#B8A9C9" },
      { name: "\u70DF\u718F\u7D2B", hex: "#6E5A72" },
      { name: "\u6DF1\u7D2B", hex: "#4A3B5C" },
      { name: "\u94F6\u7070", hex: "#C0C0C0" }
    ]
  }
];
var COLOR_PRESETS = COLOR_CATEGORIES.flatMap((c) => c.swatches);
function nameOfColor(hex) {
  return COLOR_PRESETS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
}
function buildRecolorPrompt(colors) {
  const list = colors.map((hex) => `${nameOfColor(hex)}(${hex})`).join("\u3001");
  return `\u4FDD\u6301\u670D\u88C5\u7684\u7248\u578B\u3001\u6B3E\u5F0F\u7EC6\u8282\u3001\u6784\u56FE\u548C\u5149\u7EBF\u5B8C\u5168\u4E0D\u53D8\uFF0C\u4EC5\u5C06\u9762\u6599\u914D\u8272\u66FF\u6362\u4E3A\uFF1A${list}\u3002\u914D\u8272\u5E94\u7528\u4E8E\u9762\u6599\u4E3B\u4F53\uFF0C\u5448\u73B0\u771F\u5B9E\u9762\u6599\u8D28\u611F\u4E0E\u51C6\u786E\u8272\u5F69\uFF0C\u65E0\u6587\u5B57\u65E0\u6C34\u5370\u3002`;
}

// server/engine/runner.ts
var DEFAULT_PROMPTS = {
  "sketch-to-render": "\u5C06\u7EBF\u7A3F\u6E32\u67D3\u4E3A\u5199\u5B9E\u670D\u88C5\u6548\u679C\u56FE\uFF0C\u4FDD\u6301\u7ED3\u6784\u4E0E\u8F6E\u5ED3\uFF0C\u9AD8\u7AEF\u65F6\u88C5\u6444\u5F71\u8D28\u611F",
  "ai-modify": "\u5728\u4FDD\u6301\u6574\u4F53\u7248\u578B\u4E0D\u53D8\u7684\u524D\u63D0\u4E0B\uFF0C\u4F18\u5316\u670D\u88C5\u7EC6\u8282\u8BBE\u8BA1",
  "fabric-recolor": "\u4FDD\u6301\u670D\u88C5\u6B3E\u5F0F\u3001\u7EC6\u8282\u3001\u5149\u5F71\u4E0E\u80CC\u666F\u4E0D\u53D8\uFF0C\u4EC5\u66FF\u6362\u9762\u6599\u8D28\u611F"
};
var runs = /* @__PURE__ */ new Map();
var MAX_FINISHED_RUNS = 50;
var FINISHED_RUN_TTL_MS = 30 * 60 * 1e3;
function pruneRuns() {
  const now = Date.now();
  const finished = [];
  for (const run of runs.values()) {
    if (!run.finished) continue;
    if (run.emitter.listenerCount("event") > 0) continue;
    if (now - run.createdAt > FINISHED_RUN_TTL_MS) {
      runs.delete(run.id);
    } else {
      finished.push(run);
    }
  }
  if (finished.length > MAX_FINISHED_RUNS) {
    finished.sort((a, b) => a.createdAt - b.createdAt);
    for (const run of finished.slice(0, finished.length - MAX_FINISHED_RUNS)) {
      runs.delete(run.id);
    }
  }
}
function getRun(id) {
  return runs.get(id);
}
async function createRun(plan, recordContext) {
  pruneRuns();
  const run = {
    id: nanoid5(10),
    plan,
    emitter: new EventEmitter(),
    events: [],
    finished: false,
    createdAt: Date.now(),
    recordContext
  };
  run.emitter.setMaxListeners(50);
  runs.set(run.id, run);
  if (recordContext) await createGenerationRecord(run.id, recordContext, run.createdAt);
  setImmediate(() => {
    executeRun(run).catch(async (err) => {
      if (run.recordContext) await failGenerationRecord(run.id, err instanceof Error ? err.message : String(err), Date.now());
      emit(run, { type: "run-error", error: err instanceof Error ? err.message : String(err) });
    });
  });
  return run;
}
function emit(run, event) {
  const sequenced = { ...event, seq: run.events.length + 1 };
  run.events.push(sequenced);
  run.emitter.emit("event", sequenced);
  if (sequenced.type === "done" || sequenced.type === "run-error") {
    run.finished = true;
    run.emitter.emit("finish");
  }
}
async function executeRun(run) {
  const outputs = /* @__PURE__ */ new Map();
  for (const step of run.plan.steps) {
    const inputImages = (step.upstream ?? []).flatMap(
      (u) => outputs.get(u.nodeId) ?? u.images
    );
    if (NODE_SPECS[step.kind].providerId && inputImages.length > MAX_REFERENCE_IMAGES) {
      const message = `Node ${step.nodeId} accepts at most ${MAX_REFERENCE_IMAGES} reference images`;
      const finishedAt = Date.now();
      emit(run, { type: "node-status", nodeId: step.nodeId, status: "error", error: message, finishedAt });
      emit(run, { type: "run-error", nodeId: step.nodeId, error: message, finishedAt });
      return;
    }
    if (NODE_SPECS[step.kind].providerId && step.kind !== "sketch-to-render" && inputImages.length === 0) {
      const message = `Node ${step.nodeId} requires an upstream image`;
      const finishedAt = Date.now();
      emit(run, {
        type: "node-status",
        nodeId: step.nodeId,
        status: "error",
        error: message,
        finishedAt
      });
      emit(run, { type: "run-error", nodeId: step.nodeId, error: message, finishedAt });
      return;
    }
    const startedAt = Date.now();
    if (run.recordContext?.nodeId === step.nodeId) await markGenerationRunning(run.id, startedAt);
    emit(run, { type: "node-status", nodeId: step.nodeId, status: "running", startedAt });
    try {
      const result = await executeStep(step, inputImages);
      const persisted = await persistOutputImages(result.images);
      if (run.recordContext) {
        await registerGeneratedFiles(run.recordContext, run.id, step.nodeId, persisted, Date.now());
      }
      outputs.set(step.nodeId, persisted);
      const finishedAt = Date.now();
      if (run.recordContext?.nodeId === step.nodeId) {
        await completeGenerationRecord({
          runId: run.id,
          images: persisted,
          prompts: result.prompts,
          failures: result.failures,
          model: result.model,
          providerRequests: result.providerRequests,
          startedAt,
          finishedAt
        });
      }
      const partialWarning = result.failures?.length ? `${result.failures.length} \u4E2A\u751F\u6210\u4EFB\u52A1\u5931\u8D25` : void 0;
      emit(run, {
        type: "node-status",
        nodeId: step.nodeId,
        status: "success",
        images: persisted,
        error: partialWarning,
        model: result.model,
        prompts: result.prompts,
        failures: result.failures,
        startedAt,
        finishedAt
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const finishedAt = Date.now();
      if (run.recordContext?.nodeId === step.nodeId) await failGenerationRecord(run.id, message, finishedAt);
      emit(run, {
        type: "node-status",
        nodeId: step.nodeId,
        status: "error",
        error: message,
        startedAt,
        finishedAt
      });
      emit(run, { type: "run-error", nodeId: step.nodeId, error: message, finishedAt });
      return;
    }
  }
  emit(run, { type: "done" });
}
async function persistOutputImages(images) {
  return Promise.all(images.map((img) => persistImageRef(img)));
}
async function executeStep(step, inputImages) {
  switch (step.kind) {
    case "image-input": {
      const imageUrl = step.params.imageUrl;
      return { images: imageUrl ? [imageUrl] : [], providerRequests: 0 };
    }
    case "result": {
      return { images: inputImages, providerRequests: 0 };
    }
    case "sketch-to-render":
    case "ai-modify":
    case "fabric-recolor":
    case "upscale":
    case "print-extract":
    case "print-mutate": {
      const spec = NODE_SPECS[step.kind];
      const provider = getProvider(spec.providerId);
      const referenceImages = await resolveImageRefs(inputImages);
      const fabricImageUrl = step.params.fabricImageUrl;
      if (step.kind === "fabric-recolor" && fabricImageUrl) {
        referenceImages.push(...await resolveImageRefs([fabricImageUrl]));
      }
      if (referenceImages.length > MAX_REFERENCE_IMAGES) {
        throw new Error(`Node ${step.nodeId} accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
      }
      const extra = (step.params.prompt ?? "").trim();
      if (step.kind === "fabric-recolor") {
        const colors = Array.isArray(step.params.colors) ? step.params.colors.filter((value) => typeof value === "string") : [];
        if (colors.length > 0) {
          const images = [];
          const prompts = [];
          const failures = [];
          let model;
          let providerRequests = 0;
          for (const color of colors) {
            const prompt2 = buildRecolorPrompt([color]);
            try {
              const result2 = await generateExactImages(provider, { prompt: prompt2, referenceImages }, 1);
              providerRequests += result2.providerRequests;
              model = result2.model;
              for (const image of result2.images) {
                images.push(image);
                prompts.push(prompt2);
              }
            } catch (err) {
              failures.push({
                prompt: prompt2,
                error: err instanceof Error ? err.message : String(err)
              });
            }
          }
          if (images.length === 0) {
            throw new Error(failures[0]?.error ?? "\u5168\u90E8\u914D\u8272\u751F\u6210\u5931\u8D25");
          }
          return { images, prompts, model, providerRequests, failures: failures.length ? failures : void 0 };
        }
      }
      if (step.kind === "print-mutate") {
        const count = Math.max(1, Math.min(8, Number(step.params.count) || 4));
        const prompt2 = "\u57FA\u4E8E\u8FD9\u5F20\u5370\u82B1\u56FE\u6848\u751F\u6210\u98CE\u683C\u4E00\u81F4\u7684\u65B0\u53D8\u4F53\uFF1A\u4FDD\u6301\u539F\u6709\u914D\u8272\u4F53\u7CFB\u3001\u827A\u672F\u98CE\u683C\u4E0E\u7B14\u89E6\u8D28\u611F\uFF0C\u91CD\u65B0\u7F16\u6392\u5143\u7D20\u7684\u6784\u56FE\u4E0E\u7EC4\u5408\u65B9\u5F0F\uFF0C\u7EAF\u767D\u80CC\u666F\uFF0C\u9002\u5408\u4F5C\u4E3A\u5370\u82B1\u7D20\u6750\u590D\u7528" + (extra ? `\u3002\u8865\u5145\u8981\u6C42\uFF1A${extra}` : "");
        const result2 = await generateExactImages(provider, { prompt: prompt2, referenceImages }, count);
        const failures = result2.failures.map((error) => ({ prompt: prompt2, error }));
        return {
          images: result2.images,
          prompts: result2.images.map(() => prompt2),
          model: result2.model,
          providerRequests: result2.providerRequests,
          failures: failures.length ? failures : void 0
        };
      }
      const prompt = step.kind === "upscale" ? "\u5C06\u8FD9\u5F20\u670D\u88C5\u6548\u679C\u56FE\u653E\u5927\u4E3A\u8D85\u9AD8\u6E05\u7248\u672C\uFF0C\u589E\u5F3A\u9762\u6599\u7EB9\u7406\u3001\u8D70\u7EBF\u4E0E\u8FB9\u7F18\u7EC6\u8282\uFF0C\u4FDD\u6301\u539F\u6709\u6784\u56FE\u3001\u8272\u5F69\u548C\u5149\u5F71\u5B8C\u5168\u4E0D\u53D8" : step.kind === "print-extract" ? "\u63D0\u53D6\u8FD9\u4EF6\u8863\u670D\u4E0A\u7684\u5370\u82B1\u56FE\u6848\uFF1A\u5C06\u5370\u82B1\u5B8C\u6574\u62A0\u51FA\u5E76\u5E73\u94FA\u5C55\u5F00\u4E3A\u89C4\u6574\u7684\u77E9\u5F62\u56FE\u6848\uFF0C\u7EAF\u767D\u80CC\u666F\uFF0C\u53BB\u9664\u8863\u8EAB\u3001\u8936\u76B1\u3001\u9634\u5F71\u548C\u7A7F\u7740\u6548\u679C\uFF0C\u5370\u82B1\u7684\u6BD4\u4F8B\u3001\u7EC6\u8282\u548C\u8272\u5F69\u4E0E\u539F\u56FE\u4FDD\u6301\u4E00\u81F4\uFF0C\u9002\u5408\u4F5C\u4E3A\u5370\u82B1\u7D20\u6750\u590D\u7528" + (extra ? `\u3002\u8865\u5145\u8981\u6C42\uFF1A${extra}` : "") : extra || DEFAULT_PROMPTS[step.kind] || NODE_SPECS[step.kind].description;
      const request = {
        prompt,
        referenceImages: referenceImages.length ? referenceImages : void 0,
        aspectRatio: step.params.aspectRatio,
        batchSize: step.params.batchSize,
        imageSize: step.kind === "upscale" ? step.params.imageSize : void 0
      };
      const requestedCount = step.kind === "sketch-to-render" || step.kind === "ai-modify" ? Math.max(1, Math.min(4, Number(step.params.batchSize) || 1)) : 1;
      const result = await generateExactImages(provider, request, requestedCount);
      return {
        images: result.images,
        model: result.model,
        prompts: result.images.map(() => prompt),
        providerRequests: result.providerRequests,
        failures: result.failures.length ? result.failures.map((error) => ({ prompt, error })) : void 0
      };
    }
  }
}
async function resolveImageRefs(refs) {
  return Promise.all(refs.map(normalizeImageRef));
}

// server/lib/workflowSchema.ts
var NODE_KINDS = [
  "image-input",
  "sketch-to-render",
  "ai-modify",
  "fabric-recolor",
  "upscale",
  "print-extract",
  "print-mutate",
  "result"
];
var STATUSES = ["idle", "queued", "running", "success", "error"];
var IMAGE_ROLES = ["default", "sketch", "garment", "fabric", "reference"];
var ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"];
var BATCH_SIZES = [1, 2, 4];
var IMAGE_SIZES = ["2K", "4K"];
var MAX_NODES = 500;
var MAX_EDGES = 2e3;
var MAX_TEXT_LENGTH = 2e4;
var MAX_IMAGE_REFS = 100;
var SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var WorkflowValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowValidationError";
  }
};
function fail(path9, message) {
  throw new WorkflowValidationError(`${path9}: ${message}`);
}
function record(value, path9) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path9, "must be an object");
  }
  return value;
}
function stringValue(value, path9, opts) {
  if (typeof value !== "string") fail(path9, "must be a string");
  if (opts?.nonEmpty && value.trim().length === 0) fail(path9, "must not be empty");
  if (value.length > MAX_TEXT_LENGTH) fail(path9, `must be at most ${MAX_TEXT_LENGTH} characters`);
  return value;
}
function optionalString(value, path9) {
  return value === void 0 ? void 0 : stringValue(value, path9);
}
function imageReference(value, path9) {
  const ref = stringValue(value, path9, { nonEmpty: true });
  if (ref.startsWith("data:")) {
    try {
      validateImageDataUrl(ref);
    } catch (error) {
      fail(path9, error instanceof Error ? error.message : "invalid image dataURL");
    }
    return ref;
  }
  const isRemote = /^https?:\/\//i.test(ref);
  if (!isLocalImageReference(ref) && !isRemote) {
    fail(path9, "must be an image dataURL, local /api/files reference, or http(s) URL");
  }
  return ref;
}
function optionalImageReference(value, path9) {
  return value === void 0 ? void 0 : imageReference(value, path9);
}
function finiteNumber(value, path9) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path9, "must be a finite number");
  return value;
}
function oneOf(value, allowed, path9) {
  if (!allowed.includes(value)) fail(path9, `must be one of: ${allowed.join(", ")}`);
  return value;
}
function stringArray(value, path9, max = MAX_IMAGE_REFS) {
  if (!Array.isArray(value)) fail(path9, "must be an array");
  if (value.length > max) fail(path9, `must contain at most ${max} items`);
  return value.map((item, index) => stringValue(item, `${path9}[${index}]`, { nonEmpty: true }));
}
function imageReferenceArray(value, path9, max = MAX_IMAGE_REFS) {
  if (!Array.isArray(value)) fail(path9, "must be an array");
  if (value.length > max) fail(path9, `must contain at most ${max} items`);
  return value.map((item, index) => imageReference(item, `${path9}[${index}]`));
}
function migrateNodeData(kind, raw) {
  switch (kind) {
    case "image-input":
      return { imageRole: "default", ...raw };
    case "sketch-to-render":
      return { prompt: "", aspectRatio: "3:4", batchSize: 1, outputImages: [], ...raw };
    case "ai-modify":
      return { prompt: "", aspectRatio: "1:1", batchSize: 1, outputImages: [], ...raw };
    case "fabric-recolor":
      return { colors: [], prompt: "", outputImages: [], ...raw };
    case "upscale":
      return { imageSize: "2K", outputImages: [], ...raw };
    case "print-extract":
      return { prompt: "", outputImages: [], savedAsAssets: [], ...raw };
    case "print-mutate":
      return { prompt: "", count: 4, outputImages: [], ...raw };
    case "result":
      return { images: [], ...raw };
  }
}
function validateData(kind, rawValue, path9) {
  const input = record(rawValue, path9);
  const runtimeStatus = input.status;
  const raw = runtimeStatus === "queued" || runtimeStatus === "running" || runtimeStatus === "error" ? { ...input, status: "idle", error: void 0 } : input;
  if (raw.kind !== kind) fail(`${path9}.kind`, `must equal node type ${kind}`);
  stringValue(raw.label, `${path9}.label`, { nonEmpty: true });
  oneOf(raw.status, STATUSES, `${path9}.status`);
  optionalString(raw.error, `${path9}.error`);
  switch (kind) {
    case "image-input":
      oneOf(raw.imageRole, IMAGE_ROLES, `${path9}.imageRole`);
      optionalImageReference(raw.imageUrl, `${path9}.imageUrl`);
      break;
    case "sketch-to-render":
    case "ai-modify":
      stringValue(raw.prompt, `${path9}.prompt`);
      oneOf(raw.aspectRatio, ASPECT_RATIOS, `${path9}.aspectRatio`);
      oneOf(raw.batchSize, BATCH_SIZES, `${path9}.batchSize`);
      imageReferenceArray(raw.outputImages, `${path9}.outputImages`);
      break;
    case "fabric-recolor": {
      const colors = stringArray(raw.colors, `${path9}.colors`, 8);
      for (let i = 0; i < colors.length; i++) {
        if (!/^#[0-9a-fA-F]{6}$/.test(colors[i])) fail(`${path9}.colors[${i}]`, "must be #RRGGBB");
      }
      stringValue(raw.prompt, `${path9}.prompt`);
      optionalImageReference(raw.fabricImageUrl, `${path9}.fabricImageUrl`);
      imageReferenceArray(raw.outputImages, `${path9}.outputImages`);
      break;
    }
    case "upscale":
      oneOf(raw.imageSize, IMAGE_SIZES, `${path9}.imageSize`);
      imageReferenceArray(raw.outputImages, `${path9}.outputImages`);
      break;
    case "print-extract":
      stringValue(raw.prompt, `${path9}.prompt`);
      imageReferenceArray(raw.outputImages, `${path9}.outputImages`);
      imageReferenceArray(raw.savedAsAssets, `${path9}.savedAsAssets`);
      break;
    case "print-mutate":
      stringValue(raw.prompt, `${path9}.prompt`);
      if (!Number.isInteger(raw.count) || raw.count < 1 || raw.count > 8) {
        fail(`${path9}.count`, "must be an integer from 1 to 8");
      }
      imageReferenceArray(raw.outputImages, `${path9}.outputImages`);
      break;
    case "result":
      imageReferenceArray(raw.images, `${path9}.images`);
      optionalString(raw.note, `${path9}.note`);
      break;
  }
  return raw;
}
function validateNode(value, index, migrateLegacy) {
  const path9 = `flow.nodes[${index}]`;
  const raw = record(value, path9);
  const id = stringValue(raw.id, `${path9}.id`, { nonEmpty: true });
  if (!SAFE_ID.test(id)) fail(`${path9}.id`, "must contain only letters, digits, underscore or hyphen");
  const type = oneOf(raw.type, NODE_KINDS, `${path9}.type`);
  const position = record(raw.position, `${path9}.position`);
  finiteNumber(position.x, `${path9}.position.x`);
  finiteNumber(position.y, `${path9}.position.y`);
  const initialData = record(raw.data, `${path9}.data`);
  const data = validateData(
    type,
    migrateLegacy ? migrateNodeData(type, initialData) : initialData,
    `${path9}.data`
  );
  return { ...raw, id, type, position: { ...position, x: position.x, y: position.y }, data };
}
function validateEdge(value, index) {
  const path9 = `flow.edges[${index}]`;
  const raw = record(value, path9);
  const id = stringValue(raw.id, `${path9}.id`, { nonEmpty: true });
  const source = stringValue(raw.source, `${path9}.source`, { nonEmpty: true });
  const target = stringValue(raw.target, `${path9}.target`, { nonEmpty: true });
  if (!SAFE_ID.test(id)) fail(`${path9}.id`, "must contain only letters, digits, underscore or hyphen");
  if (!SAFE_ID.test(source)) fail(`${path9}.source`, "must be a valid node id");
  if (!SAFE_ID.test(target)) fail(`${path9}.target`, "must be a valid node id");
  if (raw.sourceHandle !== void 0 && raw.sourceHandle !== null) stringValue(raw.sourceHandle, `${path9}.sourceHandle`);
  if (raw.targetHandle !== void 0 && raw.targetHandle !== null) stringValue(raw.targetHandle, `${path9}.targetHandle`);
  return { ...raw, id, source, target };
}
function validateAndMigrateFlow(value) {
  const raw = record(value, "flow");
  const version = raw.schemaVersion;
  const migrateLegacy = version === void 0 || version === 0;
  if (!migrateLegacy && version !== WORKFLOW_SCHEMA_VERSION) {
    fail("flow.schemaVersion", `unsupported version ${String(version)}; current version is ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.nodes)) fail("flow.nodes", "must be an array");
  if (!Array.isArray(raw.edges)) fail("flow.edges", "must be an array");
  if (raw.nodes.length > MAX_NODES) fail("flow.nodes", `must contain at most ${MAX_NODES} nodes`);
  if (raw.edges.length > MAX_EDGES) fail("flow.edges", `must contain at most ${MAX_EDGES} edges`);
  const nodes = raw.nodes.map((node, index) => validateNode(node, index, migrateLegacy));
  const edges = raw.edges.map(validateEdge);
  const nodeIds = /* @__PURE__ */ new Set();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail("flow.nodes", `duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = /* @__PURE__ */ new Set();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) fail("flow.edges", `duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) fail("flow.edges", `edge ${edge.id} source not found: ${edge.source}`);
    if (!nodeIds.has(edge.target)) fail("flow.edges", `edge ${edge.id} target not found: ${edge.target}`);
  }
  for (const node of nodes) {
    const incomingCount = edges.filter((edge) => edge.target === node.id).length;
    if (incomingCount > NODE_SPECS[node.type].inputs) {
      fail(
        "flow.edges",
        `node ${node.id} accepts at most ${NODE_SPECS[node.type].inputs} incoming image connections`
      );
    }
    if (NODE_SPECS[node.type].providerId && incomingCount > MAX_REFERENCE_IMAGES) {
      fail("flow.edges", `node ${node.id} accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
    }
  }
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges };
}

// server/lib/asyncHandler.ts
function asyncHandler(handler) {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

// server/routes/runPlan.ts
var runPlanRouter = Router2();
runPlanRouter.post("/", asyncHandler(async (req, res) => {
  const { nodes, edges, onlyNodeId, includeDownstream, projectId, projectName } = req.body;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    res.status(400).json({ error: "nodes and edges arrays are required" });
    return;
  }
  if (onlyNodeId !== void 0 && (typeof onlyNodeId !== "string" || !onlyNodeId.trim())) {
    res.status(400).json({ error: "onlyNodeId must be a non-empty string" });
    return;
  }
  if (includeDownstream !== void 0 && typeof includeDownstream !== "boolean") {
    res.status(400).json({ error: "includeDownstream must be a boolean" });
    return;
  }
  try {
    const flow = validateAndMigrateFlow({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes,
      edges
    });
    const plan = buildExecutionPlan(flow.nodes, flow.edges, {
      onlyNodeId,
      // 点击单节点默认只执行自己，避免无意触发整条下游产生额外费用。
      includeDownstream: includeDownstream ?? false
    });
    if (plan.steps.length === 0) {
      res.status(400).json({ error: "workflow contains no executable nodes" });
      return;
    }
    assertPlanInputs(plan, flow.edges);
    const targetStep = plan.steps.find((step) => step.nodeId === onlyNodeId) ?? plan.steps[plan.steps.length - 1];
    const targetNode = flow.nodes.find((node) => node.id === targetStep.nodeId);
    const params = targetStep.params;
    const requestedCount = targetStep.kind === "fabric-recolor" ? Math.max(1, Array.isArray(params.colors) ? params.colors.length : 1) : targetStep.kind === "print-mutate" ? Math.max(1, Math.min(8, Number(params.count) || 1)) : targetStep.kind === "sketch-to-render" || targetStep.kind === "ai-modify" ? Math.max(1, Math.min(4, Number(params.batchSize) || 1)) : 1;
    const user = requestUser(req);
    if (typeof projectId === "string") {
      const project = await queryOne(
        "SELECT owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL",
        [projectId]
      );
      if (project && project.owner_id !== user.id) {
        res.status(403).json({ error: "\u7BA1\u7406\u5458\u53EA\u80FD\u67E5\u770B\u5176\u4ED6\u7528\u6237\u9879\u76EE\uFF0C\u4E0D\u80FD\u8FD0\u884C\u6216\u4FEE\u6539" });
        return;
      }
    }
    const run = await createRun(plan, {
      userId: user.id,
      projectId: typeof projectId === "string" ? projectId : void 0,
      projectName: typeof projectName === "string" ? projectName : void 0,
      nodeId: targetStep.nodeId,
      nodeLabel: targetNode?.data.label ?? targetStep.kind,
      kind: targetStep.kind,
      prompt: typeof params.prompt === "string" ? params.prompt : void 0,
      parameters: params,
      referenceImages: targetStep.inputImages,
      requestedCount
    });
    res.json({ runId: run.id });
  } catch (err) {
    if (err instanceof DagError || err instanceof WorkflowValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}));
runPlanRouter.get("/:id/events", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 3000\n\n");
  const send = (event) => {
    if (event.seq !== void 0) res.write(`id: ${event.seq}
`);
    res.write(`data: ${JSON.stringify(event)}

`);
  };
  const lastEventId = Number(req.get("Last-Event-ID") ?? 0);
  const cursor = Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;
  for (const event of run.events) {
    if ((event.seq ?? 0) > cursor) send(event);
  }
  if (run.finished) {
    res.end();
    return;
  }
  run.emitter.on("event", send);
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15e3);
  const close = () => {
    clearInterval(heartbeat);
    run.emitter.off("event", send);
    res.end();
  };
  run.emitter.once("finish", close);
  req.on("close", () => {
    clearInterval(heartbeat);
    run.emitter.off("event", send);
    run.emitter.off("finish", close);
  });
});
runPlanRouter.get("/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({ runId: run.id, finished: run.finished });
});

// server/routes/files.ts
import { Router as Router3 } from "express";
import fs4 from "node:fs";
import path4 from "node:path";
var filesRouter = Router3();
filesRouter.post("/", asyncHandler(async (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl) {
    res.status(400).json({ error: "dataUrl is required" });
    return;
  }
  try {
    const saved = saveDataUrl(dataUrl);
    await query(`
      INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, $2, 'upload', $3)
    `, [saved.id, requestUser(req).id, (/* @__PURE__ */ new Date()).toISOString()]);
    res.json(saved);
  } catch (err) {
    if (err instanceof ProviderError || err instanceof ImageValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}));
filesRouter.get("/:id", asyncHandler(async (req, res) => {
  const id = path4.basename(req.params.id);
  if (id !== req.params.id || !isSupportedImageFile(id)) {
    res.status(400).json({ error: "invalid file id" });
    return;
  }
  const filePath = path4.join(uploadsDir(), id);
  if (!fs4.existsSync(filePath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  const user = requestUser(req);
  const access = await queryOne(`
    SELECT f.owner_id,
      EXISTS(SELECT 1 FROM assets a WHERE a.image = $1 AND a.deleted_at IS NULL AND a.scope IN ('global','shared')) AS shared
    FROM files f WHERE f.id = $2
  `, [`/api/files/${id}`, id]);
  if (access && access.owner_id !== null && access.owner_id !== user.id && user.role !== "admin" && !access.shared) {
    res.status(403).json({ error: "\u65E0\u6743\u8BBF\u95EE\u6B64\u6587\u4EF6" });
    return;
  }
  res.setHeader("Content-Type", mimeOfFile(id));
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs4.createReadStream(filePath).pipe(res);
}));

// server/routes/projects.ts
import { Router as Router4 } from "express";
import { nanoid as nanoid6 } from "nanoid";
var projectsRouter = Router4();
function imageRefs(value, output = /* @__PURE__ */ new Set()) {
  if (typeof value === "string" && value.startsWith("/api/files/")) output.add(value);
  else if (Array.isArray(value)) value.forEach((item) => imageRefs(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => imageRefs(item, output));
  return output;
}
async function syncAssetRefs(projectId, flow) {
  const refs = imageRefs(flow);
  const assets = await query("SELECT id, image FROM assets WHERE deleted_at IS NULL");
  const wanted = assets.filter((asset) => refs.has(asset.image)).map((asset) => asset.id);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await transaction(async (client) => {
    await client.query("DELETE FROM project_asset_refs WHERE project_id = $1", [projectId]);
    for (const assetId of wanted) {
      await client.query(
        "INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES ($1, $2, $3)",
        [projectId, assetId, now]
      );
    }
  });
}
async function purgeExpiredProjects() {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await transaction(async (client) => {
    await client.query(`
      DELETE FROM project_asset_refs
      WHERE project_id IN (SELECT id FROM projects WHERE purge_after IS NOT NULL AND purge_after <= $1)
    `, [now]);
    await client.query("DELETE FROM projects WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
  });
}
projectsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { id, name, flow } = req.body;
  if (typeof name !== "string" || !name.trim() || name.length > 200 || flow === void 0) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  if (id !== void 0 && (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    res.status(400).json({ error: "id must contain only letters, digits, underscore or hyphen" });
    return;
  }
  try {
    const normalized = validateAndMigrateFlow(flow);
    const projectId = id || nanoid6(10);
    const existing = await queryOne(
      "SELECT owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [projectId]
    );
    if (existing && existing.owner_id !== user.id) {
      res.status(403).json({ error: "\u7BA1\u7406\u5458\u53EA\u80FD\u67E5\u770B\u5176\u4ED6\u7528\u6237\u9879\u76EE\uFF0C\u4E0D\u80FD\u4FEE\u6539" });
      return;
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    await query(`
      INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $5)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, flow_json = excluded.flow_json, updated_at = excluded.updated_at
    `, [projectId, user.id, name.trim(), JSON.stringify(normalized), now]);
    await syncAssetRefs(projectId, normalized);
    res.json({ ok: true, id: projectId });
  } catch (error) {
    res.status(error instanceof WorkflowValidationError ? 400 : 500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));
projectsRouter.get("/", asyncHandler(async (req, res) => {
  await purgeExpiredProjects();
  const user = requestUser(req);
  const rows = await query(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.deleted_at IS NULL AND ($1 = 'admin' OR p.owner_id = $2)
    ORDER BY p.updated_at DESC
  `, [user.role, user.id]);
  res.json(rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    readOnly: row.owner_id !== user.id,
    updatedAt: row.updated_at
  })));
}));
projectsRouter.get("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.flow_json, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.id = $1 AND p.deleted_at IS NULL
  `, [req.params.id]);
  if (!row) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (row.owner_id !== user.id && user.role !== "admin") {
    res.status(403).json({ error: "\u65E0\u6743\u67E5\u770B\u6B64\u9879\u76EE" });
    return;
  }
  try {
    res.json({
      id: row.id,
      name: row.name,
      flow: JSON.parse(row.flow_json),
      updatedAt: row.updated_at,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      readOnly: row.owner_id !== user.id
    });
  } catch {
    res.status(422).json({ error: "\u9879\u76EE\u6570\u636E\u635F\u574F" });
  }
}));

// server/routes/templates.ts
import { Router as Router5 } from "express";
import fs6 from "node:fs";
import path6 from "node:path";
import { nanoid as nanoid8 } from "nanoid";

// server/lib/atomicJson.ts
import fs5 from "node:fs";
import path5 from "node:path";
import { nanoid as nanoid7 } from "nanoid";
function writeJsonAtomicSync(filePath, value) {
  const dir = path5.dirname(filePath);
  fs5.mkdirSync(dir, { recursive: true });
  const tempPath = path5.join(dir, `.${path5.basename(filePath)}.${process.pid}.${nanoid7(6)}.tmp`);
  try {
    const fd = fs5.openSync(tempPath, "wx", 384);
    try {
      fs5.writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`, "utf-8");
      fs5.fsyncSync(fd);
    } finally {
      fs5.closeSync(fd);
    }
    fs5.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs5.unlinkSync(tempPath);
    } catch {
    }
    throw error;
  }
}

// server/routes/templates.ts
var templatesRouter = Router5();
function templatesDir(sub) {
  const dir = path6.join(config.dataDir(), "templates", sub);
  fs6.mkdirSync(dir, { recursive: true });
  return dir;
}
function templatePath(sub, id) {
  return path6.join(templatesDir(sub), `${path6.basename(id)}.json`);
}
var BUILTIN_CREATED_AT = "2026-08-05T00:00:00.000Z";
function builtinTemplates() {
  return [
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-sketch-recolor",
      name: "\u8349\u56FE\u2192\u6548\u679C\u56FE\u2192\u6539\u6B3E\u2192\u591A\u914D\u8272",
      description: "\u4E0A\u4F20\u8349\u56FE\uFF0C\u6E32\u67D3\u6548\u679C\u56FE\u540E AI \u6539\u6B3E\uFF0C\u518D\u6309\u914D\u8272\u6279\u91CF\u51FA\u56FE",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "image-input",
            position: { x: 0, y: 0 },
            data: { kind: "image-input", label: "\u56FE\u7247\u4E0A\u4F20", status: "idle", imageRole: "sketch" }
          },
          {
            id: "n2",
            type: "sketch-to-render",
            position: { x: 380, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "\u8349\u56FE\u2192\u6548\u679C\u56FE",
              status: "idle",
              prompt: "",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "n3",
            type: "ai-modify",
            position: { x: 760, y: 0 },
            data: {
              kind: "ai-modify",
              label: "AI \u6539\u6B3E",
              status: "idle",
              prompt: "",
              aspectRatio: "1:1",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "n4",
            type: "fabric-recolor",
            position: { x: 1140, y: 0 },
            data: {
              kind: "fabric-recolor",
              label: "\u9762\u6599/\u914D\u8272\u66FF\u6362",
              status: "idle",
              colors: [],
              prompt: "",
              outputImages: []
            }
          }
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2" },
          { id: "e2", source: "n2", target: "n3" },
          { id: "e3", source: "n3", target: "n4", targetHandle: "garment" }
        ]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-sketch-upscale",
      name: "\u8349\u56FE\u2192\u6548\u679C\u56FE\u2192\u9AD8\u6E05\u653E\u5927",
      description: "\u4E0A\u4F20\u8349\u56FE\u6E32\u67D3\u6548\u679C\u56FE\uFF0C\u518D\u653E\u5927\u81F3 2K/4K \u7CBE\u4FEE\u7EC6\u8282",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "image-input",
            position: { x: 0, y: 0 },
            data: { kind: "image-input", label: "\u56FE\u7247\u4E0A\u4F20", status: "idle", imageRole: "sketch" }
          },
          {
            id: "n2",
            type: "sketch-to-render",
            position: { x: 380, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "\u8349\u56FE\u2192\u6548\u679C\u56FE",
              status: "idle",
              prompt: "",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "n3",
            type: "upscale",
            position: { x: 760, y: 0 },
            data: {
              kind: "upscale",
              label: "\u9AD8\u6E05\u653E\u5927",
              status: "idle",
              imageSize: "2K",
              outputImages: []
            }
          }
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2" },
          { id: "e2", source: "n2", target: "n3" }
        ]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-text-recolor",
      name: "\u6587\u751F\u6B3E\u5F0F\u2192\u591A\u914D\u8272",
      description: "\u7EAF\u63D0\u793A\u8BCD\u6587\u751F\u6B3E\u5F0F\u6548\u679C\u56FE\uFF0C\u518D\u6309\u914D\u8272\u6279\u91CF\u51FA\u56FE",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "sketch-to-render",
            position: { x: 0, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "\u8349\u56FE\u2192\u6548\u679C\u56FE",
              status: "idle",
              prompt: "\u8BBE\u8BA1\u4E00\u6B3E\u7B80\u7EA6\u901A\u52E4\u98CE\u5973\u88C5\u8FDE\u8863\u88D9\uFF0C\u6B63\u9762\u5168\u8EAB\u6548\u679C\u56FE\uFF0C\u6D45\u7070\u7EAF\u8272\u80CC\u666F",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "n2",
            type: "fabric-recolor",
            position: { x: 380, y: 0 },
            data: {
              kind: "fabric-recolor",
              label: "\u9762\u6599/\u914D\u8272\u66FF\u6362",
              status: "idle",
              colors: [],
              prompt: "",
              outputImages: []
            }
          }
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", targetHandle: "garment" }]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-text-to-image",
      name: "\u6587\u751F\u56FE\uFF08\u670D\u88C5\u8BBE\u8BA1\uFF09",
      description: "\u8F93\u5165\u6B3E\u5F0F\u3001\u9762\u6599\u3001\u8272\u5F69\u3001\u6A21\u7279\u3001\u573A\u666F\u4E0E\u6444\u5F71\u8981\u6C42\uFF0C\u76F4\u63A5\u751F\u6210\u670D\u88C5\u8BBE\u8BA1\u6548\u679C\u56FE",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "generate",
            type: "sketch-to-render",
            position: { x: 0, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "\u6587\u751F\u56FE",
              status: "idle",
              prompt: "\u8BBE\u8BA1\u4E00\u5957\u73B0\u4EE3\u90FD\u5E02\u5973\u88C5\uFF1A\u5ED3\u5F62\u5229\u843D\u7684\u77ED\u6B3E\u897F\u88C5\u642D\u914D\u9AD8\u8170\u9614\u817F\u957F\u88E4\uFF0C\u4F7F\u7528\u6709\u7EC6\u817B\u5782\u5760\u611F\u7684\u6DF1\u7070\u7F8A\u6BDB\u6DF7\u7EBA\u9762\u6599\uFF0C\u5C40\u90E8\u52A0\u5165\u54D1\u5149\u9ED1\u8272\u76AE\u9769\u6EDA\u8FB9\uFF1B\u5E74\u8F7B\u4E9A\u6D32\u5973\u6A21\u7279\u5168\u8EAB\u7AD9\u59FF\uFF0C\u6B63\u9762\u7565\u5FAE\u4FA7\u8EAB\uFF0C\u670D\u88C5\u7ED3\u6784\u3001\u9762\u6599\u7EB9\u7406\u548C\u7F1D\u7EBF\u7EC6\u8282\u6E05\u6670\uFF1B\u6781\u7B80\u6D45\u7070\u6444\u5F71\u68DA\u80CC\u666F\uFF0C\u67D4\u548C\u4FA7\u5149\uFF0C\u9AD8\u7EA7\u65F6\u88C5\u54C1\u724C Lookbook \u98CE\u683C\uFF0C\u5199\u5B9E\u6444\u5F71\uFF0C\u9AD8\u8D28\u611F\uFF0C\u753B\u9762\u5E72\u51C0\uFF0C\u65E0\u6587\u5B57\u3001\u65E0\u6C34\u5370\u3002",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "result",
            type: "result",
            position: { x: 430, y: 0 },
            data: {
              kind: "result",
              label: "\u751F\u6210\u7ED3\u679C",
              status: "idle",
              images: [],
              note: "\u53EF\u4FEE\u6539\u63D0\u793A\u8BCD\u3001\u753B\u5E45\u6BD4\u4F8B\u548C\u751F\u6210\u6570\u91CF\u540E\u91CD\u65B0\u751F\u6210"
            }
          }
        ],
        edges: [{ id: "generate-to-result", source: "generate", target: "result" }]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-person-scene-transfer",
      name: "\u4EBA\u7269\u573A\u666F\u8FC1\u79FB\uFF08\u4EBA\u7269\u2192\u80CC\u666F/\u5EA7\u6905\uFF09",
      description: "\u4E0A\u4F20\u56FE1\u4EBA\u7269\u4E0E\u56FE2\u573A\u666F\uFF0C\u5C06\u4EBA\u7269\u4FDD\u771F\u8FC1\u79FB\u5230\u573A\u666F\u4E2D\u5E76\u5339\u914D\u5EA7\u6905\u3001\u59FF\u6001\u3001\u5149\u5F71\u4E0E\u900F\u89C6",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "subject",
            type: "image-input",
            position: { x: 0, y: -170 },
            data: {
              kind: "image-input",
              label: "\u56FE1 \xB7 \u4EBA\u7269\u4E3B\u4F53",
              status: "idle",
              imageRole: "garment"
            }
          },
          {
            id: "scene",
            type: "image-input",
            position: { x: 0, y: 190 },
            data: {
              kind: "image-input",
              label: "\u56FE2 \xB7 \u573A\u666F\u80CC\u666F",
              status: "idle",
              imageRole: "reference"
            }
          },
          {
            id: "transfer",
            type: "ai-modify",
            position: { x: 430, y: 0 },
            data: {
              kind: "ai-modify",
              label: "\u4EBA\u7269\u573A\u666F\u8FC1\u79FB",
              status: "idle",
              prompt: "\u4E25\u683C\u6309\u7167\u8F93\u5165\u987A\u5E8F\u5904\u7406\uFF1A\u56FE1\u662F\u9700\u8981\u4FDD\u7559\u7684\u4EBA\u7269\u4E3B\u4F53\uFF0C\u56FE2\u662F\u76EE\u6807\u573A\u666F\u3002\u5C06\u56FE1\u4E2D\u7684\u540C\u4E00\u4EBA\u7269\u5B8C\u6574\u8FC1\u79FB\u5230\u56FE2\u7684\u80CC\u666F\u4E2D\uFF0C\u5E76\u8BA9\u4EBA\u7269\u81EA\u7136\u5750\u5728\u56FE2\u7684\u6905\u5B50\u4E0A\u3002\u4FDD\u6301\u56FE1\u4EBA\u7269\u7684\u8138\u90E8\u8EAB\u4EFD\u3001\u53D1\u578B\u3001\u4F53\u578B\u3001\u670D\u88C5\u6B3E\u5F0F\u3001\u989C\u8272\u4E0E\u6750\u8D28\u7EC6\u8282\u4E0D\u53D8\uFF1B\u4FDD\u6301\u56FE2\u7684\u80CC\u666F\u3001\u6905\u5B50\u3001\u6784\u56FE\u4E0E\u7A7A\u95F4\u9648\u8BBE\u4E0D\u53D8\u3002\u6839\u636E\u6905\u5B50\u7684\u671D\u5411\u548C\u9AD8\u5EA6\u8C03\u6574\u4EBA\u7269\u5750\u59FF\u3001\u80A2\u4F53\u906E\u6321\u3001\u6BD4\u4F8B\u4E0E\u900F\u89C6\uFF0C\u4F7F\u8EAB\u4F53\u4E0E\u6905\u9762\u6B63\u786E\u63A5\u89E6\uFF0C\u8865\u5145\u81EA\u7136\u7684\u63A5\u89E6\u9634\u5F71\uFF0C\u5E76\u7EDF\u4E00\u5149\u7EBF\u65B9\u5411\u3001\u8272\u6E29\u3001\u666F\u6DF1\u4E0E\u753B\u9762\u8D28\u611F\u3002\u4E0D\u8981\u590D\u5236\u56FE2\u4E2D\u7684\u4EBA\u7269\uFF0C\u4E0D\u8981\u6539\u53D8\u4EBA\u7269\u8EAB\u4EFD\uFF0C\u4E0D\u8981\u65B0\u589E\u591A\u4F59\u4EBA\u7269\u6216\u5BB6\u5177\u3002\u8F93\u51FA\u4E00\u5F20\u771F\u5B9E\u3001\u81EA\u7136\u3001\u65E0\u62FC\u8D34\u75D5\u8FF9\u7684\u5B8C\u6574\u56FE\u7247\u3002",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "result",
            type: "result",
            position: { x: 860, y: 0 },
            data: {
              kind: "result",
              label: "\u8FC1\u79FB\u7ED3\u679C",
              status: "idle",
              images: [],
              note: "\u4EBA\u7269\u6765\u81EA\u56FE1\uFF0C\u573A\u666F\u4E0E\u6905\u5B50\u6765\u81EA\u56FE2"
            }
          }
        ],
        edges: [
          { id: "subject-to-transfer", source: "subject", target: "transfer" },
          { id: "scene-to-transfer", source: "scene", target: "transfer" },
          { id: "transfer-to-result", source: "transfer", target: "result" }
        ]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-pattern-style-transfer",
      name: "\u56FE\u6848\u98CE\u683C\u8FC1\u79FB\uFF08\u56FE\u6848\u2192\u53C2\u8003\u98CE\u683C\uFF09",
      description: "\u4FDD\u7559\u56FE1\u7684\u4E3B\u9898\u4E0E\u6784\u56FE\uFF0C\u4F7F\u7528\u56FE2\u7684\u6750\u6599\u3001\u5DE5\u827A\u3001\u8272\u5F69\u548C\u89C6\u89C9\u8BED\u8A00\u91CD\u65B0\u6F14\u7ECE",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "pattern",
            type: "image-input",
            position: { x: 0, y: -170 },
            data: {
              kind: "image-input",
              label: "\u56FE1 \xB7 \u539F\u59CB\u56FE\u6848",
              status: "idle",
              imageRole: "garment"
            }
          },
          {
            id: "style",
            type: "image-input",
            position: { x: 0, y: 190 },
            data: {
              kind: "image-input",
              label: "\u56FE2 \xB7 \u98CE\u683C\u53C2\u8003",
              status: "idle",
              imageRole: "reference"
            }
          },
          {
            id: "transfer",
            type: "ai-modify",
            position: { x: 430, y: 0 },
            data: {
              kind: "ai-modify",
              label: "\u56FE\u6848\u98CE\u683C\u8FC1\u79FB",
              status: "idle",
              prompt: "\u4E25\u683C\u6309\u7167\u8F93\u5165\u987A\u5E8F\u5904\u7406\uFF1A\u56FE1\u662F\u5FC5\u987B\u4FDD\u7559\u7684\u539F\u59CB\u56FE\u6848\uFF0C\u56FE2\u662F\u4EC5\u7528\u4E8E\u5B66\u4E60\u6750\u6599\u3001\u5DE5\u827A\u3001\u8272\u5F69\u548C\u89C6\u89C9\u8BED\u8A00\u7684\u98CE\u683C\u53C2\u8003\u3002\u4FDD\u7559\u56FE1\u7684\u4E3B\u9898\u5143\u7D20\u3001\u6570\u91CF\u3001\u6784\u56FE\u5E03\u5C40\u3001\u8F6E\u5ED3\u6BD4\u4F8B\u548C\u4E3B\u8981\u8BC6\u522B\u7279\u5F81\uFF0C\u5C06\u5B83\u4EEC\u91CD\u65B0\u6F14\u7ECE\u4E3A\u56FE2\u7684\u9762\u6599\u7EB9\u7406\u3001\u624B\u5DE5\u5DE5\u827A\u3001\u7B14\u89E6\u3001\u914D\u8272\u548C\u8D28\u611F\u3002\u4E0D\u8981\u590D\u5236\u56FE2\u7684\u4E3B\u4F53\u6216\u6784\u56FE\uFF0C\u4E0D\u8981\u4E22\u5931\u56FE1\u7684\u4E3B\u4F53\uFF0C\u4E0D\u8981\u65B0\u589E\u65E0\u5173\u6587\u5B57\u3001\u6C34\u5370\u6216\u5143\u7D20\u3002\u8F93\u51FA\u5B8C\u6574\u3001\u6E05\u6670\u3001\u53EF\u7528\u4E8E\u670D\u88C5\u5370\u82B1\u7684\u5355\u5F20\u56FE\u6848\u3002",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "result",
            type: "result",
            position: { x: 860, y: 0 },
            data: {
              kind: "result",
              label: "\u8FC1\u79FB\u7ED3\u679C",
              status: "idle",
              images: [],
              note: "\u56FE\u6848\u4E3B\u9898\u6765\u81EA\u56FE1\uFF0C\u6750\u6599\u3001\u5DE5\u827A\u4E0E\u89C6\u89C9\u98CE\u683C\u6765\u81EA\u56FE2"
            }
          }
        ],
        edges: [
          { id: "pattern-to-transfer", source: "pattern", target: "transfer" },
          { id: "style-to-transfer", source: "style", target: "transfer" },
          { id: "transfer-to-result", source: "transfer", target: "result" }
        ]
      }
    }
  ];
}
function ensureBuiltinTemplates() {
  fs6.rmSync(templatePath("builtin", "builtin-style-transfer"), { force: true });
  for (const tpl of builtinTemplates()) {
    const filePath = templatePath("builtin", tpl.id);
    if (!fs6.existsSync(filePath)) writeJsonAtomicSync(filePath, tpl);
  }
}
ensureBuiltinTemplates();
function readTemplates(sub) {
  const dir = templatesDir(sub);
  const list = [];
  for (const f of fs6.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      list.push(readTemplateFile(path6.join(dir, f)));
    } catch {
    }
  }
  return list;
}
function readTemplateFile(filePath) {
  const raw = JSON.parse(fs6.readFileSync(filePath, "utf-8"));
  if (raw.schemaVersion !== void 0 && raw.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new WorkflowValidationError(`unsupported template schemaVersion: ${String(raw.schemaVersion)}`);
  }
  const flow = validateAndMigrateFlow(raw.flow);
  if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name || typeof raw.description !== "string" || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) {
    throw new WorkflowValidationError("invalid template metadata");
  }
  if (raw.thumbnail !== void 0 && !isLocalImageReference(raw.thumbnail)) {
    throw new WorkflowValidationError("template thumbnail must be a local /api/files image reference");
  }
  return { ...raw, schemaVersion: WORKFLOW_SCHEMA_VERSION, flow };
}
templatesRouter.get("/", (_req, res) => {
  try {
    const builtin = readTemplates("builtin");
    const user = readTemplates("user").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json([...builtin, ...user]);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
templatesRouter.get("/:id", (req, res) => {
  const id = req.params.id;
  const filePath = fs6.existsSync(templatePath("user", id)) ? templatePath("user", id) : templatePath("builtin", id);
  if (!fs6.existsSync(filePath)) {
    res.status(404).json({ error: "template not found" });
    return;
  }
  try {
    res.json(readTemplateFile(filePath));
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 422 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
templatesRouter.post("/", (req, res) => {
  const { name, description, thumbnail, flow } = req.body;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200 || flow === void 0) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  try {
    if (description !== void 0 && typeof description !== "string") throw new WorkflowValidationError("description must be a string");
    if (thumbnail !== void 0 && !isLocalImageReference(thumbnail)) {
      throw new WorkflowValidationError("thumbnail must be a local /api/files image reference");
    }
    const id = nanoid8(10);
    const template = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id,
      name: name.trim(),
      description: description ?? "",
      ...thumbnail ? { thumbnail } : {},
      flow: validateAndMigrateFlow(flow),
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    writeJsonAtomicSync(templatePath("user", id), template);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
templatesRouter.delete("/:id", (req, res) => {
  const id = req.params.id;
  if (fs6.existsSync(templatePath("builtin", id))) {
    res.status(403).json({ error: "builtin template cannot be deleted" });
    return;
  }
  const filePath = templatePath("user", id);
  if (!fs6.existsSync(filePath)) {
    res.status(404).json({ error: "template not found" });
    return;
  }
  try {
    fs6.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// server/routes/assets.ts
import { Router as Router6 } from "express";
import { nanoid as nanoid9 } from "nanoid";
var assetsRouter = Router6();
var CATEGORIES = ["print", "fabric", "reference"];
var TRASH_DAYS = 15;
function mapAsset(row, currentUserId) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    scope: row.scope,
    name: row.name,
    category: row.category,
    image: row.image,
    ...row.source_note ? { sourceNote: row.source_note } : {},
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    canManage: row.scope === "global" ? false : row.owner_id === currentUserId
  };
}
async function purgeExpiredAssets() {
  await query(`
    DELETE FROM assets WHERE purge_after IS NOT NULL AND purge_after <= $1
      AND NOT EXISTS (SELECT 1 FROM project_asset_refs r WHERE r.asset_id = assets.id)
  `, [(/* @__PURE__ */ new Date()).toISOString()]);
}
assetsRouter.get("/", asyncHandler(async (req, res) => {
  await purgeExpiredAssets();
  const user = requestUser(req);
  const category = req.query.category;
  if (category && !CATEGORIES.includes(category)) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
    return;
  }
  const includeDeleted = req.query.deleted === "true";
  const rows = await query(`
    SELECT a.*, u.display_name AS owner_name
    FROM assets a LEFT JOIN users u ON u.id = a.owner_id
    WHERE ($1::text IS NULL OR a.category = $1)
      AND (${includeDeleted ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL"})
      AND ($2 = 'admin' OR a.scope IN ('global','shared') OR a.owner_id = $3)
    ORDER BY a.created_at DESC
  `, [category ?? null, user.role, user.id]);
  res.json(rows.map((row) => ({
    ...mapAsset(row, user.id),
    canManage: row.scope === "global" ? user.role === "admin" : row.owner_id === user.id
  })));
}));
assetsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { name, category, image, sourceNote, scope } = req.body;
  if (typeof name !== "string" || !name.trim() || name.length > 200 || !category || !CATEGORIES.includes(category) || typeof image !== "string" || !image) {
    res.status(400).json({ error: "name, category and image are required" });
    return;
  }
  if (scope === "global" && user.role !== "admin") {
    res.status(403).json({ error: "\u53EA\u6709\u7BA1\u7406\u5458\u53EF\u4EE5\u521B\u5EFA\u901A\u7528\u7D20\u6750" });
    return;
  }
  try {
    if (sourceNote !== void 0 && (typeof sourceNote !== "string" || sourceNote.length > 2e3)) {
      throw new ImageValidationError("sourceNote must be a string of at most 2000 characters");
    }
    const saved = image.startsWith("data:") ? saveDataUrl(image) : void 0;
    const imageUrl = saved?.url ?? (isLocalImageReference(image) ? image : "");
    if (!imageUrl) throw new ImageValidationError("image must be a local image reference or valid image dataURL");
    if (saved) {
      await query(`
        INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, $2, 'asset', $3)
        ON CONFLICT (id) DO NOTHING
      `, [saved.id, user.id, (/* @__PURE__ */ new Date()).toISOString()]);
    }
    const id = nanoid9(10);
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const finalScope = scope === "global" && user.role === "admin" ? "global" : scope === "shared" ? "shared" : "private";
    await query(`
      INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [id, finalScope === "global" ? null : user.id, finalScope, name.trim(), category, imageUrl, sourceNote ?? null, createdAt]);
    res.status(201).json({ ok: true, id });
  } catch (error) {
    res.status(error instanceof ImageValidationError ? 400 : 500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));
assetsRouter.patch("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(
    "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NULL",
    [req.params.id]
  );
  if (!row) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
  if (!canManage) {
    res.status(403).json({ error: "\u65E0\u6743\u4FEE\u6539\u6B64\u7D20\u6750" });
    return;
  }
  const { name, scope } = req.body;
  if (name !== void 0 && (typeof name !== "string" || !name.trim() || name.length > 200)) {
    res.status(400).json({ error: "\u7D20\u6750\u540D\u79F0\u65E0\u6548" });
    return;
  }
  if (scope === "global" && user.role !== "admin") {
    res.status(403).json({ error: "\u53EA\u6709\u7BA1\u7406\u5458\u53EF\u4EE5\u8BBE\u7F6E\u901A\u7528\u7D20\u6750" });
    return;
  }
  const nextScope = scope ?? row.scope;
  await query("UPDATE assets SET name = COALESCE($1, name), scope = $2, owner_id = $3 WHERE id = $4", [
    name?.trim() ?? null,
    nextScope,
    nextScope === "global" ? null : row.owner_id ?? user.id,
    req.params.id
  ]);
  res.json({ ok: true });
}));
assetsRouter.post("/:id/references", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { projectId } = req.body;
  if (typeof projectId !== "string" || !projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  const asset = await queryOne(`
    SELECT id FROM assets WHERE id = $1 AND deleted_at IS NULL
      AND (scope IN ('global','shared') OR owner_id = $2 OR $3 = 'admin')
  `, [req.params.id, user.id, user.role]);
  if (!asset) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  await query(`
    INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES ($1, $2, $3)
    ON CONFLICT (project_id, asset_id) DO NOTHING
  `, [projectId, req.params.id, (/* @__PURE__ */ new Date()).toISOString()]);
  res.json({ ok: true });
}));
assetsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(
    "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NULL",
    [req.params.id]
  );
  if (!row) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
  if (!canManage) {
    res.status(403).json({ error: "\u65E0\u6743\u5220\u9664\u6B64\u7D20\u6750" });
    return;
  }
  const ref = await queryOne(
    "SELECT project_id FROM project_asset_refs WHERE asset_id = $1 LIMIT 1",
    [req.params.id]
  );
  if (ref) {
    res.status(409).json({ error: "\u7D20\u6750\u6B63\u5728\u88AB\u9879\u76EE\u4F7F\u7528\uFF0C\u4E0D\u80FD\u5220\u9664" });
    return;
  }
  const deletedAt = /* @__PURE__ */ new Date();
  const purgeAfter = new Date(deletedAt.getTime() + TRASH_DAYS * 24 * 60 * 60 * 1e3);
  await query("UPDATE assets SET deleted_at = $1, purge_after = $2 WHERE id = $3", [
    deletedAt.toISOString(),
    purgeAfter.toISOString(),
    req.params.id
  ]);
  res.json({ ok: true, purgeAfter: purgeAfter.toISOString() });
}));
assetsRouter.post("/:id/restore", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(
    "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NOT NULL",
    [req.params.id]
  );
  if (!row) {
    res.status(404).json({ error: "\u56DE\u6536\u7AD9\u4E2D\u6CA1\u6709\u6B64\u7D20\u6750" });
    return;
  }
  const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
  if (!canManage) {
    res.status(403).json({ error: "\u65E0\u6743\u6062\u590D\u6B64\u7D20\u6750" });
    return;
  }
  await query("UPDATE assets SET deleted_at = NULL, purge_after = NULL WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));

// server/lib/rateLimit.ts
function createRateLimitMiddleware(options = {}) {
  const windowMs = options.windowMs ?? 6e4;
  const maxRequests = options.maxRequests ?? 5;
  const now = options.now ?? Date.now;
  const buckets = /* @__PURE__ */ new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const currentTime = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.status(429).json({
        error: "Too many requests, please slow down",
        retryAfter: Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1e3))
      });
      return;
    }
    next();
  };
}

// server/routes/auth.ts
import { Router as Router7 } from "express";
import { nanoid as nanoid10 } from "nanoid";
var authRouter = Router7();
function publicUser(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    ...row.active === void 0 ? {} : { active: row.active === 1 },
    ...row.created_at ? { createdAt: row.created_at } : {}
  };
}
authRouter.post("/login", asyncHandler(async (req, res) => {
  const { accountId, password } = req.body;
  if (typeof accountId !== "string" || typeof password !== "string" || !accountId.trim() || !password) {
    res.status(400).json({ error: "\u8D26\u53F7\u548C\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A" });
    return;
  }
  const row = await queryOne(`
    SELECT id, account_id, display_name, role, password_hash, must_change_password, active
    FROM users WHERE account_id = $1 AND deleted_at IS NULL
  `, [accountId.trim()]);
  if (!row || row.active !== 1 || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({ error: "\u8D26\u53F7\u6216\u5BC6\u7801\u9519\u8BEF" });
    return;
  }
  const session = await createSession(row.id);
  setSessionCookie(res, session.token);
  res.json({ user: publicUser(row), expiresAt: session.expiresAt });
}));
authRouter.use(requireAuth);
authRouter.get("/me", (req, res) => {
  res.json({ user: requestUser(req) });
});
authRouter.post("/logout", asyncHandler(async (req, res) => {
  await revokeRequestSession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
}));
authRouter.post("/change-password", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "\u5F53\u524D\u5BC6\u7801\u548C\u65B0\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A" });
    return;
  }
  const invalid = validatePassword(newPassword);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const row = await queryOne("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({ error: "\u5F53\u524D\u5BC6\u7801\u9519\u8BEF" });
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await query("UPDATE users SET password_hash = $1, must_change_password = 0, updated_at = $2 WHERE id = $3", [
    hashPassword(newPassword),
    now,
    user.id
  ]);
  const session = await createSession(user.id);
  setSessionCookie(res, session.token);
  res.json({ ok: true, user: { ...user, mustChangePassword: false }, expiresAt: session.expiresAt });
}));
authRouter.get("/users", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query(`
    SELECT id, account_id, display_name, role, must_change_password, active, created_at
    FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC
  `);
  res.json(rows.map(publicUser));
}));
authRouter.post("/users", requireAdmin, asyncHandler(async (req, res) => {
  const { accountId, displayName, password, role } = req.body;
  if (typeof accountId !== "string" || !/^[A-Za-z0-9@._+-]{3,64}$/.test(accountId) || typeof displayName !== "string" || !displayName.trim() || displayName.length > 100 || typeof password !== "string") {
    res.status(400).json({ error: "\u8D26\u53F7\u3001\u540D\u79F0\u6216\u5BC6\u7801\u683C\u5F0F\u65E0\u6548" });
    return;
  }
  const invalid = validatePassword(password);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = nanoid10(12);
  try {
    await query(`
      INSERT INTO users (id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $6)
    `, [id, accountId, displayName.trim(), role === "admin" ? "admin" : "user", hashPassword(password), now]);
    res.status(201).json({ id });
  } catch (error) {
    const duplicate = typeof error === "object" && error !== null && "code" in error && error.code === "23505";
    res.status(duplicate ? 409 : 500).json({ error: duplicate ? "\u8D26\u53F7\u5DF2\u5B58\u5728" : String(error) });
  }
}));
authRouter.patch("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const actor = requestUser(req);
  const { active, displayName } = req.body;
  if (req.params.id === actor.id && active === false) {
    res.status(400).json({ error: "\u4E0D\u80FD\u505C\u7528\u5F53\u524D\u7BA1\u7406\u5458\u8D26\u53F7" });
    return;
  }
  const row = await queryOne("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!row) {
    res.status(404).json({ error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (typeof displayName === "string" && displayName.trim() && displayName.length <= 100) {
    await query("UPDATE users SET display_name = $1, updated_at = $2 WHERE id = $3", [displayName.trim(), now, req.params.id]);
  }
  if (typeof active === "boolean") {
    await query("UPDATE users SET active = $1, updated_at = $2 WHERE id = $3", [active ? 1 : 0, now, req.params.id]);
    if (!active) await revokeUserSessions(req.params.id);
  }
  res.json({ ok: true });
}));
authRouter.post("/users/:id/reset-password", requireAdmin, asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (typeof password !== "string") {
    res.status(400).json({ error: "\u65B0\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A" });
    return;
  }
  const invalid = validatePassword(password);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const result = await db().query(`
    UPDATE users SET password_hash = $1, must_change_password = 1, updated_at = $2
    WHERE id = $3 AND deleted_at IS NULL
  `, [hashPassword(password), (/* @__PURE__ */ new Date()).toISOString(), req.params.id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  await revokeUserSessions(req.params.id);
  res.json({ ok: true });
}));
authRouter.delete("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const actor = requestUser(req);
  if (req.params.id === actor.id) {
    res.status(400).json({ error: "\u4E0D\u80FD\u5220\u9664\u5F53\u524D\u7BA1\u7406\u5458\u8D26\u53F7" });
    return;
  }
  const { transferToUserId, deleteData } = req.body;
  if (!transferToUserId && deleteData !== true) {
    res.status(400).json({ error: "\u5FC5\u987B\u9009\u62E9\u6570\u636E\u63A5\u6536\u7528\u6237\uFF0C\u6216\u660E\u786E\u5C06\u6570\u636E\u653E\u5165 15 \u5929\u56DE\u6536\u7AD9" });
    return;
  }
  const source = await queryOne("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!source) {
    res.status(404).json({ error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  if (transferToUserId) {
    const target = await queryOne(
      "SELECT id FROM users WHERE id = $1 AND active = 1 AND deleted_at IS NULL",
      [transferToUserId]
    );
    if (!target) {
      res.status(400).json({ error: "\u6570\u636E\u63A5\u6536\u7528\u6237\u4E0D\u5B58\u5728\u6216\u5DF2\u505C\u7528" });
      return;
    }
  }
  const now = /* @__PURE__ */ new Date();
  const nowIso = now.toISOString();
  const purgeAfter = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1e3).toISOString();
  await transaction(async (client) => {
    if (transferToUserId) {
      for (const table of ["projects", "assets", "files", "generation_runs", "usage_events"]) {
        await client.query(`UPDATE ${table} SET owner_id = $1 WHERE owner_id = $2`, [transferToUserId, req.params.id]);
      }
    } else {
      await client.query("UPDATE projects SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3", [nowIso, purgeAfter, req.params.id]);
      await client.query(
        "UPDATE assets SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL",
        [nowIso, purgeAfter, req.params.id]
      );
    }
    await client.query("DELETE FROM sessions WHERE user_id = $1", [req.params.id]);
    await client.query("UPDATE users SET active = 0, deleted_at = $1, updated_at = $1 WHERE id = $2", [nowIso, req.params.id]);
  });
  res.json({ ok: true, purgeAfter: transferToUserId ? null : purgeAfter });
}));

// server/routes/history.ts
import { Router as Router8 } from "express";
var historyRouter = Router8();
function parseJson(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
historyRouter.get("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const requestedUserId = typeof req.query.userId === "string" ? req.query.userId : void 0;
  if (requestedUserId && user.role !== "admin" && requestedUserId !== user.id) {
    res.status(403).json({ error: "\u65E0\u6743\u67E5\u770B\u5176\u4ED6\u7528\u6237\u8BB0\u5F55" });
    return;
  }
  const ownerId = requestedUserId ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const rows = await query(`
    SELECT r.*, o.id AS output_id, o.image, o.prompt AS output_prompt,
      o.status AS output_status, o.error AS output_error, u.display_name AS owner_name
    FROM generation_runs r
    JOIN users u ON u.id = r.owner_id
    LEFT JOIN generation_outputs o ON o.run_id = r.id
    WHERE ($1::text IS NULL OR r.owner_id = $1)
      AND (o.id IS NOT NULL OR r.status IN ('queued','running'))
    ORDER BY r.started_at DESC, o.created_at ASC
    LIMIT $2 OFFSET $3
  `, [ownerId, limit, offset]);
  res.json(rows.map((row) => ({
    id: row.output_id ?? row.id,
    runId: row.id,
    image: row.image ?? "",
    nodeId: row.node_id,
    nodeLabel: row.node_label,
    kind: row.kind,
    projectId: row.project_id,
    projectName: row.project_name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    prompt: row.output_prompt ?? row.prompt,
    parameters: parseJson(row.parameters_json, {}),
    referenceImages: parseJson(row.reference_images_json, []),
    model: row.model,
    requestedCount: row.requested_count,
    successfulCount: row.successful_count,
    providerRequests: row.provider_requests,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.output_status ?? row.status,
    error: row.output_error ?? row.error
  })));
}));
historyRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(`
    SELECT r.owner_id, r.id AS run_id FROM generation_outputs o
    JOIN generation_runs r ON r.id = o.run_id WHERE o.id = $1
  `, [req.params.id]);
  if (!row || row.owner_id !== user.id) {
    res.status(row ? 403 : 404).json({ error: row ? "\u53EA\u80FD\u5220\u9664\u81EA\u5DF1\u7684\u751F\u6210\u5386\u53F2" : "\u8BB0\u5F55\u4E0D\u5B58\u5728" });
    return;
  }
  await query("DELETE FROM generation_outputs WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));

// server/routes/usage.ts
import { Router as Router9 } from "express";
var usageRouter = Router9();
async function queryRows(ownerId, from, to) {
  return query(`
    SELECT e.*, u.account_id, u.display_name
    FROM usage_events e JOIN users u ON u.id = e.owner_id
    WHERE ($1::text IS NULL OR e.owner_id = $1)
      AND ($2::text IS NULL OR e.created_at >= $2)
      AND ($3::text IS NULL OR e.created_at <= $3)
    ORDER BY e.created_at DESC
  `, [ownerId, from, to]);
}
function csvCell(value) {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
usageRouter.get("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const selected = typeof req.query.userId === "string" ? req.query.userId : void 0;
  if (selected && user.role !== "admin" && selected !== user.id) {
    res.status(403).json({ error: "\u65E0\u6743\u67E5\u770B\u5176\u4ED6\u7528\u6237\u6D88\u8017" });
    return;
  }
  const ownerId = selected ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const from = typeof req.query.from === "string" && Number.isFinite(Date.parse(req.query.from)) ? req.query.from : null;
  const to = typeof req.query.to === "string" && Number.isFinite(Date.parse(req.query.to)) ? req.query.to : null;
  const rows = await queryRows(ownerId, from, to);
  if (req.query.format === "csv") {
    const header = ["\u8BB0\u5F55ID", "\u8D26\u53F7", "\u7528\u6237", "\u751F\u6210\u4EFB\u52A1", "\u9879\u76EE", "\u8282\u70B9", "\u6A21\u578B", "\u6210\u529F\u56FE\u7247\u6570", "\u670D\u52A1\u5546\u8BF7\u6C42\u6570", "\u8017\u65F6\u6BEB\u79D2", "\u65F6\u95F4"];
    const lines = [header, ...rows.map((row) => [
      row.id,
      row.account_id,
      row.display_name,
      row.run_id,
      row.project_id,
      row.node_id,
      row.model,
      row.successful_count,
      row.provider_requests,
      row.duration_ms,
      row.created_at
    ])].map((line) => line.map(csvCell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="usage-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv"`);
    res.send(`\uFEFF${lines.join("\r\n")}`);
    return;
  }
  res.json(rows.map((row) => ({
    id: row.id,
    userId: row.owner_id,
    accountId: row.account_id,
    displayName: row.display_name,
    runId: row.run_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    model: row.model,
    successfulCount: row.successful_count,
    providerRequests: row.provider_requests,
    durationMs: row.duration_ms,
    createdAt: row.created_at
  })));
}));

// server/lib/legacyMigration.ts
import fs7 from "node:fs";
import path7 from "node:path";
import { nanoid as nanoid11 } from "nanoid";
async function migrateLegacyData() {
  const admin = await queryOne(`
    SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1
  `);
  if (!admin) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const uploads = path7.join(config.dataDir(), "uploads");
  if (fs7.existsSync(uploads)) {
    await transaction(async (client) => {
      for (const file of fs7.readdirSync(uploads)) {
        const id = path7.basename(file);
        await client.query(`
          INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, NULL, 'legacy', $2)
          ON CONFLICT (id) DO NOTHING
        `, [id, now]);
        const image = `/api/files/${id}`;
        const existing = await queryOne("SELECT id FROM assets WHERE image = $1 LIMIT 1", [image], client);
        if (!existing) {
          await client.query(`
            INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
            VALUES ($1, NULL, 'global', $2, 'reference', $3, '\u4ECE\u5347\u7EA7\u524D\u670D\u52A1\u5668\u6587\u4EF6\u8FC1\u79FB', $4)
          `, [nanoid11(10), `\u5386\u53F2\u7D20\u6750-${path7.parse(id).name}`, image, now]);
        }
      }
    });
  }
  const projects = path7.join(config.dataDir(), "projects");
  if (fs7.existsSync(projects)) {
    await transaction(async (client) => {
      for (const file of fs7.readdirSync(projects)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs7.readFileSync(path7.join(projects, file), "utf-8"));
          if (typeof raw.id !== "string" || typeof raw.name !== "string") continue;
          const flow = validateAndMigrateFlow(raw.flow);
          const updatedAt = typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : now;
          await client.query(`
            INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING
          `, [raw.id, admin.id, raw.name, JSON.stringify(flow), updatedAt]);
        } catch {
        }
      }
    });
  }
  const assets = path7.join(config.dataDir(), "assets");
  if (fs7.existsSync(assets)) {
    await transaction(async (client) => {
      for (const file of fs7.readdirSync(assets)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs7.readFileSync(path7.join(assets, file), "utf-8"));
          if (typeof raw.id !== "string" || typeof raw.name !== "string" || !["print", "fabric", "reference"].includes(String(raw.category)) || typeof raw.image !== "string" || !isLocalImageReference(raw.image)) continue;
          const note = typeof raw.sourceNote === "string" ? raw.sourceNote : null;
          const existing = await queryOne("SELECT id FROM assets WHERE image = $1 LIMIT 1", [raw.image], client);
          if (existing) {
            await client.query(`
              UPDATE assets SET name = $1, category = $2, source_note = $3, scope = 'global', owner_id = NULL
              WHERE image = $4
            `, [raw.name, raw.category, note, raw.image]);
          } else {
            await client.query(`
              INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
              VALUES ($1, NULL, 'global', $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
            `, [raw.id, raw.name, raw.category, raw.image, note, typeof raw.createdAt === "string" ? raw.createdAt : now]);
          }
        } catch {
        }
      }
    });
  }
}

// server/index.ts
var app = express();
app.use(express.json({ limit: "50mb" }));
var aiRateLimit = createRateLimitMiddleware();
var loginRateLimit = createRateLimitMiddleware({ windowMs: 6e4, maxRequests: 10 });
app.get("/api/health", (_req, res) => res.json({ ok: true, status: "alive" }));
var isProduction = process.env.NODE_ENV === "production";
var apiOnly = config.apiOnly();
var distDir = path8.join(ROOT_DIR, "dist");
var distIndex = path8.join(distDir, "index.html");
function dataDirWritable() {
  const dataDir = config.dataDir();
  const probePath = path8.join(dataDir, `.readiness-${process.pid}-${Date.now()}`);
  let fd;
  let writable = false;
  try {
    fs8.mkdirSync(dataDir, { recursive: true });
    if (!fs8.statSync(dataDir).isDirectory()) return false;
    fd = fs8.openSync(probePath, "wx");
    fs8.writeSync(fd, "ready");
    writable = true;
  } catch {
    writable = false;
  } finally {
    try {
      if (fd !== void 0) fs8.closeSync(fd);
    } catch {
      writable = false;
    }
    try {
      fs8.rmSync(probePath, { force: true });
    } catch {
      writable = false;
    }
  }
  return writable;
}
async function readiness() {
  const checks = {
    dataDirWritable: dataDirWritable(),
    frontend: !isProduction || apiOnly || fs8.existsSync(distIndex),
    aiConfigured: config.aiConfigReady(),
    database: await databaseReady(),
    usersConfigured: await hasUsers()
  };
  return { ok: Object.values(checks).every(Boolean), checks, mode: apiOnly ? "api-only" : "full" };
}
app.get("/api/ready", asyncHandler(async (_req, res) => {
  const ready = await readiness();
  res.status(ready.ok ? 200 : 503).json(ready);
}));
app.use("/api/auth/login", loginRateLimit);
app.use("/api/auth", authRouter);
app.use("/api", requireAuth, requirePasswordChanged);
app.use("/api/generate", aiRateLimit, generateRouter);
app.use("/api/run-plan", aiRateLimit, runPlanRouter);
app.use("/api/files", filesRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/assets", assetsRouter);
app.use("/api/history", historyRouter);
app.use("/api/usage", usageRouter);
var apiErrorHandler = (error, _req, res, _next) => {
  console.error("[garment-canvas] request failed", error);
  if (!res.headersSent) res.status(500).json({ error: "\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u5904\u7406\u8BF7\u6C42" });
};
app.use(apiErrorHandler);
if (isProduction && !apiOnly) {
  if (!fs8.existsSync(distIndex)) {
    throw new Error(
      `Production frontend is missing: ${distIndex}. Run npm run build, or set API_ONLY=true for an API-only deployment.`
    );
  }
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(distIndex));
}
var port = config.port();
async function start() {
  await initializeDatabase();
  await pruneExpiredSessions();
  await migrateLegacyData();
  const initialReadiness = await readiness();
  if (!initialReadiness.ok) throw new Error(`Server is not ready: ${JSON.stringify(initialReadiness.checks)}`);
  app.listen(port, () => {
    console.log(`[garment-canvas] server listening on http://localhost:${port} (${initialReadiness.mode})`);
  });
}
await start();
