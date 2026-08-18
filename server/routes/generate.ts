/**
 * POST /api/generate  { providerId, kind?, request: ImageGenRequest } → ImageGenResult
 * 有参考图调 provider.edit，无参考图调 provider.generate。
 */
import { Router } from "express";
import {
  MAX_REFERENCE_IMAGES,
  NODE_SPECS,
  type ImageGenRequest,
  type NodeKind,
} from "../../src/types/workflow";
import { postProcessGeneratedOutputImages } from "../engine/runner";
import { getProvider, ProviderError, publicProviderErrorMessage } from "../providers";
import { generateExactImages } from "../providers/exact";
import { normalizeImageRef, persistImageRef } from "../lib/fileStore";
import { EXACT_ASPECT_DIMENSIONS } from "../lib/imagePostProcessing";
import { nanoid } from "nanoid";
import { requestUser } from "../lib/auth";
import { completeGenerationRecord, createGenerationRecord, failGenerationRecord, markGenerationRunning } from "../lib/generationRecords";

export const generateRouter = Router();

export type DirectGenerateKind = Exclude<NodeKind, "image-input" | "result">;

export type DirectGenerateValidation =
  | { ok: true; kind?: DirectGenerateKind }
  | { ok: false; error: string };

function isDirectGenerateKind(value: unknown): value is DirectGenerateKind {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(NODE_SPECS, value)) return false;
  return Boolean(NODE_SPECS[value as NodeKind].providerId);
}

/** Validate the node contract before starting or recording a direct generation. */
export function validateDirectGenerateRequest(
  kind: unknown,
  request: ImageGenRequest,
): DirectGenerateValidation {
  // Backward compatibility: legacy direct callers did not send a node kind.
  if (kind === undefined) return { ok: true };
  if (!isDirectGenerateKind(kind)) {
    return { ok: false, error: "kind must identify a supported AI node" };
  }
  if (kind === "sketch-to-render" || kind === "ai-modify") {
    if (
      typeof request.aspectRatio !== "string"
      || !Object.prototype.hasOwnProperty.call(EXACT_ASPECT_DIMENSIONS, request.aspectRatio)
    ) {
      return {
        ok: false,
        error: `request.aspectRatio must be one of ${Object.keys(EXACT_ASPECT_DIMENSIONS).join(", ")}`,
      };
    }
  }
  if (kind === "upscale" && request.imageSize !== "2K" && request.imageSize !== "4K") {
    return { ok: false, error: "request.imageSize must be 2K or 4K" };
  }
  return { ok: true, kind };
}

/** Keep the direct endpoint on the same business output guarantees as the DAG runner. */
export function postProcessDirectGenerateImages(
  kind: DirectGenerateKind | undefined,
  request: ImageGenRequest,
  images: string[],
): Promise<string[]> {
  if (!kind) return Promise.resolve(images);
  return postProcessGeneratedOutputImages(
    kind,
    request as unknown as Record<string, unknown>,
    images,
  );
}

generateRouter.post("/", async (req, res) => {
  const { providerId, request, projectId, projectName, nodeId, nodeLabel, kind } = req.body as {
    providerId?: string;
    request?: ImageGenRequest;
    projectId?: string; projectName?: string; nodeId?: string; nodeLabel?: string; kind?: string;
  };
  if (!providerId || !request?.prompt) {
    res.status(400).json({ error: "providerId and request.prompt are required" });
    return;
  }
  if (request.referenceImages && request.referenceImages.length > MAX_REFERENCE_IMAGES) {
    res.status(400).json({ error: `referenceImages must contain at most ${MAX_REFERENCE_IMAGES} images` });
    return;
  }
  const validation = validateDirectGenerateRequest(kind, request);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const runId = nanoid(10);
  const startedAt = Date.now();
  const requestedCount = Math.max(1, Math.min(8, Number(request.batchSize) || 1));
  await createGenerationRecord(runId, {
    userId: requestUser(req).id,
    projectId,
    projectName,
    nodeId: nodeId ?? "direct-generate",
    nodeLabel: nodeLabel ?? "直接生成",
    kind: validation.kind ?? "sketch-to-render",
    prompt: request.prompt,
    parameters: request as unknown as Record<string, unknown>,
    referenceImages: request.referenceImages,
    requestedCount,
  }, startedAt);
  await markGenerationRunning(runId, startedAt);
  try {
    const provider = getProvider(providerId);
    // 参考图统一归一化为 dataURL（http URL 会带 SSRF/体积/超时防护下载）
    const resolved: ImageGenRequest = {
      ...request,
      referenceImages: request.referenceImages
        ? await Promise.all(request.referenceImages.map(normalizeImageRef))
        : undefined,
      mask: request.mask ? await normalizeImageRef(request.mask) : undefined,
    };
    const raw = await generateExactImages(provider, resolved, requestedCount, { runId, nodeId });
    const processedImages = await postProcessDirectGenerateImages(validation.kind, resolved, raw.images);
    // 结果统一落盘为 /api/files URL：dataURL 与第三方临时 URL 都不进项目 JSON
    const images = await Promise.all(processedImages.map(persistImageRef));
    const finishedAt = Date.now();
    const failures = raw.failures.map((error) => ({ prompt: request.prompt, error }));
    await completeGenerationRecord({
      runId, images, prompts: images.map(() => request.prompt), failures,
      model: raw.model, providerRequests: raw.providerRequests, startedAt, finishedAt,
    });
    res.json({ ...raw, images, runId });
  } catch (err) {
    const message = err instanceof ProviderError
      ? publicProviderErrorMessage(err)
      : err instanceof Error ? err.message : String(err);
    await failGenerationRecord(runId, message, Date.now());
    if (err instanceof ProviderError) {
      res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: message,
        providerId: err.providerId ?? providerId,
        category: err.category,
      });
    } else {
      res.status(500).json({ error: message });
    }
  }
});
