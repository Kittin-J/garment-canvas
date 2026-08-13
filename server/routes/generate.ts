/**
 * POST /api/generate  { providerId, request: ImageGenRequest } → ImageGenResult
 * 有参考图调 provider.edit，无参考图调 provider.generate。
 */
import { Router } from "express";
import type { ImageGenRequest } from "../../src/types/workflow";
import { getProvider, ProviderError } from "../providers";
import { normalizeImageRef, persistImageRef } from "../lib/fileStore";

export const generateRouter = Router();

generateRouter.post("/", async (req, res) => {
  const { providerId, request } = req.body as {
    providerId?: string;
    request?: ImageGenRequest;
  };
  if (!providerId || !request?.prompt) {
    res.status(400).json({ error: "providerId and request.prompt are required" });
    return;
  }
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
    const raw = resolved.referenceImages?.length
      ? await provider.edit(resolved)
      : await provider.generate(resolved);
    // 结果统一落盘为 /api/files URL：dataURL 与第三方临时 URL 都不进项目 JSON
    const images = await Promise.all(raw.images.map(persistImageRef));
    res.json({ ...raw, images });
  } catch (err) {
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
