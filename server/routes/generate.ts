/**
 * POST /api/generate  { providerId, request: ImageGenRequest } → ImageGenResult
 * 有参考图调 provider.edit，无参考图调 provider.generate。
 */
import { Router } from "express";
import { MAX_REFERENCE_IMAGES, type ImageGenRequest } from "../../src/types/workflow";
import { getProvider, ProviderError } from "../providers";
import { generateExactImages } from "../providers/exact";
import { normalizeImageRef, persistImageRef } from "../lib/fileStore";
import { nanoid } from "nanoid";
import { requestUser } from "../lib/auth";
import { completeGenerationRecord, createGenerationRecord, failGenerationRecord, markGenerationRunning } from "../lib/generationRecords";

export const generateRouter = Router();

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
  const runId = nanoid(10);
  const startedAt = Date.now();
  const requestedCount = Math.max(1, Math.min(8, Number(request.batchSize) || 1));
  await createGenerationRecord(runId, {
    userId: requestUser(req).id,
    projectId,
    projectName,
    nodeId: nodeId ?? "direct-generate",
    nodeLabel: nodeLabel ?? "直接生成",
    kind: kind ?? "sketch-to-render",
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
    const raw = await generateExactImages(provider, resolved, requestedCount);
    // 结果统一落盘为 /api/files URL：dataURL 与第三方临时 URL 都不进项目 JSON
    const images = await Promise.all(raw.images.map(persistImageRef));
    const finishedAt = Date.now();
    const failures = raw.failures.map((error) => ({ prompt: request.prompt, error }));
    await completeGenerationRecord({
      runId, images, prompts: images.map(() => request.prompt), failures,
      model: raw.model, providerRequests: raw.providerRequests, startedAt, finishedAt,
    });
    res.json({ ...raw, images, runId });
  } catch (err) {
    await failGenerationRecord(runId, err instanceof Error ? err.message : String(err), Date.now());
    if (err instanceof ProviderError) {
      res.status(err.status && err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: err.message,
        providerId: err.providerId ?? providerId,
      });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
});
