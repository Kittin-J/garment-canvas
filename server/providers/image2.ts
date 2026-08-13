/**
 * gpt-image-2 —— OpenAI 兼容接口。
 * 有参考图走 /v1/images/edits（multipart form），无参考图走 /v1/images/generations（JSON）。
 */
import type { AIProvider, ImageGenRequest, ImageGenResult } from "../../src/types/workflow";
import { config } from "../config";
import {
  aspectRatioToSize,
  fetchWithRetry,
  parseDataUrl,
  toDataUrl,
  ProviderError,
} from "./base";

const PROVIDER_ID = "gpt-image-2";

interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

function parseImagesResponse(json: ImagesApiResponse): string[] {
  if (json.error) {
    throw new ProviderError(json.error.message ?? "images api error", undefined, PROVIDER_ID);
  }
  const images: string[] = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) images.push(toDataUrl(item.b64_json));
    else if (item.url) images.push(item.url);
  }
  if (images.length === 0) {
    throw new ProviderError("gpt-image-2 returned no image", undefined, PROVIDER_ID);
  }
  return images;
}

export const image2Provider: AIProvider = {
  id: PROVIDER_ID,

  /** 无参考图：/v1/images/generations */
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
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
          n: Math.max(1, Math.min(req.batchSize ?? 1, 4)),
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
    const url = `${config.change2proBaseUrl()}/images/edits`;

    const res = await fetchWithRetry(
      url,
      () => {
        // 每次重试需重建 FormData（body 只能消费一次）
        const form = new FormData();
        form.append("model", config.image2Model());
        form.append("prompt", req.prompt);
        form.append("size", aspectRatioToSize(req.aspectRatio));
        form.append("n", String(Math.max(1, Math.min(req.batchSize ?? 1, 4))));
        req.referenceImages!.forEach((ref, i) => {
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
          body: form,
        };
      },
      { providerId: PROVIDER_ID },
    );
    const json = (await res.json()) as ImagesApiResponse;
    return { images: parseImagesResponse(json), model: config.image2Model() };
  },
};
