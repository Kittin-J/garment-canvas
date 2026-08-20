import sharp from "sharp";
import type { AIProvider, ImageGenRequest, ImageGenResult } from "../../src/types/workflow";
import {
  defaultImageModelOptions,
  getImageModelContract,
  imageModelOptionsError,
  modelMaximumImagesPerRequest,
  modelMaxReferenceImages,
  type ImageModelId,
  type ImageModelOptions,
} from "../../src/types/imageModels";
import { config } from "../config";
import { validateMaskForSource } from "../lib/maskProcessing";
import { detectImageMime, validateImageDataUrl } from "../lib/imageValidation";
import { withImageProcessingSlot } from "../lib/imageProcessingLimit";
import {
  fetchWithRetry,
  parseDataUrl,
  ProviderError,
  providerErrorFromMessage,
  toDataUrl,
} from "./base";

const PROVIDER_RESPONSE_PIXEL_LIMIT = 40_000_000;
const REFERENCE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FLUX_MAX_INPUT_PIXELS = 20_000_000;
const FLUX_MAX_INPUT_BYTES = 20 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requestOptions(modelId: ImageModelId, req: ImageGenRequest): ImageModelOptions {
  const options = req.modelOptions ?? defaultImageModelOptions(modelId, req.aspectRatio);
  const error = imageModelOptionsError(modelId, options);
  if (error) throw new ProviderError(`模型参数无效：${error}`, 400, modelId, "invalid_request");
  return options;
}

function referenceData(req: ImageGenRequest, modelId: ImageModelId): string[] {
  const refs = req.referenceImages ?? [];
  const max = modelMaxReferenceImages(modelId);
  if (refs.length > max) {
    throw new ProviderError(`${modelId} 最多支持 ${max} 张参考图`, 400, modelId, "invalid_request");
  }
  return refs;
}

