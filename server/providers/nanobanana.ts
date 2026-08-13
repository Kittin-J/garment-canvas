/**
 * nanobanana —— 使用独立分组 Key 的 OpenAI Images 兼容接口。
 * 无参考图走 /images/generations，有参考图走 /images/edits。
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

interface ImagesApiResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string; code?: number };
}

const PROVIDER_ID = "nanobanana";

async function generateOnce(req: ImageGenRequest): Promise<string[]> {
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
        n: 1,
        size: aspectRatioToSize(req.aspectRatio),
        quality: "low",
        output_format: "png",
      }),
    }),
    { providerId: PROVIDER_ID },
  );

  const json = (await res.json()) as ImagesApiResponse;
  if (json.error) {
    throw new ProviderError(json.error.message ?? "images api error", json.error.code, PROVIDER_ID);
  }

  const images: string[] = [];
  for (const item of json.data ?? []) {
    if (item.b64_json) images.push(toDataUrl(item.b64_json));
    else if (item.url) images.push(item.url);
  }
  if (images.length === 0) {
    throw new ProviderError("nanobanana returned no image", undefined, PROVIDER_ID);
  }
  return images;
}

export const nanobananaProvider: AIProvider = {
  id: PROVIDER_ID,

  /** 文生图；batchSize 通过多次调用实现 */
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const n = Math.max(1, Math.min(req.batchSize ?? 1, 4));
    const settled = await Promise.all(Array.from({ length: n }, () => generateOnce(req)));
    return {
      images: settled.flat(),
      model: config.nanobananaModel(),
    };
  },

  /** 图生图：使用 /images/edits multipart 接口。 */
  async edit(req: ImageGenRequest): Promise<ImageGenResult> {
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
        req.referenceImages!.forEach((ref, index) => {
          const { mime, buffer } = parseDataUrl(ref);
          const ext = mime.split("/")[1] ?? "png";
          form.append(
            "image",
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
      throw new ProviderError(json.error.message ?? "images api error", json.error.code, PROVIDER_ID);
    }
    const images: string[] = [];
    for (const item of json.data ?? []) {
      if (item.b64_json) images.push(toDataUrl(item.b64_json));
      else if (item.url) images.push(item.url);
    }
    if (images.length === 0) {
      throw new ProviderError("nanobanana returned no image", undefined, PROVIDER_ID);
    }
    return { images, model: config.nanobananaModel() };
  },
};
