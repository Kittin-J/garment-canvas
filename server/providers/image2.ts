/**
 * API易 gpt-image-2-all —— OpenAI Images 兼容接口。
 * 有参考图走 /v1/images/edits（multipart form），无参考图走 /v1/images/generations（JSON）。
 */
import {
  MAX_REFERENCE_IMAGES,
  type AIProvider,
  type ImageGenRequest,
  type ImageGenResult,
} from "../../src/types/workflow";
import { config } from "../config";
import { aspectRatioToSize, fetchWithRetry, parseDataUrl, ProviderError } from "./base";
import { parseGptImagesPngResponse } from "./gptImagesResponse";
import {
  prepareApiyiReferenceUploads,
  prepareImage2ReferenceUpload,
  promptWithImageLayout,
} from "./image2References";

const PROVIDER_ID = "gpt-image-2";

const ASPECT_RATIO_PROMPT: Record<string, string> = {
  "1:1": "1:1 方形构图",
  "3:4": "3:4 竖版构图",
  "4:3": "4:3 横版构图",
  "9:16": "竖屏 9:16",
  "16:9": "横版 16:9",
};

function promptWithAspectRatio(prompt: string, aspectRatio?: string): string {
  const prefix = aspectRatio ? ASPECT_RATIO_PROMPT[aspectRatio] : undefined;
  return prefix ? `${prefix}，${prompt}` : prompt;
}

function usesApiyiAllContract(): boolean {
  return config.image2Model() === "gpt-image-2-all";
}

export const image2Provider: AIProvider = {
  id: PROVIDER_ID,

  /** 无参考图：/v1/images/generations */
  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const capabilities = config.image2Capabilities();
    const apiyiAll = usesApiyiAllContract();
    const url = `${config.apiyiBaseUrl()}/images/generations`;
    const res = await fetchWithRetry(
      url,
      () => ({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiyiApiKey()}`,
        },
        body: JSON.stringify({
          model: config.image2Model(),
          prompt: apiyiAll ? promptWithAspectRatio(req.prompt, req.aspectRatio) : req.prompt,
          ...(apiyiAll
            ? { response_format: "b64_json" }
            : {
              ...(capabilities.supportsBatchN
                ? { n: Math.max(1, Math.min(req.batchSize ?? 1, capabilities.maxBatchSize)) }
                : {}),
              size: aspectRatioToSize(req.aspectRatio),
              quality: "low",
              output_format: "png",
            }),
        }),
      }),
      { providerId: PROVIDER_ID },
    );
    const json: unknown = await res.json();
    return { images: await parseGptImagesPngResponse(json, PROVIDER_ID), model: config.image2Model() };
  },

  /** 有参考图：/v1/images/edits，multipart form 上传 */
  async edit(req: ImageGenRequest): Promise<ImageGenResult> {
    if (!req.referenceImages?.length) {
      throw new ProviderError("edit requires referenceImages", 400, PROVIDER_ID);
    }
    const capabilities = config.image2Capabilities();
    const apiyiAll = usesApiyiAllContract();
    const maxReferences = Math.min(MAX_REFERENCE_IMAGES, capabilities.maxReferenceImages);
    if (req.referenceImages.length > maxReferences) {
      throw new ProviderError(`当前 AI 服务最多支持 ${maxReferences} 张参考图`, 400, PROVIDER_ID, "invalid_request");
    }
    if (req.referenceImages.length > 1 && !capabilities.supportsMultiReference) {
      throw new ProviderError("当前 AI 服务未开启多参考图，请只保留一张参考图", 400, PROVIDER_ID, "invalid_request");
    }
    if (!apiyiAll && req.referenceImages.length > 1 && req.mask) {
      throw new ProviderError("多参考图拼图暂不支持蒙版，请移除蒙版或只保留一张参考图", 400, PROVIDER_ID, "invalid_request");
    }
    if (apiyiAll && req.mask) {
      throw new ProviderError("当前 API易模型不支持蒙版编辑，请移除蒙版后重试", 400, PROVIDER_ID, "invalid_request");
    }
    const referenceUploads = apiyiAll ? await prepareApiyiReferenceUploads(req.referenceImages) : undefined;
    const referenceUpload = apiyiAll ? undefined : await prepareImage2ReferenceUpload(req.referenceImages);
    const prompt = apiyiAll
      ? promptWithAspectRatio(req.prompt, req.aspectRatio)
      : promptWithImageLayout(req.prompt, req.referenceImages.length);
    const url = `${config.apiyiBaseUrl()}/images/edits`;

    const res = await fetchWithRetry(
      url,
      () => {
        // 每次重试需重建 FormData（body 只能消费一次）
        const form = new FormData();
        form.append("model", config.image2Model());
        form.append("prompt", prompt);
        if (apiyiAll) {
          form.append("response_format", "b64_json");
          for (const upload of referenceUploads ?? []) {
            form.append(
              "image",
              new Blob([new Uint8Array(upload.buffer)], { type: upload.mime }),
              upload.filename,
            );
          }
        } else if (referenceUpload) {
          if (req.aspectRatio) form.append("size", aspectRatioToSize(req.aspectRatio));
          form.append("quality", "low");
          form.append("output_format", "png");
          if (capabilities.supportsBatchN) {
            form.append("n", String(Math.max(1, Math.min(req.batchSize ?? 1, capabilities.maxBatchSize))));
          }
          form.append(
            "image",
            new Blob([new Uint8Array(referenceUpload.buffer)], { type: referenceUpload.mime }),
            referenceUpload.filename,
          );
          if (req.mask) {
            const { mime, buffer } = parseDataUrl(req.mask);
            form.append("mask", new Blob([new Uint8Array(buffer)], { type: mime }), "mask.png");
          }
        }
        return {
          method: "POST",
          headers: { Authorization: `Bearer ${config.apiyiApiKey()}` },
          body: form,
        };
      },
      { providerId: PROVIDER_ID },
    );
    const json: unknown = await res.json();
    return { images: await parseGptImagesPngResponse(json, PROVIDER_ID), model: config.image2Model() };
  },
};
