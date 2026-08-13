/**
 * Provider 层共用辅助：错误类型、超时重试 fetch、dataURL 工具。
 * 类型契约从 src/types/workflow.ts 导入，不在此处重复定义。
 */
import { config } from "../config";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class NotImplementedError extends ProviderError {
  constructor(feature: string) {
    super(`Not implemented: ${feature}`);
    this.name = "NotImplementedError";
  }
}

/** 4xx 不重试，5xx / 网络错误 / 超时按 maxRetries 重试，指数退避 */
export async function fetchWithRetry(
  url: string,
  initFactory: () => RequestInit,
  opts?: { timeoutMs?: number; maxRetries?: number; providerId?: string },
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? config.aiTimeoutMs();
  const maxRetries = opts?.maxRetries ?? config.aiMaxRetries();

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(500 * 2 ** (attempt - 1));
    }
    try {
      const res = await fetch(url, {
        ...initFactory(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status >= 400 && res.status < 500) {
        // 4xx：读取错误体后直接抛出，不重试
        const body = await res.text().catch(() => "");
        throw new ProviderError(
          `HTTP ${res.status}: ${body.slice(0, 500)}`,
          res.status,
          opts?.providerId,
        );
      }
      if (res.status >= 500) {
        const body = await res.text().catch(() => "");
        lastError = new ProviderError(
          `HTTP ${res.status}: ${body.slice(0, 500)}`,
          res.status,
          opts?.providerId,
        );
        continue; // 5xx 重试
      }
      return res;
    } catch (err) {
      if (err instanceof ProviderError && err.status !== undefined && err.status < 500) {
        throw err; // 4xx 不重试
      }
      lastError = err; // 网络错误 / 超时 / 5xx → 重试
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ProviderError(String(lastError), undefined, opts?.providerId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- dataURL 工具 ----------

export interface ParsedDataUrl {
  mime: string;
  base64: string;
  buffer: Buffer;
}

/** 解析 "data:image/png;base64,xxxx" */
export function parseDataUrl(dataUrl: string): ParsedDataUrl {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !m[2]) {
    throw new ProviderError("Invalid dataURL (expected base64)");
  }
  const mime = m[1] || "image/png";
  const base64 = m[3];
  return { mime, base64, buffer: Buffer.from(base64, "base64") };
}

export function toDataUrl(base64: string, mime = "image/png"): string {
  return `data:${mime};base64,${base64}`;
}

/** aspectRatio → gpt-image size 映射 */
export function aspectRatioToSize(aspectRatio?: string): string {
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
