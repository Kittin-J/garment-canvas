/**
 * nanobanana —— 使用独立分组 Key 的 OpenAI Images 兼容接口。
 * 无参考图走 /images/generations，有参考图走 /images/edits。
 */
import {
  MAX_REFERENCE_IMAGES,
  type AIProvider,
  type ImageGenRequest,
  type ImageGenResult,
} from "../../src/types/workflow";
import { config } from "../config";
import {
  aspectRatioToSize,
  fetchWithRetry,
  parseDataUrl,
  toDataUrl,
  ProviderError,
  providerErrorFromMessage,
} from "./base";

interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string; code?: number };
}

const PROVIDER_ID = "nanobanana";

async function generateOnce(req: ImageGenRequest): Promise<string[]> {
  const capabilities = config.nanobananaCapabilities();
  const url = `${config.change2proBaseUrl()}/images/generations`;
  const res = await fetchWithRetry(
    url,
    () => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.nanobananaApiKey()}`,
      },
      body: JSON.stringify({
        model: config.nanobananaModel(),
        prompt: req.prompt,
        ...(capabilities.supportsBatchN
          ? { n: Math.max(1, Math.min(req.batchSize ?? 1, capabilities.maxBatchSize)) }
          : {}),
        size: aspectRatioToSize(req.aspectRatio),
        quality: "low",
        output_format: "png",
      }),
    }),
    { providerId: PROVIDER_ID },
  );

  const json = (await res.json()) as ImagesApiResponse;
  if (json.error) {
    throw providerErrorFromMessage(json.error.message ?? "images api error", PROVIDER_ID, json.error.code);
  }

  const images: string[] = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) images.push(toDataUrl(item.b64_json));
    else if (item.url) images.push(item.url);
  }
  if (images.length === 0) {
    throw new ProviderError("AI 服务未返回图片，请重试", 502, PROVIDER_ID, "empty_response");
  }
  return images;
}

export const nanobananaProvider: AIProvider = {
  id: PROVIDER_ID,

  /** 文生图；不支持批量 n 的网关由 generateExactImages 在上层按缺口补发。 */
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    return {
      images: await generateOnce(req),
      model: config.nanobananaModel(),
    };
  },

  /** 图生图：使用 /images/edits multipart 接口。 */
  async edit(req: ImageGenRequest): Promise<ImageGenResult> {
    if (!req.referenceImages?.length) {
      throw new ProviderError("edit requires referenceImages", 400, PROVIDER_ID);
    }
    const capabilities = config.nanobananaCapabilities();
    const maxReferences = Math.min(MAX_REFERENCE_IMAGES, capabilities.maxReferenceImages);
    if (req.referenceImages.length > maxReferences) {
      throw new ProviderError(`当前 AI 服务最多支持 ${maxReferences} 张参考图`, 400, PROVIDER_ID, "invalid_request");
    }
    if (req.referenceImages.length > 1 && (!capabilities.supportsMultiReference || !capabilities.supportsImageArray)) {
      throw new ProviderError("当前 AI 服务不支持多参考图，请只保留一张参考图", 400, PROVIDER_ID, "invalid_request");
    }
    const url = `${config.change2proBaseUrl()}/images/edits`;
    const res = await fetchWithRetry(
      url,
      () => {
        const form = new FormData();
        form.append("model", config.nanobananaModel());
        form.append("prompt", req.prompt);
        form.append("size", aspectRatioToSize(req.aspectRatio));
        if (capabilities.supportsBatchN) {
          form.append("n", String(Math.max(1, Math.min(req.batchSize ?? 1, capabilities.maxBatchSize))));
        }
        req.referenceImages!.forEach((ref, index) => {
          const { mime, buffer } = parseDataUrl(ref);
          const ext = mime.split("/")[1] ?? "png";
          form.append(
            capabilities.supportsImageArray ? "image[]" : "image",
            new Blob([new Uint8Array(buffer)], { type: mime }),
            `ref-${index}.${ext}`,
          );
        });
        if (req.mask) {
          const { mime, buffer } = parseDataUrl(req.mask);
          form.append("mask", new Blob([new Uint8Array(buffer)], { type: mime }), "mask.png");
        }
        return {
          method: "POST",
          headers: { Authorization: `Bearer ${config.nanobananaApiKey()}` },
          body: form,
        };
      },
      { providerId: PROVIDER_ID },
    );
    const json = (await res.json()) as ImagesApiResponse;
    if (json.error) {
      throw providerErrorFromMessage(json.error.message ?? "images api error", PROVIDER_ID, json.error.code);
    }
    const images: string[] = [];
    for (const item of json.data ?? []) {
      if (item.b64_json) images.push(toDataUrl(item.b64_json));
      else if (item.url) images.push(item.url);
    }
    if (images.length === 0) {
      throw new ProviderError("AI 服务未返回图片，请重试", 502, PROVIDER_ID, "empty_response");
    }
    return { images, model: config.nanobananaModel() };
  },
};
