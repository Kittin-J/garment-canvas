/**
 * 图片文件存储助手：save（dataURL → 磁盘）、resolve（/api/files/:id → dataURL）。
 * files 路由与 generate 路由共用，保证全链路图片既可以 URL 引用也可以 dataURL 传递。
 */
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import { nanoid } from "nanoid";
import sharp from "sharp";
import { config } from "../config";
import { toDataUrl } from "../providers/base";
import { withImageProcessingSlot } from "./imageProcessingLimit";
import { MAX_IMAGE_BYTES, detectImageMime, validateImageDataUrl } from "./imageValidation";

const MAX_THUMBNAIL_INPUT_PIXELS = 40_000_000;

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export function uploadsDir(): string {
  const dir = path.join(config.dataDir(), "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function thumbnailsDir(): string {
  const dir = path.join(config.dataDir(), "thumbnails");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const thumbnailJobs = new Map<string, Promise<string>>();

/** 原图保持不可变；缩略图是可随时重建的 WebP 缓存，不写入业务数据库。 */
export async function ensureThumbnail(id: string): Promise<string> {
  if (!isSupportedImageFile(id) || path.basename(id) !== id) throw new Error("invalid file id");
  const source = path.join(uploadsDir(), id);
  if (!fs.existsSync(source)) throw new Error("file not found");
  const target = path.join(thumbnailsDir(), `${id}.webp`);
  const existing = thumbnailJobs.get(id);
  if (existing) return existing;
  const job = (async () => {
    const sourceStat = fs.statSync(source);
    if (fs.existsSync(target) && fs.statSync(target).mtimeMs >= sourceStat.mtimeMs) return target;
    const temporary = path.join(thumbnailsDir(), `.${id}.${nanoid(6)}.tmp.webp`);
    try {
      await withImageProcessingSlot(async () => {
        await sharp(source, {
          animated: false,
          failOn: "error",
          limitInputPixels: MAX_THUMBNAIL_INPUT_PIXELS,
        })
          .rotate()
          .resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 78, effort: 4 })
          .toFile(temporary);
      });
      fs.renameSync(temporary, target);
      return target;
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort */ }
    }
  })().finally(() => thumbnailJobs.delete(id));
  thumbnailJobs.set(id, job);
  return job;
}

export function thumbnailUrlForImage(ref: string): string {
  const match = /^\/api\/files\/([^/?#]+)$/.exec(ref);
  return match ? `/api/files/${match[1]}/thumbnail` : ref;
}

/** 删除仅由失败 run 产生的原图和可重建缩略图缓存。 */
export function deleteStoredImage(id: string): void {
  if (!isSupportedImageFile(id) || path.basename(id) !== id) return;
  for (const filePath of [path.join(uploadsDir(), id), path.join(thumbnailsDir(), `${id}.webp`)]) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best-effort cleanup */ }
  }
}

/** dataURL 存盘，返回 { id, url } */
export function saveDataUrl(dataUrl: string): { id: string; url: string } {
  const { mime, buffer } = validateImageDataUrl(dataUrl);
  const ext = MIME_EXT[mime];
  const id = `${nanoid(12)}.${ext}`;
  const filePath = path.join(uploadsDir(), id);
  const fd = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, buffer);
    fs.fsyncSync(fd);
  } catch (error) {
    try {
      fs.unlinkSync(filePath);
    } catch {
      // best-effort cleanup
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return { id, url: `/api/files/${id}` };
}

/** /api/files/:id 读取为 dataURL；非文件引用（已是 dataURL 或 http URL）原样返回 */
export function resolveToDataUrl(ref: string): string {
  if (!ref.startsWith("/api/files/")) return ref;
  const id = path.basename(ref);
  const filePath = path.join(uploadsDir(), id);
  if (!fs.existsSync(filePath)) {
    throw new Error(`referenced file not found: ${id}`);
  }
  const ext = path.extname(id).slice(1).toLowerCase();
  const expectedMime = EXT_MIME[ext];
  if (!expectedMime) throw new Error(`unsupported referenced file type: ${ext}`);
  const buffer = fs.readFileSync(filePath);
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`referenced image too large: ${id}`);
  const mime = detectImageMime(buffer);
  if (!mime || mime !== expectedMime) throw new Error(`referenced file is not a valid ${expectedMime} image: ${id}`);
  const base64 = buffer.toString("base64");
  return `data:${mime};base64,${base64}`;
}

export function mimeOfFile(id: string): string {
  const ext = path.extname(id).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? "image/png";
}

export function isSupportedImageFile(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(EXT_MIME, path.extname(id).slice(1).toLowerCase());
}

// ---------- 图片来源归一化（Provider URL 结果 / 链式编辑输入统一为 dataURL）----------

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024; // 20MB
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export type HostLookup = (hostname: string) => Promise<readonly string[]>;
export interface ImageResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}
export type ImageFetch = (input: string | URL, init?: RequestInit) => Promise<ImageResponse>;

