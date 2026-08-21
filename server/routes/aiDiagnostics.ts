import { Router, type RequestHandler } from "express";
import { config } from "../config";
import { requireAdmin } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import {
  fetchWithRetry,
  getProvider,
  ProviderError,
  publicProviderErrorMessage,
} from "../providers";

function providerSettings(providerId: "nanobanana" | "gpt-image-2") {
  const nanobanana = providerId === "nanobanana";
  return {
    providerId,
    model: nanobanana ? config.nanobananaModel() : config.image2Model(),
    capabilities: nanobanana ? config.nanobananaCapabilities() : config.image2Capabilities(),
    apiKey: nanobanana ? config.nanobananaApiKey() : config.apiyiApiKey(),
    baseUrl: nanobanana ? config.change2proBaseUrl() : config.apiyiBaseUrl(),
  };
}

const getDiagnostics = asyncHandler(async (_req, res) => {
  let gateway = "未配置";
  try {
    gateway = new URL(config.apiyiBaseUrl()).host;
  } catch {
    // 配置错误会由 ready 检查和下面的 model getter 明确显示。
  }
  const providers = (["nanobanana", "gpt-image-2"] as const).map((providerId) => {
    try {
      const settings = providerSettings(providerId);
      return {
        providerId,
        model: settings.model,
        capabilities: settings.capabilities,
        configured: true,
      };
    } catch (error) {
      return {
        providerId,
        model: "",
        configured: false,
        error: error instanceof Error ? error.message : "配置缺失",
      };
    }
  });
  res.json({ gateway, providers });
});

const DIAGNOSTIC_IMAGE =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const probeDiagnostics = asyncHandler(async (req, res) => {
  const { providerId, mode } = req.body as { providerId?: unknown; mode?: unknown };
  if ((providerId !== "nanobanana" && providerId !== "gpt-image-2") || !["model", "generate", "edit"].includes(String(mode))) {
    res.status(400).json({ error: "providerId 或诊断方式无效" });
    return;
  }
  const settings = providerSettings(providerId);
  const startedAt = Date.now();
  try {
    let imageCount: number | undefined;
    if (mode === "model") {
      const requestOptions = { providerId, maxRetries: 0, timeoutMs: Math.min(config.aiTimeoutMs(), 30_000) };
      const requestInit = () => ({ headers: { Authorization: `Bearer ${settings.apiKey}` } });
      try {
        await fetchWithRetry(
          `${settings.baseUrl}/models/${encodeURIComponent(settings.model)}`,
          requestInit,
          requestOptions,
        );
      } catch (error) {
        // 部分 OpenAI 兼容网关只实现模型列表，不实现 /models/:id。
        if (!(error instanceof ProviderError) || error.status !== 404) throw error;
        const response = await fetchWithRetry(
          `${settings.baseUrl}/models`,
          requestInit,
          requestOptions,
        );
        const body = await response.json() as { data?: Array<{ id?: unknown }> };
        const exists = Array.isArray(body.data) && body.data.some((item) => item?.id === settings.model);
        if (!exists) {
          throw new ProviderError(
            "当前 AI 模型不可用，请联系管理员检查模型配置",
            404,
            providerId,
            "model_unavailable",
            `Configured model ${settings.model} was not present in GET /models`,
          );
        }
      }
    } else {
      const provider = getProvider(providerId);
      const prompt = "服装设计系统连通性测试：生成一块纯白色方形面料色卡，不包含文字";
      const result = mode === "generate"
        ? await provider.generate({ prompt, batchSize: 1, aspectRatio: "1:1" })
        : await provider.edit({
          prompt: "保持画面为纯白色方形色卡，不添加文字",
          referenceImages: [DIAGNOSTIC_IMAGE],
          batchSize: 1,
          aspectRatio: "1:1",
        });
      imageCount = result.images.length;
    }
    res.json({ ok: true, providerId, mode, model: settings.model, imageCount, durationMs: Date.now() - startedAt });
  } catch (error) {
    if (error instanceof ProviderError && error.diagnostic) {
      console.error(`[ai-diagnostic:${providerId}:${String(mode)}] ${error.diagnostic}`);
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
  // 只有会触发真实网关请求的 POST probe 计入 AI 限流；只读配置检查不计数。
  router.post("/probe", probeRateLimit, probeDiagnostics);
  return router;
}
