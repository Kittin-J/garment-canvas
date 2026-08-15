import sharp from "sharp";
import { withImageProcessingSlot } from "../lib/imageProcessingLimit";
import { validateImageDataUrl } from "../lib/imageValidation";
import { ProviderError, providerErrorFromMessage } from "./base";

const INVALID_IMAGE_RESPONSE_MESSAGE = "AI 服务返回了无效图片，请稍后重试；如持续失败请联系管理员";
const MAX_PROVIDER_RESPONSE_PIXELS = 40_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidImageResponse(providerId: string, location: string, reason: string): ProviderError {
  return new ProviderError(
    INVALID_IMAGE_RESPONSE_MESSAGE,
    502,
    providerId,
    "invalid_response",
    `Images response ${location}: ${reason}`,
  );
}

async function parsePngBase64(value: unknown, providerId: string, index: number): Promise<string> {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidImageResponse(providerId, `item ${index}`, "b64_json must be a non-empty string");
  }
  try {
    const validated = validateImageDataUrl(`data:image/png;base64,${value}`);
    // metadata() can accept a valid PNG header with a truncated IDAT stream. Decode every pixel
    // under the shared Sharp semaphore so only complete, bounded PNGs cross the provider boundary.
    await withImageProcessingSlot(async () => {
      await sharp(validated.buffer, {
        animated: false,
        failOn: "warning",
        limitInputPixels: MAX_PROVIDER_RESPONSE_PIXELS,
      }).raw().toBuffer();
    });
    return `data:image/png;base64,${validated.buffer.toString("base64")}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "PNG validation failed";
    throw invalidImageResponse(providerId, `item ${index}`, reason);
  }
}

function parseImageUrl(value: unknown, providerId: string, index: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalidImageResponse(providerId, `item ${index}`, "url must be a non-empty string");
  }
  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("unsupported protocol");
  } catch {
    // Do not include the URL in diagnostics: it may contain a signed query string.
    throw invalidImageResponse(providerId, `item ${index}`, "url must be an absolute HTTP(S) URL");
  }
  return normalized;
}

/**
 * Parse GPT Images responses when the request explicitly selected `output_format=png`.
 * Base64 payloads are validated here because their MIME contract is provider-specific.
 * HTTP(S) URLs are only shape-checked; the single download/SSRF/MIME boundary remains fileStore.
 */
export async function parseGptImagesPngResponse(payload: unknown, providerId: string): Promise<string[]> {
  if (!isRecord(payload)) {
    throw invalidImageResponse(providerId, "body", "expected a JSON object");
  }

  if (payload.error !== undefined && payload.error !== null) {
    if (!isRecord(payload.error)) {
      throw invalidImageResponse(providerId, "error", "expected an error object");
    }
    const code = payload.error.code;
    const message = typeof payload.error.message === "string" ? payload.error.message : "images api error";
    const rawMessage = typeof code === "string" ? `${code}: ${message}` : message;
    const status = typeof code === "number" && Number.isInteger(code) && code >= 400 && code < 600
      ? code
      : undefined;
    throw providerErrorFromMessage(rawMessage, providerId, status);
  }

  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    throw new ProviderError("AI 服务未返回图片，请重试", 502, providerId, "empty_response");
  }

  const images: string[] = [];
  for (let index = 0; index < payload.data.length; index += 1) {
    const item = payload.data[index];
    if (!isRecord(item)) {
      throw invalidImageResponse(providerId, `item ${index}`, "expected an object");
    }
    if (Object.prototype.hasOwnProperty.call(item, "b64_json")) {
      images.push(await parsePngBase64(item.b64_json, providerId, index));
    } else if (Object.prototype.hasOwnProperty.call(item, "url")) {
      images.push(parseImageUrl(item.url, providerId, index));
    } else {
      throw invalidImageResponse(providerId, `item ${index}`, "expected b64_json or url");
    }
  }
  return images;
}
