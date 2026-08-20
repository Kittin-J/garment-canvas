/**
 * POST /api/generate  { modelId, kind?, request: ImageGenRequest } → 202 { runId, status }
 * 请求事务入队后立即返回，由 PostgreSQL Worker 根据参考图选择生成或编辑。
 */
import { Router } from "express";
import {
  MAX_REFERENCE_IMAGES,
  NODE_SPECS,
  type ImageGenRequest,
  type NodeKind,
} from "../../src/types/workflow";
import { postProcessGeneratedOutputImages } from "../engine/runner";
import { EXACT_ASPECT_DIMENSIONS } from "../lib/imagePostProcessing";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { enqueueGenerationRun } from "../engine/runQueue";
import {
  defaultImageModelOptions,
  imageModelOptionsError,
  isImageModelId,
  isModelAllowedForNode,
  modelMaxReferenceImages,
} from "../../src/types/imageModels";

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

generateRouter.post("/", asyncHandler(async (req, res) => {
  const { providerId, modelId: requestedModelId, request, projectId, projectName, nodeId, nodeLabel, kind } = req.body as {
    providerId?: string; modelId?: string;
    request?: ImageGenRequest;
    projectId?: string; projectName?: string; nodeId?: string; nodeLabel?: string; kind?: string;
  };
  const modelId = requestedModelId ?? providerId;
  if (!modelId || !request?.prompt) {
    res.status(400).json({ error: "modelId and request.prompt are required" });
    return;
  }
  if (!isImageModelId(modelId)) {
    res.status(400).json({ error: "modelId must identify a supported API易 image model" });
    return;
  }
  const validation = validateDirectGenerateRequest(kind, request);
  if (!validation.ok) {
    res.status(400).json({ error: validation.error });
    return;
  }
  const resolvedKind = validation.kind ?? (modelId === "gpt-image-2" ? "mask-redraw" : "sketch-to-render");
  if (!isModelAllowedForNode(modelId, resolvedKind)) {
    res.status(400).json({ error: `${modelId} is not allowed for ${resolvedKind}` });
    return;
  }
  const maskSourceRef = request.referenceImages?.[0];
  if (
    resolvedKind === "mask-redraw" &&
    (typeof maskSourceRef !== "string" || !maskSourceRef.trim() || typeof request.mask !== "string" || !request.mask.trim())
  ) {
    res.status(400).json({ error: "mask-redraw requires a source image and PNG mask" });
    return;
  }
  const maxReferences = Math.min(MAX_REFERENCE_IMAGES, modelMaxReferenceImages(modelId));
  if (request.referenceImages && request.referenceImages.length > maxReferences) {
    res.status(400).json({ error: `referenceImages must contain at most ${maxReferences} images for ${modelId}` });
    return;
  }
  const modelOptions = request.modelOptions ?? defaultImageModelOptions(modelId, request.aspectRatio);
  const optionsError = imageModelOptionsError(modelId, modelOptions);
  if (optionsError) {
    res.status(400).json({ error: `request.modelOptions ${optionsError}` });
    return;
  }
  const requestedCount = Math.max(1, Math.min(8, Number(request.batchSize) || 1));
  const user = requestUser(req);
  const resolvedNodeId = nodeId ?? "direct-generate";
  const resolvedRequest: ImageGenRequest = { ...request, modelOptions };
  const run = await enqueueGenerationRun({
    steps: [{
      nodeId: resolvedNodeId,
      kind: resolvedKind,
      inputImages: request.referenceImages ?? [],
      params: {
        ...resolvedRequest,
        modelId,
        ...(resolvedKind === "mask-redraw" ? { maskSourceRef } : {}),
      },
    }],
  }, user.id, {
    userId: user.id,
    projectId,
    projectName,
    nodeId: resolvedNodeId,
    nodeLabel: nodeLabel ?? "直接生成",
    kind: resolvedKind,
    prompt: request.prompt,
    parameters: { ...request, modelId, modelOptions } as unknown as Record<string, unknown>,
    referenceImages: request.referenceImages,
    requestedCount,
  }, "direct");
  res.status(202).json({ runId: run.id, status: "queued" });
}));