function ipv4Number(address: string): number | null {
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

function inV4Cidr(value: number, base: number, prefix: number): boolean {
  const block = 2 ** (32 - prefix);
  return Math.floor(value / block) === Math.floor(base / block);
}

function expandIpv6(address: string): number[] | null {
  const pieces = address.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (pieces.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}

/** True only for globally routable unicast addresses accepted by remote image fetches. */
export function isGlobalIpAddress(raw: string): boolean {
  let address = raw.toLowerCase().split("%")[0];
  if (address.startsWith("::") && address.includes(".")) {
    const embedded = address.slice(address.lastIndexOf(":") + 1);
    return isGlobalIpAddress(embedded);
  }
  if (address.startsWith("::ffff:")) {
    const mapped = address.slice(7);
    // Node may normalize mapped dotted IPv4 as ::ffff:7f00:1; handle both forms.
    if (isIP(mapped) === 4) return isGlobalIpAddress(mapped);
    const groups = mapped.split(":");
    if (groups.length === 2 && groups.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const value = (Number.parseInt(groups[0], 16) * 65536 + Number.parseInt(groups[1], 16)) >>> 0;
      return isGlobalIpAddress(`${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`);
    }
    return false;
  }

  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    if (value === null) return false;
    // RFC 6890 non-global ranges, including documentation, benchmarking and multicast.
    const blocked: Array<[string, number]> = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ];
    return !blocked.some(([base, prefix]) => inV4Cidr(value, ipv4Number(base)!, prefix));
  }
  if (isIP(address) !== 6) return false;
  const groups = expandIpv6(address);
  if (!groups) return false;
  const first = groups[0];
  if (address === "::" || address === "::1") return false;
  if (first === 0 && groups.slice(1, 5).every((group) => group === 0)) return false; // IPv4-compatible/unspecified low space
  if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 ULA
  if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return false; // documentation 2001:db8::/32
  if (first === 0x2001 && groups[1] === 0) return false; // 2001:0000::/32 Teredo/special
  if (first === 0x2002) return false; // 6to4 may tunnel to an otherwise-blocked IPv4 target
  return true;
}

async function defaultHostLookup(hostname: string): Promise<readonly string[]> {
  return (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

/**
 * 将已通过 SSRF 校验的固定地址交给 Node 的连接器。Node 22 的 Happy Eyeballs
 * 路径会以 `all: true` 请求地址数组；旧版/单地址路径仍使用 address + family。
 */
export function createPinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  if (family !== 4 && family !== 6) throw new Error(`invalid pinned IP address: ${address}`);
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

/**
 * 生产连接器：校验后固定连接到本次 DNS 解析出的 global 地址，并用原 hostname 做
 * Host/SNI。这样校验与真正连接之间不会再次解析域名，关闭 DNS rebinding 的 TOCTOU。
 */
async function pinnedFetch(
  u: URL,
  init: RequestInit,
  address: string,
): Promise<ImageResponse> {
  return await new Promise<ImageResponse>((resolve, reject) => {
    const client = u.protocol === "https:" ? https : http;
    const request = client.request(
      u,
      {
        method: "GET",
        headers: { accept: "image/*", host: u.host },
        signal: init.signal ?? undefined,
        lookup: createPinnedLookup(address),
        ...(u.protocol === "https:" ? { servername: u.hostname } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        let settled = false;
        response.on("data", (chunk: Buffer | string) => {
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
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/** SSRF 防护：禁止本机、内网与云元数据地址 */
export async function assertUrlAllowed(raw: string | URL, lookup: HostLookup = defaultHostLookup): Promise<URL> {
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

/** 下载远程图片 → dataURL（校验类型、体积、超时，重定向目标同样过 SSRF 检查） */
export async function downloadImageToDataUrl(
  raw: string,
  dependencies?: { lookup?: HostLookup; fetch?: ImageFetch },
): Promise<string> {
  const lookup = dependencies?.lookup ?? defaultHostLookup;
  const fetcher = dependencies?.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let u = await assertUrlAllowed(raw, lookup);
    let res: ImageResponse | undefined;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      // Re-resolve immediately before every connection; all results are revalidated.
      const addresses = isIP(u.hostname) ? [u.hostname] : await lookup(u.hostname);
      const blocked = addresses.find((address) => !isGlobalIpAddress(address));
      if (addresses.length === 0 || blocked) throw new Error(`blocked non-global address for ${u.hostname}: ${blocked ?? "no addresses"}`);
      res = fetcher
        ? await fetcher(u, { signal: ctrl.signal, redirect: "manual" })
        : await pinnedFetch(u, { signal: ctrl.signal, redirect: "manual" }, addresses[0]);
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

/**
 * 任意图片引用归一化为 dataURL：
 * - data: 原样返回
 * - /api/files/:id 读取本地文件
 * - http(s):// 下载（带 SSRF / 体积 / 超时防护）
 * 其余引用一律拒绝，保证 Provider 只收到确定的图片数据。
 */
export async function normalizeImageRef(ref: string): Promise<string> {
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

/** 结果图片归一化并落盘为 /api/files/:id（项目 JSON 中不保存 dataURL 或第三方临时 URL） */
export async function persistImageRef(ref: string): Promise<string> {
  if (ref.startsWith("/api/files/")) return ref;
  const dataUrl = await normalizeImageRef(ref);
  return saveDataUrl(dataUrl).url;
}