function parsedReference(dataUrl: string, modelId: ImageModelId): ReturnType<typeof parseDataUrl> {
  try {
    const validated = validateImageDataUrl(dataUrl);
    if (!REFERENCE_MIMES.has(validated.mime)) {
      throw new ProviderError(`${modelId} 仅支持 PNG、JPEG 或 WebP 参考图`, 400, modelId, "invalid_request");
    }
    return {
      mime: validated.mime,
      base64: validated.buffer.toString("base64"),
      buffer: validated.buffer,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `${modelId} 参考图数据无效`,
      400,
      modelId,
      "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function fluxTargetDimensions(width: number, height: number): { width: number; height: number } {
  const contract = getImageModelContract("flux-2-pro").dimensions!;
  const scale = Math.min(1, Math.sqrt(contract.maxPixels / (width * height)));
  let targetWidth = Math.max(contract.minSide, Math.round((width * scale) / contract.multipleOf) * contract.multipleOf);
  let targetHeight = Math.max(contract.minSide, Math.round((height * scale) / contract.multipleOf) * contract.multipleOf);
  while (targetWidth * targetHeight > contract.maxPixels) {
    const widthScale = targetWidth / width;
    const heightScale = targetHeight / height;
    if (widthScale >= heightScale && targetWidth > contract.minSide) targetWidth -= contract.multipleOf;
    else if (targetHeight > contract.minSide) targetHeight -= contract.multipleOf;
    else break;
  }
  return { width: targetWidth, height: targetHeight };
}

/** FLUX 要求输入至少 64px、宽高为 16 的倍数且不超过 4MP。 */
export async function adaptFluxReference(dataUrl: string): Promise<string> {
  const modelId: ImageModelId = "flux-2-pro";
  const parsed = parsedReference(dataUrl, modelId);
  try {
    return await withImageProcessingSlot(async () => {
      const input = sharp(parsed.buffer, {
        animated: false, failOn: "error", limitInputPixels: FLUX_MAX_INPUT_PIXELS,
      });
      const metadata = await input.metadata();
      if (!metadata.width || !metadata.height) {
        throw new ProviderError("FLUX 参考图尺寸无效", 400, modelId, "invalid_request");
      }
      const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
      const width = swapsAxes ? metadata.height : metadata.width;
      const height = swapsAxes ? metadata.width : metadata.height;
      const target = fluxTargetDimensions(width, height);
      const alpha = metadata.hasAlpha
        ? await input.clone().rotate().ensureAlpha().extractChannel("alpha").raw().toBuffer()
        : undefined;
      const transparent = alpha?.some((value) => value < 255) ?? false;
      const transformed = sharp(parsed.buffer, {
        animated: false, failOn: "error", limitInputPixels: FLUX_MAX_INPUT_PIXELS,
      })
        .rotate()
        .resize({ width: target.width, height: target.height, fit: "fill" })
        .toColourspace("srgb");
      const output = transparent
        ? await transformed.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
        : await transformed.flatten({ background: "#ffffff" })
          .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
      if (output.byteLength > FLUX_MAX_INPUT_BYTES) {
        throw new ProviderError("FLUX 参考图处理后仍超过 20MB，请先裁剪图片", 400, modelId, "invalid_request");
      }
      return toDataUrl(output.toString("base64"), transparent ? "image/png" : "image/jpeg");
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "FLUX 参考图无法适配，请使用标准 PNG、JPEG 或 WebP 图片",
      400, modelId, "invalid_request",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function appendImages(form: FormData, refs: string[], modelId: ImageModelId): void {
  const editContract = getImageModelContract(modelId).edit;
  const field = refs.length === 1
    ? editContract.singleImageField
    : editContract.multipleImageField;
  if (!field) {
    throw new ProviderError(`${modelId} 缺少 multipart 图片字段契约`, 500, modelId, "invalid_request");
  }
  refs.forEach((ref, index) => {
    const parsed = parsedReference(ref, modelId);
    const extension = parsed.mime === "image/jpeg" ? "jpg" : parsed.mime.split("/")[1];
    form.append(
      field,
      new Blob([new Uint8Array(parsed.buffer)], { type: parsed.mime }),
      `image-${index + 1}.${extension}`,
    );
  });
}

function upstreamModelId(modelId: ImageModelId): string {
  return getImageModelContract(modelId).upstreamModelId;
}

function resolveContractPath(path: string, modelId: ImageModelId): string {
  return path.replace("{model}", encodeURIComponent(upstreamModelId(modelId)));
}

async function fetchApiyi(
  modelId: ImageModelId,
  path: string,
  initFactory: () => RequestInit,
): Promise<Response> {
  const timeout = getImageModelContract(modelId).timeoutMs;
  return fetchWithRetry(`${config.apiyiBaseUrl()}${resolveContractPath(path, modelId)}`, initFactory, {
    providerId: modelId,
    timeoutMs: config.aiTimeoutMs(timeout),
    maxRetries: 0,
  });
}

async function readJson(response: Response, modelId: ImageModelId): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError(
      "AI 响应中断或不完整，结果可能已经生成；系统不会自动重试",
      502, modelId, "outcome_unknown",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function imageUrl(value: unknown, modelId: ImageModelId, index: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProviderError("AI 服务返回了无效图片地址", 502, modelId, "invalid_response", `data[${index}].url invalid`);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
  } catch {
    throw new ProviderError("AI 服务返回了无效图片地址", 502, modelId, "invalid_response", `data[${index}].url invalid`);
  }
  return value;
}

async function base64Image(
  value: unknown,
  modelId: ImageModelId,
  mimeHint?: string,
): Promise<string> {
  if (typeof value !== "string" || !value) {
    throw new ProviderError("AI 服务返回了无效图片数据", 502, modelId, "invalid_response");
  }
  try {
    let buffer: Buffer;
    let mime: string;
    if (value.startsWith("data:")) {
      const validated = validateImageDataUrl(value);
      buffer = validated.buffer;
      mime = validated.mime;
    } else {
      buffer = Buffer.from(value, "base64");
      if (!buffer.length || buffer.toString("base64") !== value) {
        throw new ProviderError("AI 服务返回了损坏的图片数据", 502, modelId, "invalid_response");
      }
      const detected = detectImageMime(buffer);
      if (!detected) {
        throw new ProviderError("AI 服务返回了未知图片格式", 502, modelId, "invalid_response");
      }
      mime = detected;
    }
    if (!REFERENCE_MIMES.has(mime)) {
      throw new ProviderError("AI 服务返回了不支持的图片格式", 502, modelId, "invalid_response");
    }
    if (mimeHint && mime !== mimeHint) {
      throw new ProviderError("AI 服务返回图片的 MIME 与实际格式不一致", 502, modelId, "invalid_response");
    }
    await withImageProcessingSlot(async () => {
      await sharp(buffer, {
        animated: false, failOn: "warning", limitInputPixels: PROVIDER_RESPONSE_PIXEL_LIMIT,
      }).raw().toBuffer();
    });
    return toDataUrl(buffer.toString("base64"), mime);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "AI 服务返回了损坏的图片数据",
      502,
      modelId,
      "invalid_response",
      `image payload validation failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
    );
  }
}

function throwEmbeddedError(payload: Record<string, unknown>, modelId: ImageModelId): void {
  if (payload.error === undefined || payload.error === null) return;
  const detail = record(payload.error);
  const message = typeof detail?.message === "string" ? detail.message : "API易图片接口返回错误";
  const rawCode = detail?.code;
  const status = typeof rawCode === "number" ? rawCode : undefined;
  const classifierMessage = typeof rawCode === "string" ? `${rawCode}: ${message}` : message;
  throw providerErrorFromMessage(classifierMessage, modelId, status);
}

interface ParsedOpenAiImages {
  images: string[];
  providerOutputSizes?: Array<string | null>;
}

async function parseOpenAiImageResponse(
  payload: unknown,
  modelId: ImageModelId,
  opts?: { urlOnly?: boolean; maxImages?: number; requireOutputSize?: boolean },
): Promise<ParsedOpenAiImages> {
  const body = record(payload);
  if (!body) throw new ProviderError("AI 服务返回格式无效", 502, modelId, "invalid_response");
  throwEmbeddedError(body, modelId);
  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new ProviderError("AI 服务未返回图片", 502, modelId, "empty_response");
  }
  if (opts?.maxImages && body.data.length > opts.maxImages) {
    throw new ProviderError("AI 服务返回图片数量超出契约", 502, modelId, "invalid_response");
  }
  const images: string[] = [];
  const providerOutputSizes: Array<string | null> = [];
  for (let index = 0; index < body.data.length; index += 1) {
    const item = record(body.data[index]);
    if (!item) throw new ProviderError("AI 服务返回图片条目无效", 502, modelId, "invalid_response");
    if (!opts?.urlOnly && item.b64_json !== undefined) images.push(await base64Image(item.b64_json, modelId));
    else if (item.url !== undefined) images.push(imageUrl(item.url, modelId, index));
    else throw new ProviderError("AI 服务返回图片字段无效", 502, modelId, "invalid_response");
    if (opts?.requireOutputSize) {
      if (typeof item.size !== "string" || !/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(item.size)) {
        throw new ProviderError(
          "AI 服务未返回可记录的实际图片尺寸",
          502, modelId, "invalid_response", `data[${index}].size invalid`,
        );
      }
      providerOutputSizes.push(item.size);
    }
  }
  return { images, providerOutputSizes: opts?.requireOutputSize ? providerOutputSizes : undefined };
}

async function parseOpenAiImages(
  payload: unknown,
  modelId: ImageModelId,
  opts?: { urlOnly?: boolean; maxImages?: number },
): Promise<string[]> {
  return (await parseOpenAiImageResponse(payload, modelId, opts)).images;
}

async function parseGeminiImages(payload: unknown, modelId: ImageModelId): Promise<string[]> {
  const body = record(payload);
  if (!body) throw new ProviderError("Gemini 响应格式无效", 502, modelId, "invalid_response");
  throwEmbeddedError(body, modelId);
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const images: string[] = [];
  const finishReasons: string[] = [];
  for (const candidateValue of candidates) {
    const candidate = record(candidateValue);
    if (!candidate) continue;
    if (typeof candidate.finishReason === "string") finishReasons.push(candidate.finishReason);
    const content = record(candidate.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const partValue of parts) {
      const part = record(partValue);
      const inline = record(part?.inlineData);
      if (!inline || inline.data === undefined) continue;
      const mime = inline.mimeType === "image/jpeg" ? "image/jpeg" : inline.mimeType === "image/png" ? "image/png" : undefined;
      if (!mime) throw new ProviderError("Gemini 返回了不支持的图片格式", 502, modelId, "invalid_response");
      images.push(await base64Image(inline.data, modelId, mime));
    }
  }
  if (!images.length) {
    const refused = finishReasons.some((reason) => /safety|block|prohibited/i.test(reason));
    throw new ProviderError(
      refused ? "本次请求未通过 AI 安全审核，请调整提示词或参考图片后重试" : "AI 服务未返回图片",
      502, modelId, refused ? "content_refused" : "empty_response",
      `finishReasons=${finishReasons.join(",")}`,
    );
  }
  return images;
}

async function geminiInlineData(dataUrl: string, modelId: ImageModelId): Promise<{ inlineData: { mimeType: string; data: string } }> {
  const parsed = parsedReference(dataUrl, modelId);
  if (parsed.mime === "image/png" || parsed.mime === "image/jpeg") {
    return { inlineData: { mimeType: parsed.mime, data: parsed.base64 } };
  }
  const converted = await withImageProcessingSlot(() => sharp(parsed.buffer).png().toBuffer());
  return { inlineData: { mimeType: "image/png", data: converted.toString("base64") } };
}

export async function validateApiyiRequest(
  modelId: ImageModelId,
  req: ImageGenRequest,
  mode: "generate" | "edit",
): Promise<void> {
  if (!req.prompt.trim()) throw new ProviderError("提示词不能为空", 400, modelId, "invalid_request");
  requestOptions(modelId, req);
  const refs = referenceData(req, modelId);
  if (mode === "edit" && refs.length === 0) {
    throw new ProviderError("编辑模式至少需要一张参考图", 400, modelId, "invalid_request");
  }
  if (mode === "generate" && refs.length > 0) {
    throw new ProviderError("文生图请求不能包含参考图", 400, modelId, "invalid_request");
  }
  refs.forEach((ref) => parsedReference(ref, modelId));
  if (modelId === "gpt-image-2") {
    if (mode !== "edit" || !req.mask) {
      throw new ProviderError("gpt-image-2 仅用于带 PNG 蒙版的局部重绘", 400, modelId, "invalid_request");
    }
    await validateMaskForSource(refs[0], req.mask, modelId);
  } else if (req.mask) {
    throw new ProviderError(`${modelId} 不支持蒙版参数`, 400, modelId, "invalid_request");
  }
}

async function generate(modelId: ImageModelId, req: ImageGenRequest): Promise<ImageGenResult> {
  await validateApiyiRequest(modelId, req, "generate");
  const contract = getImageModelContract(modelId);
  if (!contract.generation) throw new ProviderError(`${modelId} 不支持文生图`, 400, modelId, "invalid_request");
  const options = requestOptions(modelId, req);
  let response: Response;
  switch (modelId) {
    case "gpt-image-2":
      throw new ProviderError("gpt-image-2 只能由蒙版局部重绘节点调用", 400, modelId, "invalid_request");
    case "gpt-image-2-vip":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({ model: upstreamModelId(modelId), prompt: req.prompt, size: options.size }),
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 }), model: modelId };
    case "gemini-3.1-flash-image":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: {
            aspectRatio: options.aspectRatio, imageSize: options.imageSize,
          } },
        }),
      }));
      return { images: await parseGeminiImages(await readJson(response, modelId), modelId), model: modelId };
    case "flux-2-pro":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, width: options.width, height: options.height,
          output_format: options.outputFormat,
        }),
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { urlOnly: true, maxImages: 1 }), model: modelId };
    case "seedream-5-0-260128": {
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, size: options.size, response_format: "b64_json",
          watermark: false, sequential_image_generation: "disabled",
        }),
      }));
      const parsed = await parseOpenAiImageResponse(await readJson(response, modelId), modelId, { requireOutputSize: true });
      return { ...parsed, model: modelId };
    }
    case "grok-imagine-image":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, aspect_ratio: options.aspectRatio, resolution: options.resolution,
          n: Math.max(1, Math.min(req.batchSize ?? 1, modelMaximumImagesPerRequest(modelId))),
          response_format: "b64_json",
        }),
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 10 }), model: modelId };
  }
}

async function edit(modelId: ImageModelId, req: ImageGenRequest): Promise<ImageGenResult> {
  await validateApiyiRequest(modelId, req, "edit");
  const contract = getImageModelContract(modelId);
  const options = requestOptions(modelId, req);
  const refs = req.referenceImages!;
  let response: Response;
  switch (modelId) {
    case "gpt-image-2": {
      response = await fetchApiyi(modelId, contract.edit.path, () => {
        const form = new FormData();
        form.append("model", upstreamModelId(modelId));
        form.append("prompt", req.prompt);
        appendImages(form, refs, modelId);
        const mask = parseDataUrl(req.mask!);
        form.append("mask", new Blob([new Uint8Array(mask.buffer)], { type: "image/png" }), "mask.png");
        form.append("output_format", "png");
        return { method: "POST", headers: { Authorization: `Bearer ${config.apiyiApiKey()}` }, body: form };
      });
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 }), model: modelId };
    }
    case "gpt-image-2-vip": {
      response = await fetchApiyi(modelId, contract.edit.path, () => {
        const form = new FormData();
        form.append("model", upstreamModelId(modelId));
        form.append("prompt", req.prompt);
        form.append("size", String(options.size));
        appendImages(form, refs, modelId);
        return { method: "POST", headers: { Authorization: `Bearer ${config.apiyiApiKey()}` }, body: form };
      });
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 }), model: modelId };
    }
    case "gemini-3.1-flash-image": {
      const parts = [{ text: req.prompt }, ...await Promise.all(refs.map((ref) => geminiInlineData(ref, modelId)))];
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: {
            aspectRatio: options.aspectRatio, imageSize: options.imageSize,
          } },
        }),
      }));
      return { images: await parseGeminiImages(await readJson(response, modelId), modelId), model: modelId };
    }
    case "flux-2-pro": {
      const adaptedRefs = await Promise.all(refs.map(adaptFluxReference));
      const inputImages = Object.fromEntries(adaptedRefs.map((ref, index) => [
        index === 0 ? "input_image" : `input_image_${index + 1}`, ref,
      ]));
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, width: options.width, height: options.height,
          output_format: options.outputFormat, ...inputImages,
        }),
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { urlOnly: true, maxImages: 1 }), model: modelId };
    }
    case "seedream-5-0-260128": {
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId), prompt: req.prompt, image: refs, size: options.size, response_format: "b64_json",
          watermark: false, sequential_image_generation: "disabled",
        }),
      }));
      const parsed = await parseOpenAiImageResponse(await readJson(response, modelId), modelId, { requireOutputSize: true });
      return { ...parsed, model: modelId };
    }
    case "grok-imagine-image": {
      response = await fetchApiyi(modelId, contract.edit.path, () => {
        const form = new FormData();
        form.append("model", upstreamModelId(modelId));
        form.append("prompt", req.prompt);
        form.append("response_format", "b64_json");
        appendImages(form, refs, modelId);
        return { method: "POST", headers: { Authorization: `Bearer ${config.apiyiApiKey()}` }, body: form };
      });
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 10 }), model: modelId };
    }
  }
}

export function createApiyiProvider(modelId: ImageModelId): AIProvider {
  return {
    id: modelId,
    validate: (req, mode) => validateApiyiRequest(modelId, req, mode),
    generate: (req) => generate(modelId, req),
    edit: (req) => edit(modelId, req),
  };
}

export const apiyiProviders = Object.fromEntries(
  ([
    "gpt-image-2", "gpt-image-2-vip", "gemini-3.1-flash-image",
    "flux-2-pro", "seedream-5-0-260128", "grok-imagine-image",
  ] as const).map((modelId) => [modelId, createApiyiProvider(modelId)]),
) as Record<ImageModelId, AIProvider>;
