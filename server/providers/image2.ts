/**
 * gpt-image-2 —— OpenAI 兼容接口。
 * 有参考图走 /v1/images/edits（multipart form），无参考图走 /v1/images/generations（JSON）。
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

const PROVIDER_ID = "gpt-image-2";

interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

function parseImagesResponse(json: ImagesApiResponse): string[] {
  if (json.error) {
    throw providerErrorFromMessage(json.error.message ?? "images api error", PROVIDER_ID);
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

export const image2Provider: AIProvider = {
  id: PROVIDER_ID,

  /** 无参考图：/v1/images/generations */
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const capabilities = config.image2Capabilities();
    const url = `${config.change2proBaseUrl()}/images/generations`;
    const res = await fetchWithRetry(
      url,
      () => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.change2proApiKey()}`,
        },
        body: JSON.stringify({
          model: config.image2Model(),
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
    return { images: parseImagesResponse(json), model: config.image2Model() };
  },

  /** 有参考图：/v1/images/edits，multipart form 上传 */
  async edit(req: ImageGenRequest): Promise<ImageGenResult> {
    if (!req.referenceImages?.length) {
      throw new ProviderError("edit requires referenceImages", 400, PROVIDER_ID);
    }
    const capabilities = config.image2Capabilities();
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
        // 每次重试需重建 FormData（body 只能消费一次）
        const form = new FormData();
        form.append("model", config.image2Model());
        form.append("prompt", req.prompt);
        form.append("size", aspectRatioToSize(req.aspectRatio));
        if (capabilities.supportsBatchN) {
          form.append("n", String(Math.max(1, Math.min(req.batchSize ?? 1, capabilities.maxBatchSize))));
        }
        req.referenceImages!.forEach((ref, i) => {
          const { mime, buffer } = parseDataUrl(ref);
          const ext = mime.split("/")[1] ?? "png";
          form.append(capabilities.supportsImageArray ? "image[]" : "image", new Blob([new Uint8Array(buffer)], { type: mime }), `ref-${i}.${ext}`);
        });
        if (req.mask) {
          const { mime, buffer } = parseDataUrl(req.mask);
          form.append("mask", new Blob([new Uint8Array(buffer)], { type: mime }), "mask.png");
        }
        return {
          method: "POST",
          headers: { Authorization: `Bearer ${config.change2proApiKey()}` },
          body: form,
        };
      },
      { providerId: PROVIDER_ID },
    );
    const json = (await res.json()) as ImagesApiResponse;
    return { images: parseImagesResponse(json), model: config.image2Model() };
  },
};
