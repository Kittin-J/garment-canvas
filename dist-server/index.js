// server/index.ts
import express from "express";
import cors from "cors";
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
  /** 生产模式是否只提供 API；true 时不要求或托管前端 dist。 */
  apiOnly: () => process.env.API_ONLY === "true",
  /** AI 调用超时（中转站网关限制，可配） */
  aiTimeoutMs: () => Number(process.env.AI_TIMEOUT_MS ?? 300000),
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
  /** 文生图（可带参考图）；batchSize 通过多次调用实现 */
  async generate(req) {
    const n = Math.max(1, Math.min(req.batchSize ?? 1, 4));
    const settled = await Promise.all(Array.from({ length: n }, () => generateOnce(req)));
    return {
      images: settled.flat(),
      model: config.nanobananaModel()
    };
  },
  /** 图生图：使用 /v1/images/edits */
  async edit(req) {
    if (!req.referenceImages?.length) {
      throw new ProviderError("edit requires referenceImages", 400, PROVIDER_ID);
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
        req.referenceImages.forEach((ref, i) => {
          const { mime, buffer } = parseDataUrl(ref);
          const ext = mime.split("/")[1] ?? "png";
          form.append("image", new Blob([new Uint8Array(buffer)], { type: mime }), `ref-${i}.${ext}`);
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
          form.append("image", new Blob([new Uint8Array(buffer)], { type: mime }), `ref-${i}.${ext}`);
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
var generateRouter = Router();
generateRouter.post("/", async (req, res) => {
  const { providerId, request } = req.body;
  if (!providerId || !request?.prompt) {
    res.status(400).json({ error: "providerId and request.prompt are required" });
    return;
  }
  try {
    const provider = getProvider(providerId);
    const resolved = {
      ...request,
      referenceImages: request.referenceImages ? await Promise.all(request.referenceImages.map(normalizeImageRef)) : void 0,
      mask: request.mask ? await normalizeImageRef(request.mask) : void 0
    };
    const raw = resolved.referenceImages?.length ? await provider.edit(resolved) : await provider.generate(resolved);
    const images = await Promise.all(raw.images.map(persistImageRef));
    res.json({ ...raw, images });
  } catch (err) {
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

// src/types/workflow.ts
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
    inputs: 1,
    outputs: "images"
  },
  "ai-modify": {
    kind: "ai-modify",
    title: "AI \u6539\u6B3E",
    description: "gpt-image-2 \u6539\u9886\u578B/\u8896\u578B/\u957F\u5EA6/\u7EC6\u8282",
    providerId: "gpt-image-2",
    inputs: 1,
    outputs: "images"
  },
  "fabric-recolor": {
    kind: "fabric-recolor",
    title: "\u9762\u6599/\u914D\u8272\u66FF\u6362",
    description: "gpt-image-2 \u66FF\u6362\u9762\u6599\u7EB9\u7406\u4E0E\u914D\u8272",
    providerId: "gpt-image-2",
    inputs: 2,
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
    inputs: 1,
    outputs: "images"
  },
  "print-mutate": {
    kind: "print-mutate",
    title: "\u5370\u82B1\u88C2\u53D8",
    description: "gpt-image-2 \u57FA\u4E8E\u5370\u82B1\u751F\u6210 1~8 \u5F20\u98CE\u683C\u4E00\u81F4\u7684\u53D8\u4F53",
    providerId: "gpt-image-2",
    inputs: 1,
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
import { nanoid as nanoid2 } from "nanoid";

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
function createRun(plan) {
  pruneRuns();
  const run = {
    id: nanoid2(10),
    plan,
    emitter: new EventEmitter(),
    events: [],
    finished: false,
    createdAt: Date.now()
  };
  run.emitter.setMaxListeners(50);
  runs.set(run.id, run);
  setImmediate(() => {
    executeRun(run).catch((err) => {
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
    emit(run, { type: "node-status", nodeId: step.nodeId, status: "running", startedAt });
    try {
      const result = await executeStep(step, inputImages);
      const persisted = await persistOutputImages(result.images);
      outputs.set(step.nodeId, persisted);
      const finishedAt = Date.now();
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
      return { images: imageUrl ? [imageUrl] : [] };
    }
    case "result": {
      return { images: inputImages };
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
      const extra = (step.params.prompt ?? "").trim();
      if (step.kind === "fabric-recolor") {
        const colors = Array.isArray(step.params.colors) ? step.params.colors.filter((value) => typeof value === "string") : [];
        if (colors.length > 0) {
          const images = [];
          const prompts = [];
          const failures = [];
          let model;
          for (const color of colors) {
            const prompt2 = buildRecolorPrompt([color]);
            try {
              const result2 = referenceImages.length ? await provider.edit({ prompt: prompt2, referenceImages, batchSize: 1 }) : await provider.generate({ prompt: prompt2, batchSize: 1 });
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
          return { images, prompts, model, failures: failures.length ? failures : void 0 };
        }
      }
      if (step.kind === "print-mutate") {
        const count = Math.max(1, Math.min(8, Number(step.params.count) || 4));
        const prompt2 = "\u57FA\u4E8E\u8FD9\u5F20\u5370\u82B1\u56FE\u6848\u751F\u6210\u98CE\u683C\u4E00\u81F4\u7684\u65B0\u53D8\u4F53\uFF1A\u4FDD\u6301\u539F\u6709\u914D\u8272\u4F53\u7CFB\u3001\u827A\u672F\u98CE\u683C\u4E0E\u7B14\u89E6\u8D28\u611F\uFF0C\u91CD\u65B0\u7F16\u6392\u5143\u7D20\u7684\u6784\u56FE\u4E0E\u7EC4\u5408\u65B9\u5F0F\uFF0C\u7EAF\u767D\u80CC\u666F\uFF0C\u9002\u5408\u4F5C\u4E3A\u5370\u82B1\u7D20\u6750\u590D\u7528" + (extra ? `\u3002\u8865\u5145\u8981\u6C42\uFF1A${extra}` : "");
        const all = [];
        const prompts = [];
        const failures = [];
        let model;
        let attempts = 0;
        while (all.length < count && attempts < count + 3) {
          attempts++;
          const n = Math.min(4, count - all.length);
          try {
            const result2 = referenceImages.length ? await provider.edit({ prompt: prompt2, referenceImages, batchSize: n }) : await provider.generate({ prompt: prompt2, batchSize: n });
            model = result2.model;
            const accepted = result2.images.slice(0, count - all.length);
            all.push(...accepted);
            prompts.push(...accepted.map(() => prompt2));
          } catch (err) {
            failures.push({
              prompt: prompt2,
              error: err instanceof Error ? err.message : String(err)
            });
          }
        }
        if (all.length === 0) throw new Error(failures[0]?.error ?? "\u5370\u82B1\u88C2\u53D8\u5931\u8D25");
        if (all.length < count && failures.length === 0) {
          failures.push({ prompt: prompt2, error: `\u53EA\u751F\u6210\u4E86 ${all.length}/${count} \u5F20\u56FE\u7247` });
        }
        return { images: all, prompts, model, failures: failures.length ? failures : void 0 };
      }
      const prompt = step.kind === "upscale" ? "\u5C06\u8FD9\u5F20\u670D\u88C5\u6548\u679C\u56FE\u653E\u5927\u4E3A\u8D85\u9AD8\u6E05\u7248\u672C\uFF0C\u589E\u5F3A\u9762\u6599\u7EB9\u7406\u3001\u8D70\u7EBF\u4E0E\u8FB9\u7F18\u7EC6\u8282\uFF0C\u4FDD\u6301\u539F\u6709\u6784\u56FE\u3001\u8272\u5F69\u548C\u5149\u5F71\u5B8C\u5168\u4E0D\u53D8" : step.kind === "print-extract" ? "\u63D0\u53D6\u8FD9\u4EF6\u8863\u670D\u4E0A\u7684\u5370\u82B1\u56FE\u6848\uFF1A\u5C06\u5370\u82B1\u5B8C\u6574\u62A0\u51FA\u5E76\u5E73\u94FA\u5C55\u5F00\u4E3A\u89C4\u6574\u7684\u77E9\u5F62\u56FE\u6848\uFF0C\u7EAF\u767D\u80CC\u666F\uFF0C\u53BB\u9664\u8863\u8EAB\u3001\u8936\u76B1\u3001\u9634\u5F71\u548C\u7A7F\u7740\u6548\u679C\uFF0C\u5370\u82B1\u7684\u6BD4\u4F8B\u3001\u7EC6\u8282\u548C\u8272\u5F69\u4E0E\u539F\u56FE\u4FDD\u6301\u4E00\u81F4\uFF0C\u9002\u5408\u4F5C\u4E3A\u5370\u82B1\u7D20\u6750\u590D\u7528" + (extra ? `\u3002\u8865\u5145\u8981\u6C42\uFF1A${extra}` : "") : extra || DEFAULT_PROMPTS[step.kind] || NODE_SPECS[step.kind].description;
      const request = {
        prompt,
        referenceImages: referenceImages.length ? referenceImages : void 0,
        aspectRatio: step.params.aspectRatio,
        batchSize: step.params.batchSize,
        imageSize: step.kind === "upscale" ? step.params.imageSize : void 0
      };
      const result = referenceImages.length ? await provider.edit(request) : await provider.generate(request);
      return {
        images: result.images,
        model: result.model,
        prompts: result.images.map(() => prompt)
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
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges };
}

// server/routes/runPlan.ts
var runPlanRouter = Router2();
runPlanRouter.post("/", (req, res) => {
  const { nodes, edges, onlyNodeId, includeDownstream } = req.body;
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
    const run = createRun(plan);
    res.json({ runId: run.id });
  } catch (err) {
    if (err instanceof DagError || err instanceof WorkflowValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});
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

// server/routes/files.ts
import { Router as Router3 } from "express";
import fs3 from "node:fs";
import path3 from "node:path";
var filesRouter = Router3();
filesRouter.post("/", (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl) {
    res.status(400).json({ error: "dataUrl is required" });
    return;
  }
  try {
    res.json(saveDataUrl(dataUrl));
  } catch (err) {
    if (err instanceof ProviderError || err instanceof ImageValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});
filesRouter.get("/:id", (req, res) => {
  const id = path3.basename(req.params.id);
  if (id !== req.params.id || !isSupportedImageFile(id)) {
    res.status(400).json({ error: "invalid file id" });
    return;
  }
  const filePath = path3.join(uploadsDir(), id);
  if (!fs3.existsSync(filePath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  res.setHeader("Content-Type", mimeOfFile(id));
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  fs3.createReadStream(filePath).pipe(res);
});

// server/routes/projects.ts
import { Router as Router4 } from "express";
import fs5 from "node:fs";
import path5 from "node:path";
import { nanoid as nanoid4 } from "nanoid";

// server/lib/atomicJson.ts
import fs4 from "node:fs";
import path4 from "node:path";
import { nanoid as nanoid3 } from "nanoid";
function writeJsonAtomicSync(filePath, value) {
  const dir = path4.dirname(filePath);
  fs4.mkdirSync(dir, { recursive: true });
  const tempPath = path4.join(dir, `.${path4.basename(filePath)}.${process.pid}.${nanoid3(6)}.tmp`);
  try {
    const fd = fs4.openSync(tempPath, "wx", 384);
    try {
      fs4.writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`, "utf-8");
      fs4.fsyncSync(fd);
    } finally {
      fs4.closeSync(fd);
    }
    fs4.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs4.unlinkSync(tempPath);
    } catch {
    }
    throw error;
  }
}

// server/routes/projects.ts
var projectsRouter = Router4();
function readProjectFile(filePath) {
  const raw = JSON.parse(fs5.readFileSync(filePath, "utf-8"));
  if (raw.schemaVersion !== void 0 && raw.schemaVersion !== 1) {
    throw new WorkflowValidationError(`unsupported project schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name) {
    throw new WorkflowValidationError("project id and name must be non-empty strings");
  }
  if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) {
    throw new WorkflowValidationError("project updatedAt must be a valid date");
  }
  return {
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    flow: validateAndMigrateFlow(raw.flow),
    updatedAt: raw.updatedAt
  };
}
function projectsDir() {
  const dir = path5.join(config.dataDir(), "projects");
  fs5.mkdirSync(dir, { recursive: true });
  return dir;
}
function projectPath(id) {
  return path5.join(projectsDir(), `${path5.basename(id)}.json`);
}
projectsRouter.post("/", (req, res) => {
  const { id, name, flow } = req.body;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200 || flow === void 0) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  if (id !== void 0 && (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    res.status(400).json({ error: "id must contain only letters, digits, underscore or hyphen" });
    return;
  }
  const projectId = id || nanoid4(10);
  try {
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: name.trim(),
      flow: validateAndMigrateFlow(flow),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    writeJsonAtomicSync(projectPath(projectId), project);
    res.json({ ok: true, id: projectId });
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
projectsRouter.get("/", (_req, res) => {
  try {
    const list = fs5.readdirSync(projectsDir()).filter((f) => f.endsWith(".json")).map((f) => {
      try {
        const p = readProjectFile(path5.join(projectsDir(), f));
        return { id: p.id, name: p.name, updatedAt: p.updatedAt };
      } catch {
        return null;
      }
    }).filter((p) => p !== null).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
projectsRouter.get("/:id", (req, res) => {
  const filePath = projectPath(req.params.id);
  if (!fs5.existsSync(filePath)) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  try {
    const project = readProjectFile(filePath);
    res.json(project);
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 422 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// server/routes/templates.ts
import { Router as Router5 } from "express";
import fs6 from "node:fs";
import path6 from "node:path";
import { nanoid as nanoid5 } from "nanoid";
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
    }
  ];
}
function ensureBuiltinTemplates() {
  const dir = templatesDir("builtin");
  const hasAny = fs6.readdirSync(dir).some((f) => f.endsWith(".json"));
  if (hasAny) return;
  for (const tpl of builtinTemplates()) {
    writeJsonAtomicSync(templatePath("builtin", tpl.id), tpl);
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
    const id = nanoid5(10);
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
import fs7 from "node:fs";
import path7 from "node:path";
import { nanoid as nanoid6 } from "nanoid";
var assetsRouter = Router6();
var CATEGORIES = ["print", "fabric", "reference"];
function assetsDir() {
  const dir = path7.join(config.dataDir(), "assets");
  fs7.mkdirSync(dir, { recursive: true });
  return dir;
}
function assetPath(id) {
  return path7.join(assetsDir(), `${path7.basename(id)}.json`);
}
function readAssets() {
  const dir = assetsDir();
  const list = [];
  for (const f of fs7.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs7.readFileSync(path7.join(dir, f), "utf-8"));
      if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name || !CATEGORIES.includes(raw.category) || !isLocalImageReference(raw.image) || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt)) || raw.sourceNote !== void 0 && typeof raw.sourceNote !== "string") {
        throw new ImageValidationError("invalid asset record");
      }
      list.push(raw);
    } catch {
    }
  }
  return list;
}
assetsRouter.get("/", (req, res) => {
  try {
    const category = req.query.category;
    if (category !== void 0 && !CATEGORIES.includes(category)) {
      res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
      return;
    }
    let list = readAssets();
    if (category) {
      list = list.filter((a) => a.category === category);
    }
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
assetsRouter.post("/", (req, res) => {
  const { name, category, image, sourceNote } = req.body;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200 || !category || typeof image !== "string" || !image) {
    res.status(400).json({ error: "name, category and image are required" });
    return;
  }
  if (!CATEGORIES.includes(category)) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
    return;
  }
  try {
    if (sourceNote !== void 0 && (typeof sourceNote !== "string" || sourceNote.length > 2e3)) {
      throw new ImageValidationError("sourceNote must be a string of at most 2000 characters");
    }
    const imageUrl = image.startsWith("data:") ? saveDataUrl(image).url : isLocalImageReference(image) ? image : (() => {
      throw new ImageValidationError("image must be a local /api/files reference or valid image dataURL");
    })();
    const id = nanoid6(10);
    const asset = {
      id,
      name: name.trim(),
      category,
      image: imageUrl,
      ...sourceNote ? { sourceNote } : {},
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    writeJsonAtomicSync(assetPath(id), asset);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(err instanceof ImageValidationError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
assetsRouter.patch("/:id", (req, res) => {
  const id = req.params.id;
  const filePath = assetPath(id);
  if (!fs7.existsSync(filePath)) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  const { name } = req.body;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  try {
    const asset = JSON.parse(fs7.readFileSync(filePath, "utf-8"));
    asset.name = name.trim();
    writeJsonAtomicSync(filePath, asset);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
assetsRouter.delete("/:id", (req, res) => {
  const id = req.params.id;
  const filePath = assetPath(id);
  if (!fs7.existsSync(filePath)) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  try {
    fs7.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// server/index.ts
var app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// --- simple in-memory rate limiter ---
var RATE_WINDOW_MS = 60 * 1e3;
var RATE_MAX = 5;
var rateBuckets = /* @__PURE__ */ new Map();
function rateLimitMiddleware(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_MAX) {
    res.status(429).json({ error: "Too many requests, please slow down", retryAfter: Math.ceil((bucket.resetAt - now) / 1e3) });
    return;
  }
  next();
}
// --- end rate limiter ---

app.get("/api/health", (_req, res) => res.json({ ok: true, status: "alive" }));
app.use("/api/generate", rateLimitMiddleware, generateRouter);
app.use("/api/run-plan", rateLimitMiddleware, runPlanRouter);
app.use("/api/files", filesRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/assets", assetsRouter);
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
function readiness() {
  const checks = {
    dataDirWritable: dataDirWritable(),
    frontend: !isProduction || apiOnly || fs8.existsSync(distIndex),
    aiConfigured: config.aiConfigReady()
  };
  return { ok: Object.values(checks).every(Boolean), checks, mode: apiOnly ? "api-only" : "full" };
}
app.get("/api/ready", (_req, res) => {
  const ready = readiness();
  res.status(ready.ok ? 200 : 503).json(ready);
});
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
var initialReadiness = readiness();
if (!initialReadiness.ok) {
  throw new Error(`Server is not ready: ${JSON.stringify(initialReadiness.checks)}`);
}
app.listen(port, () => {
  console.log(`[garment-canvas] server listening on http://localhost:${port} (${initialReadiness.mode})`);
});
