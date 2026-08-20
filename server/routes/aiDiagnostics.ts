import sharp from "sharp";
import { Router, type RequestHandler } from "express";
import {
  IMAGE_MODEL_IDS,
  getImageModelContract,
  isImageModelId,
  modelMaximumImagesPerRequest,
  modelMaxReferenceImages,
  type ImageModelId,
  type ImageModelOptions,
} from "../../src/types/imageModels";
import { config } from "../config";
import { requireAdmin } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { getProvider, ProviderError, publicProviderErrorMessage } from "../providers";

type DiagnosticProbeMode = "generate" | "edit";

function configuredGateway(): { host: string } {
  const url = new URL(config.apiyiBaseUrl());
  if (url.protocol !== "https:") throw new Error("APIYI_BASE_URL 必须使用 HTTPS");
  config.apiyiApiKey();
  return { host: url.host };
}

function providerSettings(providerId: ImageModelId) {
  configuredGateway();
  const contract = getImageModelContract(providerId);
  const probes: DiagnosticProbeMode[] = [
    ...(contract.generation ? ["generate" as const] : []),
    "edit",
  ];
  return {
    providerId,
    model: providerId,
    label: contract.label,
    channel: contract.channel,
    probes,
    capabilities: {
      supportsGeneration: contract.generation !== null,
      supportsEdit: true,
      maxReferenceImages: modelMaxReferenceImages(providerId),
      maxImagesPerRequest: modelMaximumImagesPerRequest(providerId),
      timeoutMs: contract.timeoutMs,
    },
  };
}

const getDiagnostics = asyncHandler(async (_req, res) => {
  let gateway = "未配置";
  try {
    gateway = configuredGateway().host;
  } catch {
    // 每个模型条目会返回具体配置错误。
  }
  const providers = IMAGE_MODEL_IDS.map((providerId) => {
    try {
      return { ...providerSettings(providerId), configured: true };
    } catch (error) {
      const contract = getImageModelContract(providerId);
      return {
        providerId,
        model: providerId,
        label: contract.label,
        channel: contract.channel,
        probes: [
          ...(contract.generation ? ["generate" as const] : []),
          "edit" as const,
        ],
        configured: false,
        error: error instanceof Error ? error.message : "配置缺失",
      };
    }
  });
  res.json({ gateway, providers });
});

function diagnosticModelOptions(modelId: ImageModelId): ImageModelOptions {
  switch (modelId) {
    case "gpt-image-2":
      return {};
    case "gpt-image-2-vip":
      return { size: "1280x1280" };
    case "gemini-3.1-flash-image":
      return { aspectRatio: "1:1", imageSize: "512" };
    case "flux-2-pro":
      return { width: 512, height: 512, outputFormat: "png" };
    case "seedream-5-0-260128":
      return { size: "2K" };
    case "grok-imagine-image":
      return { aspectRatio: "1:1", resolution: "1k" };
  }
}

let diagnosticImagesPromise: Promise<{ source: string; mask: string }> | undefined;

function diagnosticImages(): Promise<{ source: string; mask: string }> {
  diagnosticImagesPromise ??= (async () => {
    const width = 1024;
    const height = 1024;
    const source = await sharp({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
    }).png().toBuffer();
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * 4;
        pixels[offset] = 255;
        pixels[offset + 1] = 255;
        pixels[offset + 2] = 255;
        pixels[offset + 3] = x < width / 2 ? 0 : 255;
      }
    }
    const mask = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    return {
      source: `data:image/png;base64,${source.toString("base64")}`,
      mask: `data:image/png;base64,${mask.toString("base64")}`,
    };
  })();
  return diagnosticImagesPromise;
}

const probeDiagnostics = asyncHandler(async (req, res) => {
  const { providerId, mode } = req.body as { providerId?: unknown; mode?: unknown };
  if (!isImageModelId(providerId) || (mode !== "generate" && mode !== "edit")) {
    res.status(400).json({ error: "providerId 或诊断方式无效" });
    return;
  }
  const settings = providerSettings(providerId);
  if (!settings.probes.includes(mode)) {
    res.status(400).json({ error: `${providerId} 不支持${mode === "generate" ? "文生图" : "参考图编辑"}诊断` });
    return;
  }
  const startedAt = Date.now();
  try {
    const provider = getProvider(providerId);
    const prompt = "服装设计系统连通性测试：生成一块纯白色方形面料色卡，不包含文字";
    const modelOptions = diagnosticModelOptions(providerId);
    const result = mode === "generate"
      ? await provider.generate({ prompt, batchSize: 1, aspectRatio: "1:1", modelOptions })
      : await (async () => {
          const images = await diagnosticImages();
          return provider.edit({
            prompt: "保持画面为纯白色方形色卡，不添加文字",
            referenceImages: [images.source],
            mask: providerId === "gpt-image-2" ? images.mask : undefined,
            batchSize: 1,
            aspectRatio: "1:1",
            modelOptions,
          });
        })();
    res.json({
      ok: true,
      providerId,
      mode,
      model: settings.model,
      imageCount: result.images.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    if (error instanceof ProviderError && error.diagnostic) {
      console.error(`[ai-diagnostic:${providerId}:${mode}] ${error.diagnostic}`);
    }
    res.status(error instanceof ProviderError && error.status === 429 ? 429 : 502).json({
      ok: false,
      providerId,
      mode,
      error: publicProviderErrorMessage(error),
      category: error instanceof ProviderError ? error.category : "unknown",
      durationMs: Date.now() - startedAt,
    });
  }
});

export function createAiDiagnosticsRouter(probeRateLimit: RequestHandler): Router {
  const router = Router();
  router.use(requireAdmin);
  router.get("/", getDiagnostics);
  // 只有会触发真实网关请求的 probe 计入 AI 限流。
  router.post("/probe", probeRateLimit, probeDiagnostics);
  return router;
}
