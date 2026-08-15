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
    public readonly category: ProviderErrorCategory = "unknown",
    /** 仅供服务端日志诊断，绝不返回浏览器或写入用户运行记录。 */
    public readonly diagnostic?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type ProviderErrorCategory =
  | "content_refused"
  | "model_unavailable"
  | "gateway_authentication"
  | "invalid_request"
  | "rate_limited"
  | "timeout"
  | "gateway_unavailable"
  | "empty_response"
  | "invalid_response"
  | "unknown";

function classifyProviderMessage(status: number | undefined, rawMessage: string): {
  category: ProviderErrorCategory;
  publicMessage: string;
} {
  const message = rawMessage
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (status === 401 || status === 403) {
    return {
      category: "gateway_authentication",
      publicMessage: "AI 网关鉴权失败，请联系管理员检查 API Key 或账号权限",
    };
  }
  const contentRefused =
    /content\s*(policy|filter)|content management policy|responsible\s*ai\s*policy\s*violation/i.test(message) ||
    /(safety system|moderation).{0,50}(block|filter|reject|refus)/i.test(message) ||
    /(block|filter|reject|refus).{0,50}(safety system|moderation|content management policy)/i.test(message) ||
    /内容.{0,12}(安全|审核|政策|过滤).{0,12}(拦截|过滤|拒绝|违规)|内容.{0,10}(拒绝|违规)/i.test(message);
  if (contentRefused) {
    return {
      category: "content_refused",
      publicMessage: "本次请求未通过 AI 安全审核，请调整提示词或参考图片后重试",
    };
  }
  if (/model.{0,40}(not found|does not exist|unsupported|not available|invalid)|unknown model|模型.{0,10}(不存在|不可用|不支持)/i.test(message)) {
    return {
      category: "model_unavailable",
      publicMessage: "当前 AI 模型不可用，请联系管理员检查模型配置",
    };
  }
  if (status === 429) {
    return { category: "rate_limited", publicMessage: "AI 服务当前繁忙，请稍后重试" };
  }
  if (status !== undefined && status >= 400 && status < 500) {
    return {
      category: "invalid_request",
      publicMessage: "AI 服务暂不支持当前参数或参考图组合，请调整后重试",
    };
  }
  if (status !== undefined && status >= 500) {
    return { category: "gateway_unavailable", publicMessage: "AI 服务暂时不可用，请稍后重试" };
  }
  return { category: "unknown", publicMessage: "AI 服务返回异常，请稍后重试" };
}

export function providerErrorFromResponse(status: number, responseBody: string, providerId?: string): ProviderError {
  const classified = classifyProviderMessage(status, responseBody);
  return new ProviderError(
    classified.publicMessage,
    status,
    providerId,
    classified.category,
    `HTTP ${status}: ${responseBody.slice(0, 2_000)}`,
  );
}

export function providerErrorFromMessage(message: string, providerId?: string, status?: number): ProviderError {
  const classified = classifyProviderMessage(status, message);
  return new ProviderError(classified.publicMessage, status, providerId, classified.category, message.slice(0, 2_000));
}

export function publicProviderErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "AI 服务响应超时，请稍后重试";
  }
  return "AI 服务暂时不可用，请稍后重试";
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
        throw providerErrorFromResponse(res.status, body, opts?.providerId);
      }
      if (res.status >= 500) {
        const body = await res.text().catch(() => "");
        lastError = providerErrorFromResponse(res.status, body, opts?.providerId);
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
  if (lastError instanceof ProviderError) throw lastError;
  if (lastError instanceof Error && (lastError.name === "TimeoutError" || lastError.name === "AbortError")) {
    throw new ProviderError(
      "AI 服务响应超时，请稍后重试",
      504,
      opts?.providerId,
      "timeout",
      lastError.message,
    );
  }
  throw new ProviderError(
    "AI 服务暂时不可用，请稍后重试",
    502,
    opts?.providerId,
    "gateway_unavailable",
    lastError instanceof Error ? lastError.message : String(lastError),
  );
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
