// server/index.ts
import express2 from "express";
import fs8 from "node:fs";
import path10 from "node:path";

// server/config.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
var __dirname = path.dirname(fileURLToPath(import.meta.url));
var ROOT_DIR = path.resolve(__dirname, "..");
function loadDotEnv() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();
function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return v;
}
var config = {
  /** API易图片接口；路径由本地模型知识库逐模型声明。 */
  apiyiBaseUrl: () => (process.env.APIYI_BASE_URL ?? "https://api.apiyi.com").replace(/\/+$/, ""),
  apiyiApiKey: () => required("APIYI_API_KEY"),
  port: () => Number(process.env.PORT ?? 3001),
  dataDir: () => path.resolve(ROOT_DIR, process.env.DATA_DIR ?? "./data"),
  databaseUrl: () => process.env.DATABASE_URL?.trim() || void 0,
  databaseHost: () => process.env.PGHOST?.trim() || "127.0.0.1",
  databasePort: () => Number(process.env.PGPORT ?? process.env.POSTGRES_HOST_PORT ?? 54329),
  databaseName: () => process.env.PGDATABASE?.trim() || process.env.POSTGRES_DB?.trim() || "garment_canvas",
  databaseUser: () => process.env.PGUSER?.trim() || process.env.POSTGRES_USER?.trim() || "garment_canvas",
  databasePassword: () => process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD ?? "",
  databasePoolSize: () => Math.max(1, Math.min(50, Number(process.env.DATABASE_POOL_SIZE) || 10)),
  sqliteImportPath: () => path.resolve(config.dataDir(), process.env.SQLITE_IMPORT_FILE ?? "garment-canvas.db"),
  initialAdminAccountId: () => process.env.INITIAL_ADMIN_ACCOUNT_ID?.trim() ?? "",
  initialAdminPassword: () => process.env.INITIAL_ADMIN_PASSWORD ?? "",
  /** 生产模式是否只提供 API；true 时不要求或托管前端 dist。 */
  apiOnly: () => process.env.API_ONLY === "true",
  /** AI 调用超时（中转站网关限制，可配） */
  aiTimeoutMs: (fallback = 3e5) => Number(process.env.AI_TIMEOUT_MS ?? fallback),
  /** 不发外部请求的 AI 配置就绪检查，供 readiness 使用。 */
  aiConfigReady: () => {
    const key = process.env.APIYI_API_KEY?.trim();
    const baseUrl = config.apiyiBaseUrl();
    if (!key) return false;
    try {
      const url = new URL(baseUrl);
      return url.protocol === "https:";
    } catch {
      return false;
    }
  }
};

// server/routes/generate.ts
import { Router } from "express";

// src/types/workflow.ts
var MAX_REFERENCE_IMAGES = 8;
var BATCH_SIZES = [1, 2, 4, 8];
var WORKFLOW_SCHEMA_VERSION = 2;
var NODE_SPECS = {
  "image-input": {
    kind: "image-input",
    title: "\u56FE\u7247\u4E0A\u4F20",
    description: "\u4E0A\u4F20\u8349\u56FE / \u6B3E\u5F0F\u56FE / \u9762\u6599\u53C2\u8003",
    inputs: 0,
    outputs: "images"
  },
  "sketch-to-render": {
    kind: "sketch-to-render",
    title: "\u8349\u56FE\u2192\u6548\u679C\u56FE",
    description: "\u9009\u62E9\u6A21\u578B\uFF0C\u5C06\u7EBF\u7A3F\u6E32\u67D3\u4E3A\u670D\u88C5\u6548\u679C\u56FE",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  "ai-modify": {
    kind: "ai-modify",
    title: "AI \u6539\u6B3E",
    description: "\u9009\u62E9\u6A21\u578B\u4FEE\u6539\u9886\u578B\u3001\u8896\u578B\u3001\u957F\u5EA6\u4E0E\u7EC6\u8282",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  "fabric-recolor": {
    kind: "fabric-recolor",
    title: "\u9762\u6599/\u914D\u8272\u66FF\u6362",
    description: "\u9009\u62E9\u6A21\u578B\u66FF\u6362\u9762\u6599\u7EB9\u7406\u4E0E\u914D\u8272",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  upscale: {
    kind: "upscale",
    title: "\u9AD8\u6E05\u653E\u5927",
    description: "AI \u653E\u5927\u81F3 2K/4K\uFF0C\u7CBE\u4FEE\u7EC6\u8282",
    providerId: "apiyi",
    inputs: 1,
    outputs: "images"
  },
  "print-extract": {
    kind: "print-extract",
    title: "\u5370\u82B1\u63D0\u53D6",
    description: "\u9009\u62E9\u6A21\u578B\u4ECE\u670D\u88C5\u4E0A\u63D0\u53D6\u5370\u82B1\u5E76\u5E73\u94FA\u5C55\u5F00",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  "print-mutate": {
    kind: "print-mutate",
    title: "\u5370\u82B1\u88C2\u53D8",
    description: "\u9009\u62E9\u6A21\u578B\u751F\u6210 1~8 \u5F20\u98CE\u683C\u4E00\u81F4\u7684\u5370\u82B1\u53D8\u4F53",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  "mask-redraw": {
    kind: "mask-redraw",
    title: "\u8499\u7248\u5C40\u90E8\u91CD\u7ED8",
    description: "\u7528 GPT Image 2 \u53EA\u4FEE\u6539\u8499\u7248\u9009\u4E2D\u7684\u533A\u57DF",
    providerId: "apiyi",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images"
  },
  result: {
    kind: "result",
    title: "\u7ED3\u679C",
    description: "\u6C47\u603B\u5C55\u793A\u4E0E\u5BFC\u51FA",
    inputs: 4,
    outputs: "none"
  }
};

// server/engine/runner.ts
import { nanoid as nanoid4 } from "nanoid";

// server/providers/apiyi.ts
import sharp2 from "sharp";

// docs/ai/apiyi/model-contracts.json
var model_contracts_default = {
  schemaVersion: 2,
  reviewedOn: "2026-08-20",
  baseUrl: "https://api.apiyi.com",
  runtime: {
    upstreamMode: "synchronous",
    businessQueue: "postgresql",
    retryableHttpStatuses: [429, 503],
    maxAutomaticRetries: 2,
    ambiguousTransportFailure: "outcome_unknown",
    persistTemporaryUrlsImmediately: true
  },
  inputNormalization: {
    acceptedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    outputMimeTypes: ["image/png", "image/jpeg"],
    maxInputBytes: 20971520,
    maxInputPixels: 4e7,
    maxLongEdge: 4096,
    targetBytes: 15e5,
    jpegQuality: { initial: 92, minimum: 80 },
    animationPolicy: "first-frame",
    applyExifOrientation: true,
    outputColourspace: "srgb",
    preserveMeaningfulAlpha: true
  },
  models: [
    {
      id: "gpt-image-2",
      upstreamModelId: "gpt-image-2",
      label: "GPT Image 2 \u5C40\u90E8\u91CD\u7ED8",
      channel: "official",
      allowedNodeKinds: ["mask-redraw"],
      timeoutMs: 36e4,
      generation: null,
      edit: {
        path: "/v1/images/edits",
        contentType: "multipart/form-data",
        minReferences: 1,
        maxReferences: 8,
        singleImageField: "image[]",
        multipleImageField: "image[]",
        mask: {
          required: true,
          mimeTypes: ["image/png"],
          maxBytes: 4194304,
          requiresAlpha: true,
          mustMatchFirstImageDimensions: true,
          editableAlpha: 0,
          preservedAlpha: 255
        }
      },
      forbiddenParameters: ["input_fidelity", "response_format"],
      output: { kind: "openai-image", fields: ["b64_json"], maxImages: 1 }
    },
    {
      id: "gpt-image-2-vip",
      upstreamModelId: "gpt-image-2-vip",
      label: "GPT Image 2 VIP",
      channel: "reverse-codex",
      allowedNodeKinds: ["image-generation"],
      timeoutMs: 3e5,
      generation: { path: "/v1/images/generations", contentType: "application/json" },
      edit: { path: "/v1/images/edits", contentType: "multipart/form-data", minReferences: 1, maxReferences: 8, singleImageField: "image", multipleImageField: "image" },
      sizes: ["auto", "1280x1280", "848x1280", "1280x848", "960x1280", "1280x960", "1024x1280", "1280x1024", "720x1280", "1280x720", "1280x544", "2048x2048", "1360x2048", "2048x1360", "1536x2048", "2048x1536", "1632x2048", "2048x1632", "1152x2048", "2048x1152", "2048x864", "2880x2880", "2336x3520", "3520x2336", "2480x3312", "3312x2480", "2560x3216", "3216x2560", "2160x3840", "3840x2160", "3840x1632"],
      forbiddenParameters: ["quality", "n", "aspect_ratio"],
      output: { kind: "openai-image", fields: ["b64_json", "url"], maxImages: 1 }
    },
    {
      id: "gemini-3.1-flash-image",
      upstreamModelId: "gemini-3.1-flash-image",
      label: "Gemini 3.1 Flash Image",
      channel: "official",
      allowedNodeKinds: ["image-generation"],
      timeoutMs: 36e4,
      generation: { path: "/v1beta/models/{model}:generateContent", contentType: "application/json" },
      edit: { path: "/v1beta/models/{model}:generateContent", contentType: "application/json", minReferences: 1, maxReferences: 8 },
      aspectRatios: ["1:1", "1:4", "4:1", "1:8", "8:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
      imageSizes: ["512", "1K", "2K", "4K"],
      output: { kind: "gemini-parts", fields: ["inlineData"], scanAllParts: true }
    },
    {
      id: "flux-2-pro",
      upstreamModelId: "flux-2-pro",
      label: "FLUX.2 Pro",
      channel: "official",
      allowedNodeKinds: ["image-generation"],
      timeoutMs: 12e4,
      generation: { path: "/v1/images/generations", contentType: "application/json" },
      edit: { path: "/v1/images/generations", contentType: "application/json", minReferences: 1, maxReferences: 8 },
      dimensions: { multipleOf: 16, minSide: 64, maxPixels: 4194304 },
      outputFormats: ["jpeg", "png"],
      forbiddenParameters: ["n"],
      output: { kind: "openai-image", fields: ["url"], maxImages: 1, urlTtlSeconds: 600 }
    },
    {
      id: "seedream-5-0-260128",
      upstreamModelId: "seedream-5-0-260128",
      label: "Seedream 5.0",
      channel: "official",
      allowedNodeKinds: ["image-generation"],
      timeoutMs: 12e4,
      generation: { path: "/v1/images/generations", contentType: "application/json" },
      edit: { path: "/v1/images/generations", contentType: "application/json", minReferences: 1, maxReferences: 8 },
      sizes: ["2K", "3K"],
      requiredParameters: { watermark: false, sequential_image_generation: "disabled" },
      forbiddenParameters: ["n"],
      output: { kind: "openai-image", fields: ["url", "b64_json"], recordActualSize: true }
    },
    {
      id: "grok-imagine-image",
      upstreamModelId: "grok-imagine-image",
      label: "Grok Imagine 2",
      channel: "official",
      allowedNodeKinds: ["image-generation"],
      timeoutMs: 36e4,
      generation: { path: "/v1/images/generations", contentType: "application/json" },
      edit: { path: "/v1/images/edits", contentType: "multipart/form-data", minReferences: 1, maxReferences: 4, singleImageField: "image", multipleImageField: "image[]", firstReferenceControlsDimensions: true },
      aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4"],
      resolutions: ["1k", "2k"],
      outputCounts: { min: 1, max: 10 },
      output: { kind: "openai-image", fields: ["url", "b64_json"], usageIsAccountingSource: false }
    }
  ]
};

// src/types/imageModels.ts
var IMAGE_MODEL_IDS = [
  "gpt-image-2",
  "gpt-image-2-vip",
  "gemini-3.1-flash-image",
  "flux-2-pro",
  "seedream-5-0-260128",
  "grok-imagine-image"
];
var rawModels = model_contracts_default.models;
var contractMap = new Map(rawModels.map((model) => [model.id, model]));
for (const id of IMAGE_MODEL_IDS) {
  if (!contractMap.has(id)) throw new Error(`API\u6613\u6A21\u578B\u77E5\u8BC6\u5E93\u7F3A\u5C11\u5951\u7EA6: ${id}`);
}
if (contractMap.size !== IMAGE_MODEL_IDS.length) {
  throw new Error("API\u6613\u6A21\u578B\u77E5\u8BC6\u5E93\u4E0E\u5E94\u7528\u6A21\u578B\u6E05\u5355\u4E0D\u4E00\u81F4");
}
var DEFAULT_GENERATION_MODEL_ID = "gpt-image-2-vip";
var MASK_REDRAW_MODEL_ID = "gpt-image-2";
var GENERATION_IMAGE_MODEL_IDS = IMAGE_MODEL_IDS.filter(
  (id) => id !== MASK_REDRAW_MODEL_ID
);
function isImageModelId(value) {
  return typeof value === "string" && IMAGE_MODEL_IDS.includes(value);
}
function getImageModelContract(id) {
  return contractMap.get(id);
}
function isModelAllowedForNode(modelId, nodeKind) {
  return nodeKind === "mask-redraw" ? modelId === MASK_REDRAW_MODEL_ID : modelId !== MASK_REDRAW_MODEL_ID;
}
var VIP_SIZE_BY_RATIO = {
  "1:1": "2048x2048",
  "2:3": "1360x2048",
  "3:2": "2048x1360",
  "3:4": "1536x2048",
  "4:3": "2048x1536",
  "4:5": "1632x2048",
  "5:4": "2048x1632",
  "9:16": "1152x2048",
  "16:9": "2048x1152",
  "21:9": "2048x864"
};
var FLUX_DIMENSIONS_BY_RATIO = {
  "1:1": { width: 2048, height: 2048 },
  "2:3": { width: 1360, height: 2040 },
  "3:2": { width: 2040, height: 1360 },
  "3:4": { width: 1536, height: 2048 },
  "4:3": { width: 2048, height: 1536 },
  "4:5": { width: 1632, height: 2040 },
  "5:4": { width: 2040, height: 1632 },
  "9:16": { width: 1152, height: 2048 },
  "16:9": { width: 2048, height: 1152 },
  "21:9": { width: 2016, height: 864 }
};
function defaultImageModelOptions(modelId, preferredAspectRatio = "1:1") {
  switch (modelId) {
    case "gpt-image-2":
      return {};
    case "gpt-image-2-vip":
      return { size: VIP_SIZE_BY_RATIO[preferredAspectRatio] ?? VIP_SIZE_BY_RATIO["1:1"] };
    case "gemini-3.1-flash-image": {
      const allowed = getImageModelContract(modelId).aspectRatios ?? [];
      return {
        aspectRatio: allowed.includes(preferredAspectRatio) ? preferredAspectRatio : "1:1",
        imageSize: "2K"
      };
    }
    case "flux-2-pro": {
      const dimensions = FLUX_DIMENSIONS_BY_RATIO[preferredAspectRatio] ?? FLUX_DIMENSIONS_BY_RATIO["1:1"];
      return { ...dimensions, outputFormat: "png" };
    }
    case "seedream-5-0-260128":
      return { size: "2K" };
    case "grok-imagine-image": {
      const allowed = getImageModelContract(modelId).aspectRatios ?? [];
      return {
        aspectRatio: allowed.includes(preferredAspectRatio) ? preferredAspectRatio : "1:1",
        resolution: "2k"
      };
    }
  }
}
function objectValue(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
function normalizeImageModelOptions(modelId, value, preferredAspectRatio = "1:1") {
  const raw = objectValue(value);
  const defaults = defaultImageModelOptions(modelId, preferredAspectRatio);
  switch (modelId) {
    case "gpt-image-2":
      return {};
    case "gpt-image-2-vip": {
      const sizes = getImageModelContract(modelId).sizes ?? [];
      return { size: typeof raw.size === "string" && sizes.includes(raw.size) ? raw.size : defaults.size };
    }
    case "gemini-3.1-flash-image": {
      const contract = getImageModelContract(modelId);
      return {
        aspectRatio: typeof raw.aspectRatio === "string" && contract.aspectRatios?.includes(raw.aspectRatio) ? raw.aspectRatio : defaults.aspectRatio,
        imageSize: typeof raw.imageSize === "string" && contract.imageSizes?.includes(raw.imageSize) ? raw.imageSize : defaults.imageSize
      };
    }
    case "flux-2-pro": {
      const dimensions = getImageModelContract(modelId).dimensions;
      const width = Number(raw.width);
      const height = Number(raw.height);
      const validDimensions = Number.isInteger(width) && Number.isInteger(height) && width >= dimensions.minSide && height >= dimensions.minSide && width % dimensions.multipleOf === 0 && height % dimensions.multipleOf === 0 && width * height <= dimensions.maxPixels;
      const outputFormat = raw.outputFormat === "jpeg" || raw.outputFormat === "png" ? raw.outputFormat : defaults.outputFormat;
      return validDimensions ? { width, height, outputFormat } : defaults;
    }
    case "seedream-5-0-260128": {
      const sizes = getImageModelContract(modelId).sizes ?? [];
      return { size: typeof raw.size === "string" && sizes.includes(raw.size) ? raw.size : defaults.size };
    }
    case "grok-imagine-image": {
      const contract = getImageModelContract(modelId);
      return {
        aspectRatio: typeof raw.aspectRatio === "string" && contract.aspectRatios?.includes(raw.aspectRatio) ? raw.aspectRatio : defaults.aspectRatio,
        resolution: typeof raw.resolution === "string" && contract.resolutions?.includes(raw.resolution) ? raw.resolution : defaults.resolution
      };
    }
  }
}
function imageModelOptionsError(modelId, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be an object";
  const raw = value;
  const normalized = normalizeImageModelOptions(modelId, raw);
  const allowedKeys = {
    "gpt-image-2": [],
    "gpt-image-2-vip": ["size"],
    "gemini-3.1-flash-image": ["aspectRatio", "imageSize"],
    "flux-2-pro": ["width", "height", "outputFormat"],
    "seedream-5-0-260128": ["size"],
    "grok-imagine-image": ["aspectRatio", "resolution"]
  };
  const unknown = Object.keys(raw).find((key) => !allowedKeys[modelId].includes(key));
  if (unknown) return `contains unsupported parameter ${unknown}`;
  const normalizedEntries = Object.entries(normalized);
  if (Object.keys(raw).length !== normalizedEntries.length) {
    return "contains an unsupported or incomplete model option";
  }
  if (normalizedEntries.some(([key, expected]) => raw[key] !== expected)) {
    return "contains an unsupported or incomplete model option";
  }
  return void 0;
}
function modelMaxReferenceImages(modelId) {
  return Math.min(8, getImageModelContract(modelId).edit.maxReferences);
}
function modelMaximumImagesPerRequest(modelId) {
  if (modelId === "grok-imagine-image") return getImageModelContract(modelId).outputCounts?.max ?? 1;
  return getImageModelContract(modelId).output.maxImages ?? 1;
}

// server/lib/maskProcessing.ts
import sharp from "sharp";

// server/providers/base.ts
var ProviderError = class extends Error {
  constructor(message, status, providerId, category = "unknown", diagnostic) {
    super(message);
    this.status = status;
    this.providerId = providerId;
    this.category = category;
    this.diagnostic = diagnostic;
    this.name = "ProviderError";
  }
  status;
  providerId;
  category;
  diagnostic;
};
function classifyProviderMessage(status, rawMessage) {
  const message = rawMessage.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  if (status === 401 || status === 403) {
    return {
      category: "gateway_authentication",
      publicMessage: "AI \u7F51\u5173\u9274\u6743\u5931\u8D25\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u68C0\u67E5 API Key \u6216\u8D26\u53F7\u6743\u9650"
    };
  }
  const contentRefused = /content\s*(policy|filter)|content management policy|responsible\s*ai\s*policy\s*violation|responsibleaipolicyviolation/i.test(message) || /(safety system|moderation).{0,50}(block|filter|reject|refus)/i.test(message) || /(block|filter|reject|refus).{0,50}(safety system|moderation|content management policy)/i.test(message) || /内容.{0,12}(安全|审核|政策|过滤).{0,12}(拦截|过滤|拒绝|违规)|内容.{0,10}(拒绝|违规)/i.test(message);
  if (contentRefused) {
    return {
      category: "content_refused",
      publicMessage: "\u672C\u6B21\u8BF7\u6C42\u672A\u901A\u8FC7 AI \u5B89\u5168\u5BA1\u6838\uFF0C\u8BF7\u8C03\u6574\u63D0\u793A\u8BCD\u6216\u53C2\u8003\u56FE\u7247\u540E\u91CD\u8BD5"
    };
  }
  if (/model.{0,40}(not found|does not exist|unsupported|not available|invalid)|unknown model|模型.{0,10}(不存在|不可用|不支持)/i.test(message)) {
    return {
      category: "model_unavailable",
      publicMessage: "\u5F53\u524D AI \u6A21\u578B\u4E0D\u53EF\u7528\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u68C0\u67E5\u6A21\u578B\u914D\u7F6E"
    };
  }
  const deterministicParameterError = /(invalid|unknown|unsupported|not supported|out of range).{0,60}(parameter|argument|field|resolution|aspect ratio|size|width|height|format|image count)/i.test(message) || /(parameter|argument|field|resolution|aspect ratio|size|width|height|format|image count).{0,60}(invalid|unknown|unsupported|not supported|out of range|must be|only supports?)/i.test(message);
  if (deterministicParameterError) {
    return {
      category: "invalid_request",
      publicMessage: "AI \u670D\u52A1\u6682\u4E0D\u652F\u6301\u5F53\u524D\u53C2\u6570\u6216\u53C2\u8003\u56FE\u7EC4\u5408\uFF0C\u8BF7\u8C03\u6574\u540E\u91CD\u8BD5"
    };
  }
  if (status === 429) {
    return { category: "rate_limited", publicMessage: "AI \u670D\u52A1\u5F53\u524D\u7E41\u5FD9\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" };
  }
  if (status !== void 0 && status >= 400 && status < 500) {
    return {
      category: "invalid_request",
      publicMessage: "AI \u670D\u52A1\u6682\u4E0D\u652F\u6301\u5F53\u524D\u53C2\u6570\u6216\u53C2\u8003\u56FE\u7EC4\u5408\uFF0C\u8BF7\u8C03\u6574\u540E\u91CD\u8BD5"
    };
  }
  if (status !== void 0 && status >= 500) {
    return { category: "gateway_unavailable", publicMessage: "AI \u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" };
  }
  return { category: "unknown", publicMessage: "AI \u670D\u52A1\u8FD4\u56DE\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5" };
}
function providerErrorFromResponse(status, responseBody, providerId) {
  const classified = classifyProviderMessage(status, responseBody);
  return new ProviderError(
    classified.publicMessage,
    status,
    providerId,
    classified.category,
    `HTTP ${status}: ${responseBody.slice(0, 2e3)}`
  );
}
function providerErrorFromMessage(message, providerId, status) {
  const classified = classifyProviderMessage(status, message);
  return new ProviderError(classified.publicMessage, status, providerId, classified.category, message.slice(0, 2e3));
}
function publicProviderErrorMessage(error) {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "AI \u670D\u52A1\u54CD\u5E94\u8D85\u65F6\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
  }
  return "AI \u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
}
function sanitizedProviderDiagnostic(error) {
  if (!error.diagnostic) return void 0;
  const redact = (value) => value.replace(/(?:bearer\s+)?sk-[a-z0-9_-]+/gi, "[redacted-key]").replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[redacted-image]").replace(/https?:\/\/[^\s\"']+/gi, "[redacted-url]").slice(0, 800);
  const match = /^HTTP\s+(\d+):\s*([\s\S]*)$/i.exec(error.diagnostic);
  if (!match) return redact(error.diagnostic);
  try {
    const parsed = JSON.parse(match[2]);
    const source = typeof parsed.error === "object" && parsed.error !== null ? parsed.error : parsed;
    const safe = Object.fromEntries(
      ["message", "type", "code", "param", "status"].filter((key) => typeof source[key] === "string" || typeof source[key] === "number").map((key) => [key, redact(String(source[key]))])
    );
    return `HTTP ${match[1]}: ${JSON.stringify(safe)}`;
  } catch {
    return `HTTP ${match[1]}: ${redact(match[2])}`;
  }
}
async function fetchWithRetry(url, initFactory, opts) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ProviderError("AI \u7F51\u5173\u5730\u5740\u65E0\u6548\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u68C0\u67E5\u914D\u7F6E", 400, opts?.providerId, "invalid_request");
  }
  if (parsedUrl.protocol !== "https:") {
    throw new ProviderError(
      "AI \u7F51\u5173\u5FC5\u987B\u4F7F\u7528 HTTPS\uFF0C\u8BF7\u8054\u7CFB\u7BA1\u7406\u5458\u68C0\u67E5\u914D\u7F6E",
      400,
      opts?.providerId,
      "invalid_request",
      `Blocked non-HTTPS provider URL with protocol ${parsedUrl.protocol}`
    );
  }
  const timeoutMs = opts?.timeoutMs ?? config.aiTimeoutMs();
  void opts?.maxRetries;
  try {
    const res = await fetch(url, {
      ...initFactory(),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw providerErrorFromResponse(res.status, body, opts?.providerId);
    }
    return res;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new ProviderError(
      timedOut ? "AI \u8BF7\u6C42\u5DF2\u8D85\u65F6\uFF0C\u7ED3\u679C\u53EF\u80FD\u5DF2\u7ECF\u751F\u6210\uFF1B\u4E3A\u907F\u514D\u91CD\u590D\u8BA1\u8D39\uFF0C\u7CFB\u7EDF\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5" : "AI \u8FDE\u63A5\u4E2D\u65AD\uFF0C\u7ED3\u679C\u53EF\u80FD\u5DF2\u7ECF\u751F\u6210\uFF1B\u4E3A\u907F\u514D\u91CD\u590D\u8BA1\u8D39\uFF0C\u7CFB\u7EDF\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5",
      timedOut ? 504 : 502,
      opts?.providerId,
      "outcome_unknown",
      error instanceof Error ? error.message : String(error)
    );
  }
}
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!m || !m[2]) {
    throw new ProviderError("Invalid dataURL (expected base64)");
  }
  const mime = m[1] || "image/png";
  const base64 = m[3];
  return { mime, base64, buffer: Buffer.from(base64, "base64") };
}
function toDataUrl(base64, mime = "image/png") {
  return `data:${mime};base64,${base64}`;
}

// server/lib/imageProcessingLimit.ts
var MAX_CONCURRENT_IMAGE_PROCESSING = 2;
var active = 0;
var waiters = [];
async function acquireImageProcessingSlot() {
  if (active < MAX_CONCURRENT_IMAGE_PROCESSING) {
    active += 1;
  } else {
    await new Promise((resolve) => waiters.push(resolve));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) {
      next();
    } else {
      active -= 1;
    }
  };
}
async function withImageProcessingSlot(work) {
  const release = await acquireImageProcessingSlot();
  try {
    return await work();
  } finally {
    release();
  }
}

// server/lib/imageValidation.ts
var ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
var MAX_IMAGE_BYTES = 20 * 1024 * 1024;
var ImageValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ImageValidationError";
  }
};
function hasMagic(buffer, bytes, offset = 0) {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}
function detectImageMime(buffer) {
  if (buffer.length >= 8 && hasMagic(buffer, [137, 80, 78, 71, 13, 10, 26, 10])) {
    return "image/png";
  }
  if (buffer.length >= 3 && hasMagic(buffer, [255, 216, 255])) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 6) {
    const signature = buffer.toString("ascii", 0, 6);
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return null;
}
function validateImageDataUrl(dataUrl, maxBytes = MAX_IMAGE_BYTES) {
  if (typeof dataUrl !== "string") throw new ImageValidationError("image dataURL must be a string");
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) throw new ImageValidationError("invalid image dataURL (strict base64 required)");
  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.includes(mime)) {
    throw new ImageValidationError(`unsupported image MIME: ${mime}`);
  }
  const encoded = match[2];
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    throw new ImageValidationError("invalid image base64 payload");
  }
  if (encoded.includes("=") && !/^[A-Za-z0-9+/]+={1,2}$/.test(encoded)) {
    throw new ImageValidationError("invalid image base64 padding");
  }
  const estimatedBytes = Math.floor(encoded.length * 3 / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (estimatedBytes > maxBytes) throw new ImageValidationError(`image too large (limit ${maxBytes} bytes)`);
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.length !== estimatedBytes) {
    throw new ImageValidationError("invalid image base64 payload");
  }
  if (buffer.toString("base64") !== encoded) {
    throw new ImageValidationError("non-canonical image base64 payload");
  }
  const detected = detectImageMime(buffer);
  if (!detected) throw new ImageValidationError("unrecognized image file signature");
  if (detected !== mime) {
    throw new ImageValidationError(`image MIME/signature mismatch: declared ${mime}, detected ${detected}`);
  }
  return { mime, buffer };
}
function isLocalImageReference(value) {
  if (typeof value !== "string") return false;
  return /^\/api\/files\/[A-Za-z0-9_-]{1,128}\.(?:png|jpe?g|webp|gif)$/.test(value);
}

// server/lib/maskProcessing.ts
var MAX_GPT_IMAGE_MASK_BYTES = 4 * 1024 * 1024;
var MAX_MASK_PIXELS = 4e7;
async function validateMaskForSource(sourceDataUrl, maskDataUrl, providerId = "gpt-image-2") {
  const source = validateImageDataUrl(sourceDataUrl);
  const mask = validateImageDataUrl(maskDataUrl, MAX_GPT_IMAGE_MASK_BYTES);
  if (mask.mime !== "image/png") {
    throw new ProviderError("\u8499\u7248\u5FC5\u987B\u662F PNG \u56FE\u7247", 400, providerId, "invalid_request");
  }
  return withImageProcessingSlot(async () => {
    const sourceMeta = await sharp(source.buffer, {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_MASK_PIXELS
    }).metadata();
    const maskImage = sharp(mask.buffer, {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_MASK_PIXELS
    });
    const maskMeta = await maskImage.metadata();
    if (!sourceMeta.width || !sourceMeta.height || !maskMeta.width || !maskMeta.height) {
      throw new ProviderError("\u65E0\u6CD5\u8BFB\u53D6\u539F\u56FE\u6216\u8499\u7248\u5C3A\u5BF8", 400, providerId, "invalid_request");
    }
    if (sourceMeta.width !== maskMeta.width || sourceMeta.height !== maskMeta.height) {
      throw new ProviderError(
        `\u8499\u7248\u5C3A\u5BF8\u5FC5\u987B\u4E0E\u539F\u56FE\u5B8C\u5168\u4E00\u81F4\uFF08\u539F\u56FE ${sourceMeta.width}x${sourceMeta.height}\uFF0C\u8499\u7248 ${maskMeta.width}x${maskMeta.height}\uFF09`,
        400,
        providerId,
        "invalid_request"
      );
    }
    if (!maskMeta.hasAlpha) {
      throw new ProviderError("\u8499\u7248 PNG \u5FC5\u987B\u5305\u542B Alpha \u901A\u9053", 400, providerId, "invalid_request");
    }
    const alphaPixels = await maskImage.extractChannel("alpha").raw().toBuffer();
    let minAlpha = 255;
    let maxAlpha = 0;
    for (const value of alphaPixels) {
      minAlpha = Math.min(minAlpha, value);
      maxAlpha = Math.max(maxAlpha, value);
    }
    if (minAlpha === 255) {
      throw new ProviderError("\u8499\u7248\u6CA1\u6709\u53EF\u7F16\u8F91\u533A\u57DF\uFF0C\u8BF7\u5148\u6D82\u62B9\u9700\u8981\u4FEE\u6539\u7684\u4F4D\u7F6E", 400, providerId, "invalid_request");
    }
    if (maxAlpha === 0) {
      throw new ProviderError("\u8499\u7248\u8986\u76D6\u4E86\u6574\u5F20\u56FE\u7247\uFF0C\u8BF7\u4FDD\u7559\u4E0D\u9700\u8981\u4FEE\u6539\u7684\u533A\u57DF", 400, providerId, "invalid_request");
    }
    return {
      sourceBuffer: source.buffer,
      maskBuffer: mask.buffer,
      width: sourceMeta.width,
      height: sourceMeta.height
    };
  });
}
async function compositeMaskedEdit(sourceDataUrl, maskDataUrl, generatedDataUrl) {
  const pair = await validateMaskForSource(sourceDataUrl, maskDataUrl);
  const generated = validateImageDataUrl(generatedDataUrl);
  return withImageProcessingSlot(async () => {
    const generatedMeta = await sharp(generated.buffer, {
      animated: false,
      failOn: "error",
      limitInputPixels: MAX_MASK_PIXELS
    }).metadata();
    if (generatedMeta.width !== pair.width || generatedMeta.height !== pair.height) {
      throw new ProviderError(
        "AI \u8FD4\u56DE\u56FE\u7247\u5C3A\u5BF8\u4E0E\u539F\u56FE\u4E0D\u4E00\u81F4\uFF0C\u65E0\u6CD5\u5B89\u5168\u6267\u884C\u8499\u7248\u5916\u50CF\u7D20\u4FDD\u62A4",
        502,
        "gpt-image-2",
        "invalid_response"
      );
    }
    const editMask = await sharp(pair.maskBuffer).negate({ alpha: true }).png().toBuffer();
    const editableLayer = await sharp(generated.buffer).ensureAlpha().composite([{ input: editMask, blend: "dest-in" }]).png().toBuffer();
    const output = await sharp(pair.sourceBuffer).ensureAlpha().composite([{ input: editableLayer, blend: "over" }]).png().toBuffer();
    return toDataUrl(output.toString("base64"), "image/png");
  });
}

// server/providers/apiyi.ts
var PROVIDER_RESPONSE_PIXEL_LIMIT = 4e7;
var REFERENCE_MIMES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp"]);
var FLUX_MAX_INPUT_PIXELS = 2e7;
var FLUX_MAX_INPUT_BYTES = 20 * 1024 * 1024;
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function requestOptions(modelId, req) {
  const options = req.modelOptions ?? defaultImageModelOptions(modelId, req.aspectRatio);
  const error = imageModelOptionsError(modelId, options);
  if (error) throw new ProviderError(`\u6A21\u578B\u53C2\u6570\u65E0\u6548\uFF1A${error}`, 400, modelId, "invalid_request");
  return options;
}
function referenceData(req, modelId) {
  const refs = req.referenceImages ?? [];
  const max = modelMaxReferenceImages(modelId);
  if (refs.length > max) {
    throw new ProviderError(`${modelId} \u6700\u591A\u652F\u6301 ${max} \u5F20\u53C2\u8003\u56FE`, 400, modelId, "invalid_request");
  }
  return refs;
}
function parsedReference(dataUrl, modelId) {
  try {
    const validated = validateImageDataUrl(dataUrl);
    if (!REFERENCE_MIMES.has(validated.mime)) {
      throw new ProviderError(`${modelId} \u4EC5\u652F\u6301 PNG\u3001JPEG \u6216 WebP \u53C2\u8003\u56FE`, 400, modelId, "invalid_request");
    }
    return {
      mime: validated.mime,
      base64: validated.buffer.toString("base64"),
      buffer: validated.buffer
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      `${modelId} \u53C2\u8003\u56FE\u6570\u636E\u65E0\u6548`,
      400,
      modelId,
      "invalid_request",
      error instanceof Error ? error.message : String(error)
    );
  }
}
function fluxTargetDimensions(width, height) {
  const contract = getImageModelContract("flux-2-pro").dimensions;
  const scale = Math.min(1, Math.sqrt(contract.maxPixels / (width * height)));
  let targetWidth = Math.max(contract.minSide, Math.round(width * scale / contract.multipleOf) * contract.multipleOf);
  let targetHeight = Math.max(contract.minSide, Math.round(height * scale / contract.multipleOf) * contract.multipleOf);
  while (targetWidth * targetHeight > contract.maxPixels) {
    const widthScale = targetWidth / width;
    const heightScale = targetHeight / height;
    if (widthScale >= heightScale && targetWidth > contract.minSide) targetWidth -= contract.multipleOf;
    else if (targetHeight > contract.minSide) targetHeight -= contract.multipleOf;
    else break;
  }
  return { width: targetWidth, height: targetHeight };
}
async function adaptFluxReference(dataUrl) {
  const modelId = "flux-2-pro";
  const parsed = parsedReference(dataUrl, modelId);
  try {
    return await withImageProcessingSlot(async () => {
      const input = sharp2(parsed.buffer, {
        animated: false,
        failOn: "error",
        limitInputPixels: FLUX_MAX_INPUT_PIXELS
      });
      const metadata = await input.metadata();
      if (!metadata.width || !metadata.height) {
        throw new ProviderError("FLUX \u53C2\u8003\u56FE\u5C3A\u5BF8\u65E0\u6548", 400, modelId, "invalid_request");
      }
      const swapsAxes = metadata.orientation !== void 0 && metadata.orientation >= 5 && metadata.orientation <= 8;
      const width = swapsAxes ? metadata.height : metadata.width;
      const height = swapsAxes ? metadata.width : metadata.height;
      const target = fluxTargetDimensions(width, height);
      const alpha = metadata.hasAlpha ? await input.clone().rotate().ensureAlpha().extractChannel("alpha").raw().toBuffer() : void 0;
      const transparent = alpha?.some((value) => value < 255) ?? false;
      const transformed = sharp2(parsed.buffer, {
        animated: false,
        failOn: "error",
        limitInputPixels: FLUX_MAX_INPUT_PIXELS
      }).rotate().resize({ width: target.width, height: target.height, fit: "fill" }).toColourspace("srgb");
      const output = transparent ? await transformed.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer() : await transformed.flatten({ background: "#ffffff" }).jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer();
      if (output.byteLength > FLUX_MAX_INPUT_BYTES) {
        throw new ProviderError("FLUX \u53C2\u8003\u56FE\u5904\u7406\u540E\u4ECD\u8D85\u8FC7 20MB\uFF0C\u8BF7\u5148\u88C1\u526A\u56FE\u7247", 400, modelId, "invalid_request");
      }
      return toDataUrl(output.toString("base64"), transparent ? "image/png" : "image/jpeg");
    });
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "FLUX \u53C2\u8003\u56FE\u65E0\u6CD5\u9002\u914D\uFF0C\u8BF7\u4F7F\u7528\u6807\u51C6 PNG\u3001JPEG \u6216 WebP \u56FE\u7247",
      400,
      modelId,
      "invalid_request",
      error instanceof Error ? error.message : String(error)
    );
  }
}
function appendImages(form, refs, modelId) {
  const editContract = getImageModelContract(modelId).edit;
  const field = refs.length === 1 ? editContract.singleImageField : editContract.multipleImageField;
  if (!field) {
    throw new ProviderError(`${modelId} \u7F3A\u5C11 multipart \u56FE\u7247\u5B57\u6BB5\u5951\u7EA6`, 500, modelId, "invalid_request");
  }
  refs.forEach((ref, index) => {
    const parsed = parsedReference(ref, modelId);
    const extension = parsed.mime === "image/jpeg" ? "jpg" : parsed.mime.split("/")[1];
    form.append(
      field,
      new Blob([new Uint8Array(parsed.buffer)], { type: parsed.mime }),
      `image-${index + 1}.${extension}`
    );
  });
}
function upstreamModelId(modelId) {
  return getImageModelContract(modelId).upstreamModelId;
}
function resolveContractPath(path11, modelId) {
  return path11.replace("{model}", encodeURIComponent(upstreamModelId(modelId)));
}
async function fetchApiyi(modelId, path11, initFactory) {
  const timeout = getImageModelContract(modelId).timeoutMs;
  return fetchWithRetry(`${config.apiyiBaseUrl()}${resolveContractPath(path11, modelId)}`, initFactory, {
    providerId: modelId,
    timeoutMs: config.aiTimeoutMs(timeout),
    maxRetries: 0
  });
}
async function readJson(response, modelId) {
  try {
    return await response.json();
  } catch (error) {
    throw new ProviderError(
      "AI \u54CD\u5E94\u4E2D\u65AD\u6216\u4E0D\u5B8C\u6574\uFF0C\u7ED3\u679C\u53EF\u80FD\u5DF2\u7ECF\u751F\u6210\uFF1B\u7CFB\u7EDF\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5",
      502,
      modelId,
      "outcome_unknown",
      error instanceof Error ? error.message : String(error)
    );
  }
}
function imageUrl(value, modelId, index) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6548\u56FE\u7247\u5730\u5740", 502, modelId, "invalid_response", `data[${index}].url invalid`);
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("protocol");
  } catch {
    throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6548\u56FE\u7247\u5730\u5740", 502, modelId, "invalid_response", `data[${index}].url invalid`);
  }
  return value;
}
async function base64Image(value, modelId, mimeHint) {
  if (typeof value !== "string" || !value) {
    throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u4E86\u65E0\u6548\u56FE\u7247\u6570\u636E", 502, modelId, "invalid_response");
  }
  try {
    let buffer;
    let mime;
    if (value.startsWith("data:")) {
      const validated = validateImageDataUrl(value);
      buffer = validated.buffer;
      mime = validated.mime;
    } else {
      buffer = Buffer.from(value, "base64");
      if (!buffer.length || buffer.toString("base64") !== value) {
        throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u4E86\u635F\u574F\u7684\u56FE\u7247\u6570\u636E", 502, modelId, "invalid_response");
      }
      const detected = detectImageMime(buffer);
      if (!detected) {
        throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u4E86\u672A\u77E5\u56FE\u7247\u683C\u5F0F", 502, modelId, "invalid_response");
      }
      mime = detected;
    }
    if (!REFERENCE_MIMES.has(mime)) {
      throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u4E86\u4E0D\u652F\u6301\u7684\u56FE\u7247\u683C\u5F0F", 502, modelId, "invalid_response");
    }
    if (mimeHint && mime !== mimeHint) {
      throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u56FE\u7247\u7684 MIME \u4E0E\u5B9E\u9645\u683C\u5F0F\u4E0D\u4E00\u81F4", 502, modelId, "invalid_response");
    }
    await withImageProcessingSlot(async () => {
      await sharp2(buffer, {
        animated: false,
        failOn: "warning",
        limitInputPixels: PROVIDER_RESPONSE_PIXEL_LIMIT
      }).raw().toBuffer();
    });
    return toDataUrl(buffer.toString("base64"), mime);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(
      "AI \u670D\u52A1\u8FD4\u56DE\u4E86\u635F\u574F\u7684\u56FE\u7247\u6570\u636E",
      502,
      modelId,
      "invalid_response",
      `image payload validation failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500)
    );
  }
}
function throwEmbeddedError(payload, modelId) {
  if (payload.error === void 0 || payload.error === null) return;
  const detail = record(payload.error);
  const message = typeof detail?.message === "string" ? detail.message : "API\u6613\u56FE\u7247\u63A5\u53E3\u8FD4\u56DE\u9519\u8BEF";
  const rawCode = detail?.code;
  const status = typeof rawCode === "number" ? rawCode : void 0;
  const classifierMessage = typeof rawCode === "string" ? `${rawCode}: ${message}` : message;
  throw providerErrorFromMessage(classifierMessage, modelId, status);
}
async function parseOpenAiImageResponse(payload, modelId, opts) {
  const body = record(payload);
  if (!body) throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u683C\u5F0F\u65E0\u6548", 502, modelId, "invalid_response");
  throwEmbeddedError(body, modelId);
  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new ProviderError("AI \u670D\u52A1\u672A\u8FD4\u56DE\u56FE\u7247", 502, modelId, "empty_response");
  }
  if (opts?.maxImages && body.data.length > opts.maxImages) {
    throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u56FE\u7247\u6570\u91CF\u8D85\u51FA\u5951\u7EA6", 502, modelId, "invalid_response");
  }
  const images = [];
  const providerOutputSizes = [];
  for (let index = 0; index < body.data.length; index += 1) {
    const item = record(body.data[index]);
    if (!item) throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u56FE\u7247\u6761\u76EE\u65E0\u6548", 502, modelId, "invalid_response");
    if (!opts?.urlOnly && item.b64_json !== void 0) images.push(await base64Image(item.b64_json, modelId));
    else if (item.url !== void 0) images.push(imageUrl(item.url, modelId, index));
    else throw new ProviderError("AI \u670D\u52A1\u8FD4\u56DE\u56FE\u7247\u5B57\u6BB5\u65E0\u6548", 502, modelId, "invalid_response");
    if (opts?.requireOutputSize) {
      if (typeof item.size !== "string" || !/^[1-9]\d{1,4}x[1-9]\d{1,4}$/.test(item.size)) {
        throw new ProviderError(
          "AI \u670D\u52A1\u672A\u8FD4\u56DE\u53EF\u8BB0\u5F55\u7684\u5B9E\u9645\u56FE\u7247\u5C3A\u5BF8",
          502,
          modelId,
          "invalid_response",
          `data[${index}].size invalid`
        );
      }
      providerOutputSizes.push(item.size);
    }
  }
  return { images, providerOutputSizes: opts?.requireOutputSize ? providerOutputSizes : void 0 };
}
async function parseOpenAiImages(payload, modelId, opts) {
  return (await parseOpenAiImageResponse(payload, modelId, opts)).images;
}
async function parseGeminiImages(payload, modelId) {
  const body = record(payload);
  if (!body) throw new ProviderError("Gemini \u54CD\u5E94\u683C\u5F0F\u65E0\u6548", 502, modelId, "invalid_response");
  throwEmbeddedError(body, modelId);
  const candidates = Array.isArray(body.candidates) ? body.candidates : [];
  const images = [];
  const finishReasons = [];
  for (const candidateValue of candidates) {
    const candidate = record(candidateValue);
    if (!candidate) continue;
    if (typeof candidate.finishReason === "string") finishReasons.push(candidate.finishReason);
    const content = record(candidate.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    for (const partValue of parts) {
      const part = record(partValue);
      const inline = record(part?.inlineData);
      if (!inline || inline.data === void 0) continue;
      const mime = inline.mimeType === "image/jpeg" ? "image/jpeg" : inline.mimeType === "image/png" ? "image/png" : void 0;
      if (!mime) throw new ProviderError("Gemini \u8FD4\u56DE\u4E86\u4E0D\u652F\u6301\u7684\u56FE\u7247\u683C\u5F0F", 502, modelId, "invalid_response");
      images.push(await base64Image(inline.data, modelId, mime));
    }
  }
  if (!images.length) {
    const refused = finishReasons.some((reason) => /safety|block|prohibited/i.test(reason));
    throw new ProviderError(
      refused ? "\u672C\u6B21\u8BF7\u6C42\u672A\u901A\u8FC7 AI \u5B89\u5168\u5BA1\u6838\uFF0C\u8BF7\u8C03\u6574\u63D0\u793A\u8BCD\u6216\u53C2\u8003\u56FE\u7247\u540E\u91CD\u8BD5" : "AI \u670D\u52A1\u672A\u8FD4\u56DE\u56FE\u7247",
      502,
      modelId,
      refused ? "content_refused" : "empty_response",
      `finishReasons=${finishReasons.join(",")}`
    );
  }
  return images;
}
async function geminiInlineData(dataUrl, modelId) {
  const parsed = parsedReference(dataUrl, modelId);
  if (parsed.mime === "image/png" || parsed.mime === "image/jpeg") {
    return { inlineData: { mimeType: parsed.mime, data: parsed.base64 } };
  }
  const converted = await withImageProcessingSlot(() => sharp2(parsed.buffer).png().toBuffer());
  return { inlineData: { mimeType: "image/png", data: converted.toString("base64") } };
}
async function validateApiyiRequest(modelId, req, mode) {
  if (!req.prompt.trim()) throw new ProviderError("\u63D0\u793A\u8BCD\u4E0D\u80FD\u4E3A\u7A7A", 400, modelId, "invalid_request");
  requestOptions(modelId, req);
  const refs = referenceData(req, modelId);
  if (mode === "edit" && refs.length === 0) {
    throw new ProviderError("\u7F16\u8F91\u6A21\u5F0F\u81F3\u5C11\u9700\u8981\u4E00\u5F20\u53C2\u8003\u56FE", 400, modelId, "invalid_request");
  }
  if (mode === "generate" && refs.length > 0) {
    throw new ProviderError("\u6587\u751F\u56FE\u8BF7\u6C42\u4E0D\u80FD\u5305\u542B\u53C2\u8003\u56FE", 400, modelId, "invalid_request");
  }
  refs.forEach((ref) => parsedReference(ref, modelId));
  if (modelId === "gpt-image-2") {
    if (mode !== "edit" || !req.mask) {
      throw new ProviderError("gpt-image-2 \u4EC5\u7528\u4E8E\u5E26 PNG \u8499\u7248\u7684\u5C40\u90E8\u91CD\u7ED8", 400, modelId, "invalid_request");
    }
    await validateMaskForSource(refs[0], req.mask, modelId);
  } else if (req.mask) {
    throw new ProviderError(`${modelId} \u4E0D\u652F\u6301\u8499\u7248\u53C2\u6570`, 400, modelId, "invalid_request");
  }
}
async function generate(modelId, req) {
  await validateApiyiRequest(modelId, req, "generate");
  const contract = getImageModelContract(modelId);
  if (!contract.generation) throw new ProviderError(`${modelId} \u4E0D\u652F\u6301\u6587\u751F\u56FE`, 400, modelId, "invalid_request");
  const options = requestOptions(modelId, req);
  let response;
  switch (modelId) {
    case "gpt-image-2":
      throw new ProviderError("gpt-image-2 \u53EA\u80FD\u7531\u8499\u7248\u5C40\u90E8\u91CD\u7ED8\u8282\u70B9\u8C03\u7528", 400, modelId, "invalid_request");
    case "gpt-image-2-vip":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({ model: upstreamModelId(modelId), prompt: req.prompt, size: options.size })
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 1 }), model: modelId };
    case "gemini-3.1-flash-image":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          contents: [{ parts: [{ text: req.prompt }] }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: {
            aspectRatio: options.aspectRatio,
            imageSize: options.imageSize
          } }
        })
      }));
      return { images: await parseGeminiImages(await readJson(response, modelId), modelId), model: modelId };
    case "flux-2-pro":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId),
          prompt: req.prompt,
          width: options.width,
          height: options.height,
          output_format: options.outputFormat
        })
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { urlOnly: true, maxImages: 1 }), model: modelId };
    case "seedream-5-0-260128": {
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId),
          prompt: req.prompt,
          size: options.size,
          response_format: "b64_json",
          watermark: false,
          sequential_image_generation: "disabled"
        })
      }));
      const parsed = await parseOpenAiImageResponse(await readJson(response, modelId), modelId, { requireOutputSize: true });
      return { ...parsed, model: modelId };
    }
    case "grok-imagine-image":
      response = await fetchApiyi(modelId, contract.generation.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId),
          prompt: req.prompt,
          aspect_ratio: options.aspectRatio,
          resolution: options.resolution,
          n: Math.max(1, Math.min(req.batchSize ?? 1, modelMaximumImagesPerRequest(modelId))),
          response_format: "b64_json"
        })
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { maxImages: 10 }), model: modelId };
  }
}
async function edit(modelId, req) {
  await validateApiyiRequest(modelId, req, "edit");
  const contract = getImageModelContract(modelId);
  const options = requestOptions(modelId, req);
  const refs = req.referenceImages;
  let response;
  switch (modelId) {
    case "gpt-image-2": {
      response = await fetchApiyi(modelId, contract.edit.path, () => {
        const form = new FormData();
        form.append("model", upstreamModelId(modelId));
        form.append("prompt", req.prompt);
        appendImages(form, refs, modelId);
        const mask = parseDataUrl(req.mask);
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
            aspectRatio: options.aspectRatio,
            imageSize: options.imageSize
          } }
        })
      }));
      return { images: await parseGeminiImages(await readJson(response, modelId), modelId), model: modelId };
    }
    case "flux-2-pro": {
      const adaptedRefs = await Promise.all(refs.map(adaptFluxReference));
      const inputImages = Object.fromEntries(adaptedRefs.map((ref, index) => [
        index === 0 ? "input_image" : `input_image_${index + 1}`,
        ref
      ]));
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId),
          prompt: req.prompt,
          width: options.width,
          height: options.height,
          output_format: options.outputFormat,
          ...inputImages
        })
      }));
      return { images: await parseOpenAiImages(await readJson(response, modelId), modelId, { urlOnly: true, maxImages: 1 }), model: modelId };
    }
    case "seedream-5-0-260128": {
      response = await fetchApiyi(modelId, contract.edit.path, () => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiyiApiKey()}` },
        body: JSON.stringify({
          model: upstreamModelId(modelId),
          prompt: req.prompt,
          image: refs,
          size: options.size,
          response_format: "b64_json",
          watermark: false,
          sequential_image_generation: "disabled"
        })
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
function createApiyiProvider(modelId) {
  return {
    id: modelId,
    validate: (req, mode) => validateApiyiRequest(modelId, req, mode),
    generate: (req) => generate(modelId, req),
    edit: (req) => edit(modelId, req)
  };
}
var apiyiProviders = Object.fromEntries(
  [
    "gpt-image-2",
    "gpt-image-2-vip",
    "gemini-3.1-flash-image",
    "flux-2-pro",
    "seedream-5-0-260128",
    "grok-imagine-image"
  ].map((modelId) => [modelId, createApiyiProvider(modelId)])
);

// server/providers/index.ts
var providers = { ...apiyiProviders };
function getProvider(id) {
  const p = providers[id];
  if (!p) {
    throw new ProviderError(`Unknown provider id: ${id}`, 400);
  }
  return p;
}

// server/providers/exact.ts
function logProviderFailure(provider, error, options, attempt) {
  console.error("[ai-provider-failure]", JSON.stringify({
    runId: options.runId ?? "unknown",
    nodeId: options.nodeId ?? "unknown",
    providerId: error.providerId ?? provider.id,
    status: error.status ?? null,
    category: error.category,
    attempt,
    diagnostic: sanitizedProviderDiagnostic(error) ?? error.message
  }));
}
async function generateExactImages(provider, request, requestedCount, options = {}) {
  const target = Math.max(1, Math.min(8, Math.floor(requestedCount) || 1));
  const images = [];
  const providerOutputSizes = [];
  const failures = [];
  let model = provider.id;
  let providerRequests = 0;
  let firstError;
  const maxRequests = target;
  while (images.length < target && providerRequests < maxRequests) {
    const remaining = target - images.length;
    const current = { ...request, batchSize: Math.min(4, remaining) };
    const mode = current.referenceImages?.length ? "edit" : "generate";
    await provider.validate?.(current, mode);
    await options.beforeProviderCall?.(providerRequests + 1);
    providerRequests += 1;
    try {
      const result = mode === "edit" ? await provider.edit(current) : await provider.generate(current);
      model = result.model;
      const accepted = result.images.map((image, index) => ({ image, providerOutputSize: result.providerOutputSizes?.[index] ?? null })).filter((item) => Boolean(item.image)).slice(0, remaining);
      images.push(...accepted.map((item) => item.image));
      providerOutputSizes.push(...accepted.map((item) => item.providerOutputSize));
      if (accepted.length === 0) {
        failures.push("\u6A21\u578B\u672A\u8FD4\u56DE\u56FE\u7247");
        break;
      }
    } catch (error) {
      firstError ??= error;
      if (error instanceof ProviderError) logProviderFailure(provider, error, options, providerRequests);
      if (error instanceof ProviderError && error.category === "outcome_unknown") throw error;
      if (images.length > 0) {
        failures.push(publicProviderErrorMessage(error));
        break;
      }
      failures.push(publicProviderErrorMessage(error));
      break;
    }
  }
  if (images.length === 0) throw firstError instanceof Error ? firstError : new Error(failures[0] ?? "\u6A21\u578B\u672A\u8FD4\u56DE\u56FE\u7247");
  if (images.length < target) failures.push(`\u53EA\u751F\u6210\u4E86 ${images.length}/${target} \u5F20\u56FE\u7247`);
  return {
    images,
    model,
    providerRequests,
    failures,
    providerOutputSizes: providerOutputSizes.some((size) => size !== null) ? providerOutputSizes : void 0
  };
}

// server/lib/fileStore.ts
import fs2 from "node:fs";
import path2 from "node:path";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { nanoid } from "nanoid";
import sharp4 from "sharp";

// server/lib/uploadImageNormalization.ts
import sharp3 from "sharp";
var inputContract = model_contracts_default.inputNormalization;
var UPLOAD_MAX_INPUT_BYTES = inputContract.maxInputBytes;
var UPLOAD_MAX_INPUT_PIXELS = inputContract.maxInputPixels;
var UPLOAD_MAX_LONG_EDGE = inputContract.maxLongEdge;
var UPLOAD_TARGET_BYTES = inputContract.targetBytes;
var UPLOAD_JPEG_QUALITY = inputContract.jpegQuality.initial;
var UPLOAD_MIN_JPEG_QUALITY = inputContract.jpegQuality.minimum;
var MIN_SHRINK_LONG_EDGE = 256;
var SHARP_INPUT_OPTIONS = {
  animated: false,
  failOn: "error",
  limitInputPixels: UPLOAD_MAX_INPUT_PIXELS,
  sequentialRead: true
};
function orientedDimensions(metadata) {
  if (!metadata.width || !metadata.height) {
    throw new ImageValidationError("\u65E0\u6CD5\u8BFB\u53D6\u56FE\u7247\u5C3A\u5BF8\uFF0C\u8BF7\u6362\u4E00\u5F20\u6807\u51C6 PNG\u3001JPEG\u3001WebP \u6216 GIF \u56FE\u7247");
  }
  if (metadata.width * metadata.height > UPLOAD_MAX_INPUT_PIXELS) {
    throw new ImageValidationError(
      `\u56FE\u7247\u50CF\u7D20\u8FC7\u5927\uFF08\u6700\u591A ${UPLOAD_MAX_INPUT_PIXELS.toLocaleString("en-US")} \u50CF\u7D20\uFF09\uFF0C\u8BF7\u7F29\u5C0F\u540E\u91CD\u8BD5`
    );
  }
  const swapsAxes = metadata.orientation !== void 0 && metadata.orientation >= 5 && metadata.orientation <= 8;
  return swapsAxes ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height };
}
function dimensionsWithinLongEdge(width, height) {
  const longEdge = Math.max(width, height);
  if (longEdge <= UPLOAD_MAX_LONG_EDGE) return { width, height };
  const scale = UPLOAD_MAX_LONG_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}
function smallerDimensions(width, height, encodedBytes) {
  const longEdge = Math.max(width, height);
  if (longEdge <= MIN_SHRINK_LONG_EDGE) {
    throw new ImageValidationError("\u56FE\u7247\u5185\u5BB9\u8FC7\u4E8E\u590D\u6742\uFF0C\u538B\u7F29\u540E\u4ECD\u8D85\u8FC7 1.5MB\uFF0C\u8BF7\u5148\u88C1\u526A\u56FE\u7247\u540E\u91CD\u8BD5");
  }
  const estimated = Math.sqrt(UPLOAD_TARGET_BYTES / Math.max(encodedBytes, 1)) * 0.96;
  const scale = Math.max(0.5, Math.min(0.9, estimated));
  const next = {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale))
  };
  if (next.width === width && next.height === height) {
    return width >= height ? { width: width - 1, height } : { width, height: height - 1 };
  }
  return next;
}
function pipeline(buffer, width, height) {
  return sharp3(buffer, SHARP_INPUT_OPTIONS).rotate().resize({ width, height, fit: "fill" }).toColourspace("srgb");
}
async function encodeJpeg(buffer, width, height, quality) {
  const result = await pipeline(buffer, width, height).flatten({ background: "#ffffff" }).jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true }).toBuffer({ resolveWithObject: true });
  return { buffer: result.data, info: result.info };
}
async function encodeOpaqueWithinLimit(buffer, initialWidth, initialHeight) {
  let width = initialWidth;
  let height = initialHeight;
  for (; ; ) {
    const high = await encodeJpeg(buffer, width, height, UPLOAD_JPEG_QUALITY);
    if (high.buffer.byteLength <= UPLOAD_TARGET_BYTES) return high;
    const low = await encodeJpeg(buffer, width, height, UPLOAD_MIN_JPEG_QUALITY);
    if (low.buffer.byteLength <= UPLOAD_TARGET_BYTES) {
      let best = low;
      let left = UPLOAD_MIN_JPEG_QUALITY + 1;
      let right = UPLOAD_JPEG_QUALITY - 1;
      while (left <= right) {
        const quality = Math.floor((left + right) / 2);
        const candidate = await encodeJpeg(buffer, width, height, quality);
        if (candidate.buffer.byteLength <= UPLOAD_TARGET_BYTES) {
          best = candidate;
          left = quality + 1;
        } else {
          right = quality - 1;
        }
      }
      return best;
    }
    ({ width, height } = smallerDimensions(width, height, low.buffer.byteLength));
  }
}
async function encodeTransparentWithinLimit(buffer, initialWidth, initialHeight) {
  let width = initialWidth;
  let height = initialHeight;
  for (; ; ) {
    const result = await pipeline(buffer, width, height).png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer({ resolveWithObject: true });
    if (result.data.byteLength <= UPLOAD_TARGET_BYTES) return { buffer: result.data, info: result.info };
    ({ width, height } = smallerDimensions(width, height, result.data.byteLength));
  }
}
async function hasMeaningfulAlpha(buffer, metadata) {
  if (!metadata.hasAlpha) return false;
  const alpha = await sharp3(buffer, SHARP_INPUT_OPTIONS).rotate().ensureAlpha().extractChannel("alpha").raw().toBuffer();
  return alpha.some((value) => value < 255);
}
async function normalizeUploadImageDataUrl(dataUrl) {
  const validated = validateImageDataUrl(dataUrl, UPLOAD_MAX_INPUT_BYTES);
  try {
    return await withImageProcessingSlot(async () => {
      const metadata = await sharp3(validated.buffer, SHARP_INPUT_OPTIONS).metadata();
      const oriented = orientedDimensions(metadata);
      const target = dimensionsWithinLongEdge(oriented.width, oriented.height);
      const transparent = await hasMeaningfulAlpha(validated.buffer, metadata);
      const encoded = transparent ? await encodeTransparentWithinLimit(validated.buffer, target.width, target.height) : await encodeOpaqueWithinLimit(validated.buffer, target.width, target.height);
      if (!encoded.info.width || !encoded.info.height) {
        throw new ImageValidationError("\u6807\u51C6\u5316\u540E\u65E0\u6CD5\u8BFB\u53D6\u56FE\u7247\u5C3A\u5BF8");
      }
      return {
        buffer: encoded.buffer,
        mimeType: transparent ? "image/png" : "image/jpeg",
        width: encoded.info.width,
        height: encoded.info.height,
        byteLength: encoded.buffer.byteLength,
        normalized: true
      };
    });
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/pixel limit|exceeds.*pixels|too large/i.test(detail)) {
      throw new ImageValidationError(
        `\u56FE\u7247\u50CF\u7D20\u8FC7\u5927\uFF08\u6700\u591A ${UPLOAD_MAX_INPUT_PIXELS.toLocaleString("en-US")} \u50CF\u7D20\uFF09\uFF0C\u8BF7\u7F29\u5C0F\u540E\u91CD\u8BD5`
      );
    }
    throw new ImageValidationError(
      `\u56FE\u7247\u65E0\u6CD5\u5B8C\u6210\u6807\u51C6\u5316\u5904\u7406\uFF0C\u8BF7\u8F6C\u6362\u4E3A\u6807\u51C6 PNG\u3001JPEG\u3001WebP \u6216 GIF \u540E\u91CD\u8BD5\uFF08${detail.slice(0, 160)}\uFF09`
    );
  }
}

// server/lib/fileStore.ts
var MAX_THUMBNAIL_INPUT_PIXELS = 4e7;
var MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};
var EXT_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
};
function uploadsDir() {
  const dir = path2.join(config.dataDir(), "uploads");
  fs2.mkdirSync(dir, { recursive: true });
  return dir;
}
function thumbnailsDir() {
  const dir = path2.join(config.dataDir(), "thumbnails");
  fs2.mkdirSync(dir, { recursive: true });
  return dir;
}
var thumbnailJobs = /* @__PURE__ */ new Map();
async function ensureThumbnail(id) {
  if (!isSupportedImageFile(id) || path2.basename(id) !== id) throw new Error("invalid file id");
  const source = path2.join(uploadsDir(), id);
  if (!fs2.existsSync(source)) throw new Error("file not found");
  const target = path2.join(thumbnailsDir(), `${id}.webp`);
  const existing = thumbnailJobs.get(id);
  if (existing) return existing;
  const job = (async () => {
    const sourceStat = fs2.statSync(source);
    if (fs2.existsSync(target) && fs2.statSync(target).mtimeMs >= sourceStat.mtimeMs) return target;
    const temporary = path2.join(thumbnailsDir(), `.${id}.${nanoid(6)}.tmp.webp`);
    try {
      await withImageProcessingSlot(async () => {
        await sharp4(source, {
          animated: false,
          failOn: "error",
          limitInputPixels: MAX_THUMBNAIL_INPUT_PIXELS
        }).rotate().resize({ width: 384, height: 384, fit: "inside", withoutEnlargement: true }).webp({ quality: 78, effort: 4 }).toFile(temporary);
      });
      fs2.renameSync(temporary, target);
      return target;
    } finally {
      try {
        fs2.rmSync(temporary, { force: true });
      } catch {
      }
    }
  })().finally(() => thumbnailJobs.delete(id));
  thumbnailJobs.set(id, job);
  return job;
}
function thumbnailUrlForImage(ref) {
  const match = /^\/api\/files\/([^/?#]+)$/.exec(ref);
  return match ? `/api/files/${match[1]}/thumbnail` : ref;
}
function deleteStoredImage(id) {
  if (!isSupportedImageFile(id) || path2.basename(id) !== id) return;
  for (const filePath of [path2.join(uploadsDir(), id), path2.join(thumbnailsDir(), `${id}.webp`)]) {
    try {
      fs2.rmSync(filePath, { force: true });
    } catch {
    }
  }
}
function saveDataUrl(dataUrl) {
  const { mime, buffer } = validateImageDataUrl(dataUrl);
  const ext = MIME_EXT[mime];
  const id = `${nanoid(12)}.${ext}`;
  const filePath = path2.join(uploadsDir(), id);
  const fd = fs2.openSync(filePath, "wx", 384);
  try {
    fs2.writeFileSync(fd, buffer);
    fs2.fsyncSync(fd);
  } catch (error) {
    try {
      fs2.unlinkSync(filePath);
    } catch {
    }
    throw error;
  } finally {
    fs2.closeSync(fd);
  }
  return { id, url: `/api/files/${id}` };
}
async function saveNormalizedUploadDataUrl(dataUrl) {
  const normalized = await normalizeUploadImageDataUrl(dataUrl);
  const ext = MIME_EXT[normalized.mimeType];
  const id = `${nanoid(12)}.${ext}`;
  const filePath = path2.join(uploadsDir(), id);
  let handle;
  try {
    handle = await fs2.promises.open(filePath, "wx", 384);
    await handle.writeFile(normalized.buffer);
    await handle.sync();
  } catch (error) {
    try {
      await fs2.promises.rm(filePath, { force: true });
    } catch {
    }
    throw error;
  } finally {
    await handle?.close();
  }
  return {
    id,
    url: `/api/files/${id}`,
    mimeType: normalized.mimeType,
    width: normalized.width,
    height: normalized.height,
    byteLength: normalized.byteLength,
    normalized: true
  };
}
function resolveToDataUrl(ref) {
  if (!ref.startsWith("/api/files/")) return ref;
  const id = path2.basename(ref);
  const filePath = path2.join(uploadsDir(), id);
  if (!fs2.existsSync(filePath)) {
    throw new Error(`referenced file not found: ${id}`);
  }
  const ext = path2.extname(id).slice(1).toLowerCase();
  const expectedMime = EXT_MIME[ext];
  if (!expectedMime) throw new Error(`unsupported referenced file type: ${ext}`);
  const buffer = fs2.readFileSync(filePath);
  if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`referenced image too large: ${id}`);
  const mime = detectImageMime(buffer);
  if (!mime || mime !== expectedMime) throw new Error(`referenced file is not a valid ${expectedMime} image: ${id}`);
  const base64 = buffer.toString("base64");
  return `data:${mime};base64,${base64}`;
}
function mimeOfFile(id) {
  const ext = path2.extname(id).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? "image/png";
}
function isSupportedImageFile(id) {
  return Object.prototype.hasOwnProperty.call(EXT_MIME, path2.extname(id).slice(1).toLowerCase());
}
var MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
var DOWNLOAD_TIMEOUT_MS = 3e4;
var MAX_REDIRECTS = 5;
function ipv4Number(address) {
  const pieces = address.split(".");
  if (pieces.length !== 4) return null;
  let result = 0;
  for (const piece of pieces) {
    if (!/^\d{1,3}$/.test(piece)) return null;
    const value = Number(piece);
    if (value < 0 || value > 255) return null;
    result = result * 256 + value;
  }
  return result >>> 0;
}
function inV4Cidr(value, base, prefix) {
  const block = 2 ** (32 - prefix);
  return Math.floor(value / block) === Math.floor(base / block);
}
function expandIpv6(address) {
  const pieces = address.split("::");
  if (pieces.length > 2) return null;
  const left = pieces[0] ? pieces[0].split(":") : [];
  const right = pieces.length === 2 && pieces[1] ? pieces[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || pieces.length === 1 && missing !== 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => Number.parseInt(group, 16));
}
function isGlobalIpAddress(raw) {
  let address = raw.toLowerCase().split("%")[0];
  if (address.startsWith("::") && address.includes(".")) {
    const embedded = address.slice(address.lastIndexOf(":") + 1);
    return isGlobalIpAddress(embedded);
  }
  if (address.startsWith("::ffff:")) {
    const mapped = address.slice(7);
    if (isIP(mapped) === 4) return isGlobalIpAddress(mapped);
    const groups2 = mapped.split(":");
    if (groups2.length === 2 && groups2.every((part) => /^[0-9a-f]{1,4}$/.test(part))) {
      const value = Number.parseInt(groups2[0], 16) * 65536 + Number.parseInt(groups2[1], 16) >>> 0;
      return isGlobalIpAddress(`${value >>> 24}.${value >>> 16 & 255}.${value >>> 8 & 255}.${value & 255}`);
    }
    return false;
  }
  if (isIP(address) === 4) {
    const value = ipv4Number(address);
    if (value === null) return false;
    const blocked = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4]
    ];
    return !blocked.some(([base, prefix]) => inV4Cidr(value, ipv4Number(base), prefix));
  }
  if (isIP(address) !== 6) return false;
  const groups = expandIpv6(address);
  if (!groups) return false;
  const first = groups[0];
  if (address === "::" || address === "::1") return false;
  if (first === 0 && groups.slice(1, 5).every((group) => group === 0)) return false;
  if ((first & 65024) === 64512) return false;
  if ((first & 65472) === 65152) return false;
  if ((first & 65280) === 65280) return false;
  if (first === 8193 && groups[1] === 3512) return false;
  if (first === 8193 && groups[1] === 0) return false;
  if (first === 8194) return false;
  return true;
}
async function defaultHostLookup(hostname) {
  return (await dns.lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}
async function pinnedFetch(u, init, address) {
  return await new Promise((resolve, reject) => {
    const client = u.protocol === "https:" ? https : http;
    const request = client.request(
      u,
      {
        method: "GET",
        headers: { accept: "image/*", host: u.host },
        signal: init.signal ?? void 0,
        lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
        ...u.protocol === "https:" ? { servername: u.hostname } : {}
      },
      (response) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        response.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.byteLength;
          if (total > MAX_DOWNLOAD_BYTES) {
            settled = true;
            response.destroy(new Error(`image too large: more than ${MAX_DOWNLOAD_BYTES} bytes`));
            reject(new Error(`image too large: more than ${MAX_DOWNLOAD_BYTES} bytes`));
            return;
          }
          chunks.push(buffer);
        });
        response.once("error", (error) => {
          if (!settled) reject(error);
        });
        response.once("end", () => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks, total);
          resolve({
            ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
            status: response.statusCode ?? 0,
            headers: { get: (name) => {
              const value = response.headers[name.toLowerCase()];
              return Array.isArray(value) ? value.join(", ") : value ?? null;
            } },
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
          });
        });
      }
    );
    request.once("error", reject);
    request.end();
  });
}
async function assertUrlAllowed(raw, lookup = defaultHostLookup) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`blocked protocol: ${u.protocol}`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "metadata.google.internal" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    throw new Error(`blocked private/metadata host: ${host}`);
  }
  const addresses = isIP(host) ? [host] : await lookup(host);
  if (addresses.length === 0) throw new Error(`hostname did not resolve: ${host}`);
  const blocked = addresses.find((address) => !isGlobalIpAddress(address));
  if (blocked) throw new Error(`blocked non-global address for ${host}: ${blocked}`);
  return u;
}
async function downloadImageToDataUrl(raw, dependencies) {
  const lookup = dependencies?.lookup ?? defaultHostLookup;
  const fetcher = dependencies?.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    let u = await assertUrlAllowed(raw, lookup);
    let res;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const addresses = isIP(u.hostname) ? [u.hostname] : await lookup(u.hostname);
      const blocked = addresses.find((address) => !isGlobalIpAddress(address));
      if (addresses.length === 0 || blocked) throw new Error(`blocked non-global address for ${u.hostname}: ${blocked ?? "no addresses"}`);
      res = fetcher ? await fetcher(u, { signal: ctrl.signal, redirect: "manual" }) : await pinnedFetch(u, { signal: ctrl.signal, redirect: "manual" }, addresses[0]);
      if (![301, 302, 303, 307, 308].includes(res.status)) break;
      if (redirects === MAX_REDIRECTS) throw new Error(`too many image redirects (limit ${MAX_REDIRECTS})`);
      const location = res.headers.get("location");
      if (!location) throw new Error(`image redirect missing Location header: HTTP ${res.status}`);
      u = await assertUrlAllowed(new URL(location, u), lookup);
    }
    if (!res) throw new Error("image download did not produce a response");
    if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
    const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!mime.startsWith("image/")) {
      throw new Error(`not an image response: ${mime || "unknown content-type"}`);
    }
    const contentLength = Number(res.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`image too large: ${contentLength} bytes (limit ${MAX_DOWNLOAD_BYTES})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error("empty image response");
    if (buf.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new Error(`image too large: ${buf.byteLength} bytes (limit ${MAX_DOWNLOAD_BYTES})`);
    }
    const detected = detectImageMime(buf);
    if (!detected || detected !== mime) throw new Error(`image MIME/signature mismatch: declared ${mime || "unknown"}, detected ${detected || "unknown"}`);
    return toDataUrl(buf.toString("base64"), detected);
  } finally {
    clearTimeout(timer);
  }
}
async function normalizeImageRef(ref) {
  if (ref.startsWith("data:")) {
    const { mime, buffer } = validateImageDataUrl(ref);
    return toDataUrl(buffer.toString("base64"), mime);
  }
  if (ref.startsWith("/api/files/")) return resolveToDataUrl(ref);
  if (ref.startsWith("http://") || ref.startsWith("https://")) {
    return downloadImageToDataUrl(ref);
  }
  throw new Error(`unsupported image reference: ${ref.slice(0, 80)}`);
}
async function persistImageRef(ref) {
  if (ref.startsWith("/api/files/")) return ref;
  const dataUrl = await normalizeImageRef(ref);
  return saveDataUrl(dataUrl).url;
}

// server/lib/database.ts
import pg from "pg";
import { nanoid as nanoid2 } from "nanoid";

// server/lib/password.ts
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
var KEY_LENGTH = 64;
function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}
function verifyPassword(password, encoded) {
  const [algorithm, saltText, hashText] = encoded.split("$");
  if (algorithm !== "scrypt" || !saltText || !hashText) return false;
  try {
    const salt = Buffer.from(saltText, "base64url");
    const expected = Buffer.from(hashText, "base64url");
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
function validatePassword(password) {
  if (password.length < 10) return "\u5BC6\u7801\u81F3\u5C11\u9700\u8981 10 \u4F4D";
  if (password.length > 200) return "\u5BC6\u7801\u4E0D\u80FD\u8D85\u8FC7 200 \u4F4D";
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return "\u5BC6\u7801\u5FC5\u987B\u540C\u65F6\u5305\u542B\u5B57\u6BCD\u548C\u6570\u5B57";
  return void 0;
}

// server/lib/sqliteImport.ts
import fs3 from "node:fs";
import Database from "better-sqlite3";
var TABLES = [
  { name: "users", columns: ["id", "account_id", "display_name", "role", "password_hash", "must_change_password", "active", "deleted_at", "created_at", "updated_at"] },
  { name: "sessions", columns: ["token_hash", "user_id", "created_at", "expires_at"] },
  { name: "projects", columns: ["id", "owner_id", "name", "flow_json", "updated_at", "created_at", "deleted_at", "purge_after"] },
  { name: "files", columns: ["id", "owner_id", "source_type", "project_id", "node_id", "run_id", "created_at"] },
  { name: "assets", columns: ["id", "owner_id", "scope", "name", "category", "image", "source_note", "created_at", "deleted_at", "purge_after"] },
  { name: "project_asset_refs", columns: ["project_id", "asset_id", "created_at"] },
  { name: "generation_runs", columns: ["id", "owner_id", "project_id", "project_name", "node_id", "node_label", "kind", "prompt", "parameters_json", "reference_images_json", "model", "requested_count", "successful_count", "provider_requests", "status", "error", "started_at", "finished_at"] },
  { name: "generation_outputs", columns: ["id", "run_id", "image", "prompt", "status", "error", "created_at"] },
  { name: "usage_events", columns: ["id", "owner_id", "run_id", "project_id", "node_id", "model", "successful_count", "provider_requests", "duration_ms", "created_at"] }
];
function sqliteTableExists(source, table) {
  return Boolean(source.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}
async function importTable(source, client, name, columns) {
  if (!sqliteTableExists(source, name)) return 0;
  const rows = source.prepare(`SELECT ${columns.join(", ")} FROM ${name}`).all();
  if (rows.length === 0) return 0;
  const columnSql = columns.map((column) => `"${column}"`).join(", ");
  const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
  for (const row of rows) {
    const valuesSql = name === "project_asset_refs" ? `SELECT ${placeholders}
         WHERE EXISTS (SELECT 1 FROM projects WHERE id = $1)
           AND EXISTS (SELECT 1 FROM assets WHERE id = $2)` : `VALUES (${placeholders})`;
    await client.query(
      `INSERT INTO "${name}" (${columnSql}) ${valuesSql} ON CONFLICT DO NOTHING`,
      columns.map((column) => row[column] ?? null)
    );
  }
  return rows.length;
}
async function importSqliteIfNeeded(client) {
  const target = (await client.query("SELECT COUNT(*)::int AS count FROM users")).rows[0];
  if ((target?.count ?? 0) > 0) return void 0;
  const sourcePath = config.sqliteImportPath();
  if (!fs3.existsSync(sourcePath) || fs3.statSync(sourcePath).size === 0) return void 0;
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    if (!sqliteTableExists(source, "users")) return void 0;
    let imported = 0;
    for (const table of TABLES) imported += await importTable(source, client, table.name, table.columns);
    return imported;
  } catch (error) {
    throw new Error(`SQLite \u6570\u636E\u8FC1\u79FB\u5230 PostgreSQL \u5931\u8D25\uFF1A${error instanceof Error ? error.message : String(error)}`);
  } finally {
    source.close();
  }
}

// server/lib/database.ts
var { Pool, types } = pg;
types.setTypeParser(20, Number);
var pool;
var initialization;
var REQUIRED_POSTGRES_MAJOR = 18;
function db() {
  if (!pool) {
    const connectionString = config.databaseUrl();
    pool = new Pool({
      ...connectionString ? { connectionString } : {
        host: config.databaseHost(),
        port: config.databasePort(),
        database: config.databaseName(),
        user: config.databaseUser(),
        password: config.databasePassword()
      },
      max: config.databasePoolSize(),
      connectionTimeoutMillis: 1e4,
      idleTimeoutMillis: 3e4
    });
    pool.on("error", (error) => console.error("[garment-canvas] PostgreSQL idle client error", error));
  }
  return pool;
}
async function query(text, values = [], client = db()) {
  return (await client.query(text, values)).rows;
}
async function queryOne(text, values = [], client = db()) {
  return (await client.query(text, values)).rows[0];
}
async function transaction(fn) {
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
async function initializeDatabase() {
  initialization ??= (async () => {
    await assertDatabaseVersion();
    await migrate();
    await bootstrapInitialAdmin();
  })();
  return initialization;
}
async function assertDatabaseVersion() {
  const row = await queryOne(
    "SELECT current_setting('server_version_num')::int AS version_num"
  );
  const major = Math.floor((row?.version_num ?? 0) / 1e4);
  if (major !== REQUIRED_POSTGRES_MAJOR) {
    throw new Error(
      `PostgreSQL ${REQUIRED_POSTGRES_MAJOR} is required; connected server is major version ${major || "unknown"}`
    );
  }
}
async function migrate() {
  const importedRows = await transaction(async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    await client.query("LOCK TABLE schema_migrations IN EXCLUSIVE MODE");
    const appliedRows = await query(
      "SELECT version FROM schema_migrations",
      [],
      client
    );
    const applied = new Set(appliedRows.map((row) => row.version));
    if (!applied.has(1)) {
      await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','user')),
      password_hash TEXT NOT NULL,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      flow_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id),
      source_type TEXT NOT NULL DEFAULT 'upload',
      project_id TEXT,
      node_id TEXT,
      run_id TEXT,
      mime_type TEXT,
      width INTEGER,
      height INTEGER,
      byte_length INTEGER,
      normalized BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS files_owner_idx ON files(owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      owner_id TEXT REFERENCES users(id),
      scope TEXT NOT NULL CHECK (scope IN ('global','private','shared')),
      name TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('print','fabric','reference')),
      image TEXT NOT NULL,
      source_note TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS assets_scope_owner_idx ON assets(scope, owner_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS project_asset_refs (
      project_id TEXT NOT NULL,
      asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, asset_id)
    );

    CREATE TABLE IF NOT EXISTS generation_runs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      project_id TEXT,
      project_name TEXT,
      node_id TEXT NOT NULL,
      node_label TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt TEXT,
      parameters_json TEXT,
      reference_images_json TEXT,
      model TEXT,
      requested_count INTEGER NOT NULL DEFAULT 1,
      successful_count INTEGER NOT NULL DEFAULT 0,
      provider_requests INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('queued','running','success','error')),
      error TEXT,
      started_at BIGINT NOT NULL,
      finished_at BIGINT,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS generation_runs_owner_idx ON generation_runs(owner_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS generation_outputs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
      image TEXT NOT NULL DEFAULT '',
      prompt TEXT,
      status TEXT NOT NULL CHECK (status IN ('success','error')),
      error TEXT,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS generation_outputs_run_idx ON generation_outputs(run_id, created_at);

    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      run_id TEXT NOT NULL UNIQUE REFERENCES generation_runs(id) ON DELETE RESTRICT,
      project_id TEXT,
      node_id TEXT NOT NULL,
      model TEXT,
      successful_count INTEGER NOT NULL CHECK (successful_count > 0),
      provider_requests INTEGER NOT NULL DEFAULT 1,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      deleted_at TEXT,
      purge_after TEXT
    );
    CREATE INDEX IF NOT EXISTS usage_owner_idx ON usage_events(owner_id, created_at DESC);
      `);
      await client.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, $1, $2)",
        ["initial_schema", (/* @__PURE__ */ new Date()).toISOString()]
      );
    }
    const imported = await importSqliteIfNeeded(client);
    if (!applied.has(2)) {
      await client.query(`
        DELETE FROM project_asset_refs refs
        WHERE NOT EXISTS (SELECT 1 FROM projects WHERE projects.id = refs.project_id)
           OR NOT EXISTS (SELECT 1 FROM assets WHERE assets.id = refs.asset_id)
      `);
      await client.query(`
        DO $$
        DECLARE
          existing_constraint RECORD;
        BEGIN
          FOR existing_constraint IN
            SELECT constraint_row.conname
            FROM pg_constraint constraint_row
            JOIN pg_attribute column_row
              ON column_row.attrelid = constraint_row.conrelid
             AND column_row.attnum = ANY(constraint_row.conkey)
            WHERE constraint_row.contype = 'f'
              AND constraint_row.conrelid = 'project_asset_refs'::regclass
              AND constraint_row.confrelid = 'projects'::regclass
              AND column_row.attname = 'project_id'
          LOOP
            EXECUTE format(
              'ALTER TABLE project_asset_refs DROP CONSTRAINT %I',
              existing_constraint.conname
            );
          END LOOP;
          ALTER TABLE project_asset_refs
            ADD CONSTRAINT project_asset_refs_project_id_fkey
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE;
        END
        $$
      `);
      await client.query(
        "CREATE INDEX IF NOT EXISTS project_asset_refs_asset_idx ON project_asset_refs(asset_id)"
      );
      await client.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, $1, $2)",
        ["project_asset_refs_project_foreign_key", (/* @__PURE__ */ new Date()).toISOString()]
      );
    }
    if (!applied.has(3)) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS revoked_sessions (
          token_hash TEXT PRIMARY KEY,
          reason TEXT NOT NULL CHECK (reason IN ('replaced')),
          revoked_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS revoked_sessions_expiry_idx ON revoked_sessions(expires_at);
      `);
      await client.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, $1, $2)",
        ["revoked_session_reasons", (/* @__PURE__ */ new Date()).toISOString()]
      );
    }
    if (!applied.has(4)) {
      await client.query("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_account_id_key");
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS users_active_account_id_unique
        ON users(account_id) WHERE deleted_at IS NULL
      `);
      await client.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, $1, $2)",
        ["active_account_id_unique", (/* @__PURE__ */ new Date()).toISOString()]
      );
    }
    if (!applied.has(5)) {
      await client.query(`
        ALTER TABLE files ADD COLUMN IF NOT EXISTS deleted_at TEXT;
        ALTER TABLE files ADD COLUMN IF NOT EXISTS purge_after TEXT;
        ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS deleted_at TEXT;
        ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS purge_after TEXT;
        ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS deleted_at TEXT;
        ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS purge_after TEXT;
        CREATE INDEX IF NOT EXISTS files_purge_idx ON files(purge_after);
        CREATE INDEX IF NOT EXISTS generation_runs_purge_idx ON generation_runs(purge_after);
        CREATE INDEX IF NOT EXISTS usage_events_purge_idx ON usage_events(purge_after);
      `);
      await client.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, $1, $2)",
        ["account_data_retention_tombstones", (/* @__PURE__ */ new Date()).toISOString()]
      );
    }
    if (!applied.has(6)) {
      await client.query(`
        ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS plan_json TEXT;
        ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS target_step_id TEXT;
        ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS run_type TEXT NOT NULL DEFAULT 'workflow';
        ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS updated_at BIGINT;
        ALTER TABLE generation_runs ADD COLUMN IF NOT EXISTS cancel_requested_at BIGINT;
        UPDATE generation_runs SET updated_at = COALESCE(updated_at, finished_at, started_at);
        ALTER TABLE generation_runs DROP CONSTRAINT IF EXISTS generation_runs_status_check;
        ALTER TABLE generation_runs ADD CONSTRAINT generation_runs_status_check CHECK (status IN (
          'queued','running','retry_wait','cancel_requested','cancelled',
          'succeeded','failed','outcome_unknown','success','error'
        ));
        ALTER TABLE generation_runs DROP CONSTRAINT IF EXISTS generation_runs_run_type_check;
        ALTER TABLE generation_runs ADD CONSTRAINT generation_runs_run_type_check
          CHECK (run_type IN ('workflow','direct'));

        CREATE TABLE IF NOT EXISTS generation_run_steps (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
          step_index INTEGER NOT NULL,
          node_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          step_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN (
            'queued','running','retry_wait','cancel_requested','cancelled',
            'succeeded','failed','outcome_unknown'
          )),
          model TEXT,
          output_images_json TEXT NOT NULL DEFAULT '[]',
          prompts_json TEXT NOT NULL DEFAULT '[]',
          failures_json TEXT NOT NULL DEFAULT '[]',
          provider_requests INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          started_at BIGINT,
          finished_at BIGINT,
          UNIQUE (run_id, step_index),
          UNIQUE (run_id, node_id)
        );
        CREATE INDEX IF NOT EXISTS generation_run_steps_run_idx
          ON generation_run_steps(run_id, step_index);

        CREATE TABLE IF NOT EXISTS generation_jobs (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
          step_id TEXT NOT NULL UNIQUE REFERENCES generation_run_steps(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN (
            'queued','running','retry_wait','cancel_requested','cancelled',
            'succeeded','failed','outcome_unknown'
          )),
          retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 2),
          available_at BIGINT NOT NULL,
          worker_id TEXT,
          lease_expires_at BIGINT,
          attempt_started_at BIGINT,
          last_error TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS generation_jobs_claim_idx
          ON generation_jobs(status, available_at, lease_expires_at);
        CREATE INDEX IF NOT EXISTS generation_jobs_run_idx ON generation_jobs(run_id);

        CREATE TABLE IF NOT EXISTS generation_run_events (
          run_id TEXT NOT NULL REFERENCES generation_runs(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          PRIMARY KEY (run_id, seq)
        );
        CREATE INDEX IF NOT EXISTS generation_run_events_created_idx
          ON generation_run_events(run_id, created_at);
      `);
      await client.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (6, $1, $2)",
        ["durable_generation_queue", (/* @__PURE__ */ new Date()).toISOString()]
      );
    }
    if (!applied.has(7)) {
      await client.query(`
        ALTER TABLE generation_run_steps
          ADD COLUMN IF NOT EXISTS provider_output_sizes_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE generation_outputs
          ADD COLUMN IF NOT EXISTS provider_output_size TEXT;
      `);
      await client.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (7, $1, $2)",
        ["provider_output_size_metadata", (/* @__PURE__ */ new Date()).toISOString()]
      );
    }
    if (!applied.has(8)) {
      await client.query(`
        ALTER TABLE files ADD COLUMN IF NOT EXISTS mime_type TEXT;
        ALTER TABLE files ADD COLUMN IF NOT EXISTS width INTEGER;
        ALTER TABLE files ADD COLUMN IF NOT EXISTS height INTEGER;
        ALTER TABLE files ADD COLUMN IF NOT EXISTS byte_length INTEGER;
        ALTER TABLE files ADD COLUMN IF NOT EXISTS normalized BOOLEAN NOT NULL DEFAULT FALSE;
        ALTER TABLE files DROP CONSTRAINT IF EXISTS files_normalized_metadata_check;
        ALTER TABLE files ADD CONSTRAINT files_normalized_metadata_check CHECK (
          normalized = FALSE OR (
            mime_type IN ('image/png', 'image/jpeg') AND
            width > 0 AND height > 0 AND byte_length > 0
          )
        );
      `);
      await client.query(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (8, $1, $2)",
        ["normalized_upload_metadata", (/* @__PURE__ */ new Date()).toISOString()]
      );
    }
    return imported;
  });
  if (importedRows !== void 0) {
    console.log(
      `[garment-canvas] imported ${importedRows} rows from SQLite into PostgreSQL`
    );
  }
}
async function bootstrapInitialAdmin() {
  const row = await queryOne("SELECT COUNT(*)::int AS count FROM users");
  if ((row?.count ?? 0) > 0) return;
  const accountId = config.initialAdminAccountId();
  const password = config.initialAdminPassword();
  if (!accountId || !password) return;
  const passwordError = validatePassword(password);
  if (passwordError) throw new Error(`INITIAL_ADMIN_PASSWORD \u4E0D\u7B26\u5408\u8981\u6C42\uFF1A${passwordError}`);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await db().query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
    VALUES ($1, $2, $3, 'admin', $4, 1, 1, $5, $5)
    ON CONFLICT (account_id) WHERE deleted_at IS NULL DO NOTHING
  `, [nanoid2(12), accountId, "\u7BA1\u7406\u5458", hashPassword(password), now]);
}
async function hasUsers() {
  const row = await queryOne("SELECT EXISTS(SELECT 1 FROM users) AS ok");
  return row?.ok === true;
}
async function databaseReady() {
  try {
    await assertDatabaseVersion();
    return true;
  } catch {
    return false;
  }
}

// server/lib/imagePostProcessing.ts
import sharp5 from "sharp";
var EXACT_ASPECT_DIMENSIONS = {
  "1:1": { width: 1024, height: 1024 },
  "3:4": { width: 1152, height: 1536 },
  "4:3": { width: 1536, height: 1152 },
  "9:16": { width: 864, height: 1536 },
  "16:9": { width: 1536, height: 864 }
};
var WEBP_QUALITIES = [92, 84, 76, 68, 60, 50, 40, 30, 20, 10];
var SHARP_INPUT_OPTIONS2 = {
  animated: false,
  failOn: "warning",
  limitInputPixels: 4e7
};
function isExactAspectRatio(value) {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EXACT_ASPECT_DIMENSIONS, value);
}
function isUpscaleSize(value) {
  return value === "2K" || value === "4K";
}
function normalizeExactAspectRatio(value) {
  return isExactAspectRatio(value) ? value : "1:1";
}
function normalizeUpscaleSize(value) {
  return isUpscaleSize(value) ? value : "2K";
}
async function imageRefToBuffer(ref) {
  const dataUrl = await normalizeImageRef(ref);
  return validateImageDataUrl(dataUrl).buffer;
}
async function encodeWebpWithinLimit(image) {
  for (const quality of WEBP_QUALITIES) {
    const output = await image.clone().webp({ quality, effort: 4, smartSubsample: true }).toBuffer();
    if (output.byteLength <= MAX_IMAGE_BYTES) return output;
  }
  throw new Error(`processed image exceeds ${MAX_IMAGE_BYTES} bytes even at minimum quality`);
}
function toWebpDataUrl(buffer) {
  return `data:image/webp;base64,${buffer.toString("base64")}`;
}
async function fitGeneratedImageToAspect(ref, aspectRatio) {
  return withImageProcessingSlot(async () => {
    const normalizedAspectRatio = normalizeExactAspectRatio(aspectRatio);
    const input = await imageRefToBuffer(ref);
    const { width, height } = EXACT_ASPECT_DIMENSIONS[normalizedAspectRatio];
    const source = sharp5(input, SHARP_INPUT_OPTIONS2).rotate();
    const { dominant } = await source.clone().stats();
    const background = { r: dominant.r, g: dominant.g, b: dominant.b, alpha: 1 };
    const output = await encodeWebpWithinLimit(
      source.resize({ width, height, fit: "contain", position: "centre", background }).flatten({ background }).toColourspace("srgb")
    );
    return toWebpDataUrl(output);
  });
}
async function upscaleImageToLongEdge(ref, imageSize) {
  return withImageProcessingSlot(async () => {
    const normalizedImageSize = normalizeUpscaleSize(imageSize);
    const input = await imageRefToBuffer(ref);
    const longEdge = normalizedImageSize === "4K" ? 4096 : 2048;
    const output = await encodeWebpWithinLimit(
      sharp5(input, SHARP_INPUT_OPTIONS2).rotate().resize({ width: longEdge, height: longEdge, fit: "inside" }).toColourspace("srgb")
    );
    return toWebpDataUrl(output);
  });
}

// src/lib/colors.ts
var COLOR_CATEGORIES = [
  {
    id: "neutral",
    label: "\u4E2D\u6027\u57FA\u7840\u8272",
    swatches: [
      { name: "\u78B3\u7D20\u9ED1", hex: "#161616" },
      { name: "\u68D5\u9ED1", hex: "#2B1D16" },
      { name: "\u70AD\u9ED1", hex: "#1A1A1A" },
      { name: "\u66AE\u8272\u7070", hex: "#6B6B70" },
      { name: "\u70DF\u7070", hex: "#6E6E6E" },
      { name: "\u6DF1\u6D77\u9E25\u7070", hex: "#8B9296" },
      { name: "\u6C34\u6CE5\u7070", hex: "#9A9A98" },
      { name: "\u5927\u8C61\u7070", hex: "#8A8378" },
      { name: "\u66AE\u6C99\u7070", hex: "#A39B8B" },
      { name: "\u4E91\u70DF\u7070", hex: "#B9B7B2" },
      { name: "\u6D45\u7070", hex: "#C8C8C8" },
      { name: "\u73CD\u73E0\u767D", hex: "#F2EFE9" },
      { name: "\u71D5\u9EA6\u767D", hex: "#EDE6D6" },
      { name: "\u739B\u7459\u767D", hex: "#E9E4DA" },
      { name: "\u7C73\u767D", hex: "#F5F0E6" },
      { name: "\u67D4\u548C\u7C73", hex: "#E5DCC8" },
      { name: "\u5976\u674F\u7C73", hex: "#F0E4CE" },
      { name: "\u7EAF\u767D", hex: "#FFFFFF" },
      { name: "\u9999\u69DF\u8272", hex: "#F0DCB8" },
      { name: "\u9A7C\u8272", hex: "#C19A6B" },
      { name: "\u5361\u5176", hex: "#B8A47E" },
      { name: "\u5496\u5561", hex: "#6F4E37" },
      { name: "\u6989\u6728\u8272", hex: "#A67B4F" },
      { name: "\u7126\u7CD6", hex: "#A0522D" }
    ]
  },
  {
    id: "warm",
    label: "\u6696\u8272\u7CFB",
    swatches: [
      // 红
      { name: "\u7194\u5CA9\u7EA2", hex: "#B03A2E" },
      { name: "\u4E2D\u56FD\u7EA2", hex: "#DE2910" },
      { name: "\u6B63\u7EA2", hex: "#C8102E" },
      { name: "\u6A31\u6843\u7EA2", hex: "#C2183C" },
      { name: "\u6CE2\u826E\u7B2C\u7EA2", hex: "#5C1A24" },
      { name: "\u9152\u7EA2", hex: "#722F37" },
      { name: "\u6885\u6D1B\u8461\u8404\u9152\u7EA2", hex: "#6E2438" },
      { name: "\u7816\u7EA2", hex: "#B5493A" },
      // 粉
      { name: "\u8393\u679C\u7C89", hex: "#D98CA6" },
      { name: "\u82AD\u6BD4\u7C89", hex: "#E0219C" },
      { name: "\u73CA\u745A\u7C89", hex: "#F88379" },
      { name: "\u85D5\u7C89", hex: "#E8C4C4" },
      { name: "\u73AB\u7470\u8336", hex: "#C08585" },
      { name: "\u96FE\u73AB\u7470\u8272", hex: "#B48A8C" },
      { name: "\u7070\u7C89\u73AB", hex: "#C4A4A8" },
      { name: "\u73AB\u7470\u91D1", hex: "#B76E79" },
      // 橙
      { name: "\u7231\u9A6C\u4ED5\u6A59", hex: "#F37021" },
      { name: "\u6A58\u6A59", hex: "#E8752A" },
      { name: "\u67F3\u6A59\u6C41\u6A58", hex: "#F28C28" },
      { name: "\u9999\u74DC\u6A59", hex: "#F2A65A" },
      { name: "\u67D4\u548C\u6843", hex: "#F5CBA7" },
      // 黄/金
      { name: "\u82A6\u82C7\u9EC4", hex: "#D9C97A" },
      { name: "\u900F\u660E\u9EC4", hex: "#F5E663" },
      { name: "\u9E45\u9EC4", hex: "#F2D16B" },
      { name: "\u59DC\u9EC4", hex: "#D9A441" },
      { name: "\u91D1\u9EA6\u9EC4", hex: "#D9B24A" },
      { name: "\u7425\u73C0\u9EC4", hex: "#D99400" },
      { name: "\u91D1\u68D5\u6988\u8272", hex: "#C9A227" },
      { name: "\u91D1\u5408\u6B22", hex: "#C77F2F" },
      { name: "\u9999\u69DF\u91D1", hex: "#D4C5A0" },
      // 棕/赭
      { name: "\u8D64\u8910\u8D6D", hex: "#8C4A2F" },
      { name: "\u6817\u8D64\u8272", hex: "#7A3B2E" },
      { name: "\u7EA2\u68D5\u8272", hex: "#8B3A2A" },
      { name: "\u62FF\u94C1\u68D5", hex: "#9C7A5B" },
      { name: "\u8DEF\u6613\u5A01\u767B\u68D5", hex: "#4E3424" },
      { name: "\u51E1\u6234\u514B\u68D5", hex: "#3D2B1F" },
      { name: "\u6DF1\u7119\u68D5", hex: "#4A2E1E" },
      { name: "\u5DE7\u514B\u529B\u8272", hex: "#5C3A24" },
      { name: "\u7194\u5CA9\u70DF\u96FE", hex: "#7A6E6A" }
    ]
  },
  {
    id: "cool",
    label: "\u51B7\u8272\u7CFB",
    swatches: [
      // 绿
      { name: "\u7FE0\u7389\u7EFF", hex: "#2E8B6E" },
      { name: "\u58A8\u7EFF", hex: "#1F3D2B" },
      { name: "\u6DF1\u82D4\u7EFF", hex: "#3B4A2F" },
      { name: "\u6DF1\u6A44\u6984\u7EFF", hex: "#4A5423" },
      { name: "\u6A44\u6984\u7EFF", hex: "#6B7C4A" },
      { name: "\u83B3\u841D\u7EFF", hex: "#6E7F4E" },
      { name: "\u8C5A\u8349\u7EFF", hex: "#8A9A4B" },
      { name: "\u8584\u8377\u7EFF", hex: "#98D8C8" },
      // 蓝
      { name: "\u8482\u8299\u5C3C\u84DD", hex: "#81D8D0" },
      { name: "\u6D77\u6EE8\u84DD", hex: "#4FA3C2" },
      { name: "\u5361\u5E03\u91CC\u84DD", hex: "#3579A8" },
      { name: "\u8FDC\u5C71\u84DD", hex: "#7B9BB8" },
      { name: "\u96FE\u973E\u84DD", hex: "#8FA8BF" },
      { name: "\u725B\u4ED4\u84DD", hex: "#3B5B7C" },
      { name: "\u85CF\u9752", hex: "#1B2A4A" },
      { name: "\u7FA4\u9752", hex: "#4166B0" },
      { name: "\u514B\u83B1\u56E0\u84DD", hex: "#002FA7" },
      { name: "\u7075\u6C14\u975B\u84DD", hex: "#3F4E8C" },
      // 紫
      { name: "\u82CB\u83DC\u7D2B", hex: "#9B2D5F" },
      { name: "\u7D2B\u7F57\u5170\u8272", hex: "#7F5AA2" },
      { name: "\u85B0\u8863\u8349\u7D2B", hex: "#B4A7D6" },
      { name: "\u9999\u828B\u7D2B", hex: "#B8A9C9" },
      { name: "\u70DF\u718F\u7D2B", hex: "#6E5A72" },
      { name: "\u6DF1\u7D2B", hex: "#4A3B5C" },
      { name: "\u94F6\u7070", hex: "#C0C0C0" }
    ]
  }
];
var COLOR_PRESETS = COLOR_CATEGORIES.flatMap((c) => c.swatches);
function nameOfColor(hex) {
  return COLOR_PRESETS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
}
function buildRecolorPrompt(colors) {
  const list = colors.map((hex) => `${nameOfColor(hex)}(${hex})`).join("\u3001");
  return `\u4FDD\u6301\u670D\u88C5\u7684\u7248\u578B\u3001\u6B3E\u5F0F\u7EC6\u8282\u3001\u6784\u56FE\u548C\u5149\u7EBF\u5B8C\u5168\u4E0D\u53D8\uFF0C\u4EC5\u5C06\u9762\u6599\u914D\u8272\u66FF\u6362\u4E3A\uFF1A${list}\u3002\u914D\u8272\u5E94\u7528\u4E8E\u9762\u6599\u4E3B\u4F53\uFF0C\u5448\u73B0\u771F\u5B9E\u9762\u6599\u8D28\u611F\u4E0E\u51C6\u786E\u8272\u5F69\uFF0C\u65E0\u6587\u5B57\u65E0\u6C34\u5370\u3002`;
}

// server/lib/generationRecords.ts
import { nanoid as nanoid3 } from "nanoid";

// server/engine/runner.ts
var DEFAULT_PROMPTS = {
  "sketch-to-render": "\u5C06\u7EBF\u7A3F\u6E32\u67D3\u4E3A\u5199\u5B9E\u670D\u88C5\u6548\u679C\u56FE\uFF0C\u4FDD\u6301\u7ED3\u6784\u4E0E\u8F6E\u5ED3\uFF0C\u9AD8\u7AEF\u65F6\u88C5\u6444\u5F71\u8D28\u611F",
  "ai-modify": "\u5728\u4FDD\u6301\u6574\u4F53\u7248\u578B\u4E0D\u53D8\u7684\u524D\u63D0\u4E0B\uFF0C\u4F18\u5316\u670D\u88C5\u7EC6\u8282\u8BBE\u8BA1",
  "fabric-recolor": "\u4FDD\u6301\u670D\u88C5\u6B3E\u5F0F\u3001\u7EC6\u8282\u3001\u5149\u5F71\u4E0E\u80CC\u666F\u4E0D\u53D8\uFF0C\u4EC5\u66FF\u6362\u9762\u6599\u8D28\u611F"
};
var runs = /* @__PURE__ */ new Map();
var FINISHED_RUN_TTL_MS = 30 * 60 * 1e3;
function getRunForUser(id, ownerId) {
  const run = runs.get(id);
  return run?.ownerId === ownerId ? run : void 0;
}
async function postProcessGeneratedOutputImages(kind, params, images) {
  if (kind !== "sketch-to-render" && kind !== "ai-modify" && kind !== "upscale") return images;
  const aspectRatio = normalizeExactAspectRatio(params.aspectRatio);
  const imageSize = normalizeUpscaleSize(params.imageSize);
  const processed = [];
  for (const image of images) {
    processed.push(
      kind === "upscale" ? await upscaleImageToLongEdge(image, imageSize) : await fitGeneratedImageToAspect(image, aspectRatio)
    );
  }
  return processed;
}
async function executeStep(step, inputImages, resolveProvider = getProvider, runIdOrOptions) {
  const options = typeof runIdOrOptions === "string" ? { runId: runIdOrOptions } : runIdOrOptions ?? {};
  switch (step.kind) {
    case "image-input": {
      const imageUrl2 = step.params.imageUrl;
      return { images: imageUrl2 ? [imageUrl2] : [], providerRequests: 0 };
    }
    case "result": {
      return { images: inputImages, providerRequests: 0 };
    }
    case "sketch-to-render":
    case "ai-modify":
    case "fabric-recolor":
    case "upscale":
    case "print-extract":
    case "print-mutate":
    case "mask-redraw": {
      const modelId = isImageModelId(step.params.modelId) ? step.params.modelId : step.kind === "mask-redraw" ? MASK_REDRAW_MODEL_ID : DEFAULT_GENERATION_MODEL_ID;
      if (!isModelAllowedForNode(modelId, step.kind)) {
        throw new Error(`Model ${modelId} is not allowed for node ${step.nodeId}`);
      }
      const provider = resolveProvider(modelId);
      const modelOptions = step.params.modelOptions;
      if (step.kind === "mask-redraw" && (typeof step.params.maskSourceRef !== "string" || step.params.maskSourceRef !== inputImages[0])) {
        throw new Error("\u8499\u7248\u5BF9\u5E94\u7684\u539F\u56FE\u5DF2\u53D8\u5316\uFF0C\u8BF7\u91CD\u65B0\u7ED8\u5236\u8499\u7248");
      }
      const referenceImages = await resolveImageRefs(inputImages);
      const fabricImageUrl = step.params.fabricImageUrl;
      if (step.kind === "fabric-recolor" && fabricImageUrl) {
        referenceImages.push(...await resolveImageRefs([fabricImageUrl]));
      }
      const maxReferences = Math.min(MAX_REFERENCE_IMAGES, modelMaxReferenceImages(modelId));
      if (referenceImages.length > maxReferences) {
        throw new Error(`Node ${step.nodeId} accepts at most ${maxReferences} reference images for ${modelId}`);
      }
      const extra = (step.params.prompt ?? "").trim();
      if (step.kind === "fabric-recolor") {
        const colors = Array.isArray(step.params.colors) ? step.params.colors.filter((value) => typeof value === "string") : [];
        if (colors.length > 0) {
          const images2 = [];
          const prompts = [];
          const providerOutputSizes = [];
          const failures = [];
          let model;
          let providerRequests = 0;
          let firstError;
          for (const color of colors) {
            const prompt2 = buildRecolorPrompt([color]);
            try {
              const result2 = await generateExactImages(
                provider,
                { prompt: prompt2, referenceImages, modelOptions },
                1,
                { ...options, nodeId: step.nodeId }
              );
              providerRequests += result2.providerRequests;
              model = result2.model;
              for (const [index, image] of result2.images.entries()) {
                images2.push(image);
                prompts.push(prompt2);
                providerOutputSizes.push(result2.providerOutputSizes?.[index] ?? null);
              }
            } catch (err) {
              firstError ??= err;
              if (err instanceof ProviderError && err.category === "outcome_unknown") throw err;
              failures.push({
                prompt: prompt2,
                error: err instanceof ProviderError ? publicProviderErrorMessage(err) : err instanceof Error ? err.message : String(err)
              });
              if (images2.length > 0) break;
              if (err instanceof ProviderError && (err.status === 429 || err.status === 503 || ["gateway_authentication", "invalid_request", "model_unavailable"].includes(err.category))) throw err;
            }
          }
          if (images2.length === 0) {
            throw firstError instanceof Error ? firstError : new Error(failures[0]?.error ?? "\u5168\u90E8\u914D\u8272\u751F\u6210\u5931\u8D25");
          }
          return {
            images: images2,
            prompts,
            model,
            providerRequests,
            providerOutputSizes: providerOutputSizes.some((size) => size !== null) ? providerOutputSizes : void 0,
            failures: failures.length ? failures : void 0
          };
        }
      }
      if (step.kind === "print-mutate") {
        const count = Math.max(1, Math.min(8, Number(step.params.count) || 4));
        const prompt2 = "\u57FA\u4E8E\u8FD9\u5F20\u5370\u82B1\u56FE\u6848\u751F\u6210\u98CE\u683C\u4E00\u81F4\u7684\u65B0\u53D8\u4F53\uFF1A\u4FDD\u6301\u539F\u6709\u914D\u8272\u4F53\u7CFB\u3001\u827A\u672F\u98CE\u683C\u4E0E\u7B14\u89E6\u8D28\u611F\uFF0C\u91CD\u65B0\u7F16\u6392\u5143\u7D20\u7684\u6784\u56FE\u4E0E\u7EC4\u5408\u65B9\u5F0F\uFF0C\u7EAF\u767D\u80CC\u666F\uFF0C\u9002\u5408\u4F5C\u4E3A\u5370\u82B1\u7D20\u6750\u590D\u7528" + (extra ? `\u3002\u8865\u5145\u8981\u6C42\uFF1A${extra}` : "");
        const result2 = await generateExactImages(
          provider,
          { prompt: prompt2, referenceImages, modelOptions },
          count,
          { ...options, nodeId: step.nodeId }
        );
        const failures = result2.failures.map((error) => ({ prompt: prompt2, error }));
        return {
          images: result2.images,
          prompts: result2.images.map(() => prompt2),
          model: result2.model,
          providerRequests: result2.providerRequests,
          providerOutputSizes: result2.providerOutputSizes,
          failures: failures.length ? failures : void 0
        };
      }
      const prompt = step.kind === "upscale" ? "\u5C06\u8FD9\u5F20\u670D\u88C5\u6548\u679C\u56FE\u653E\u5927\u4E3A\u8D85\u9AD8\u6E05\u7248\u672C\uFF0C\u589E\u5F3A\u9762\u6599\u7EB9\u7406\u3001\u8D70\u7EBF\u4E0E\u8FB9\u7F18\u7EC6\u8282\uFF0C\u4FDD\u6301\u539F\u6709\u6784\u56FE\u3001\u8272\u5F69\u548C\u5149\u5F71\u5B8C\u5168\u4E0D\u53D8" : step.kind === "print-extract" ? "\u63D0\u53D6\u8FD9\u4EF6\u8863\u670D\u4E0A\u7684\u5370\u82B1\u56FE\u6848\uFF1A\u5C06\u5370\u82B1\u5B8C\u6574\u62A0\u51FA\u5E76\u5E73\u94FA\u5C55\u5F00\u4E3A\u89C4\u6574\u7684\u77E9\u5F62\u56FE\u6848\uFF0C\u7EAF\u767D\u80CC\u666F\uFF0C\u53BB\u9664\u8863\u8EAB\u3001\u8936\u76B1\u3001\u9634\u5F71\u548C\u7A7F\u7740\u6548\u679C\uFF0C\u5370\u82B1\u7684\u6BD4\u4F8B\u3001\u7EC6\u8282\u548C\u8272\u5F69\u4E0E\u539F\u56FE\u4FDD\u6301\u4E00\u81F4\uFF0C\u9002\u5408\u4F5C\u4E3A\u5370\u82B1\u7D20\u6750\u590D\u7528" + (extra ? `\u3002\u8865\u5145\u8981\u6C42\uFF1A${extra}` : "") : step.kind === "mask-redraw" ? extra : extra || DEFAULT_PROMPTS[step.kind] || NODE_SPECS[step.kind].description;
      if (step.kind === "mask-redraw" && !prompt) {
        throw new Error("\u8499\u7248\u5C40\u90E8\u91CD\u7ED8\u5FC5\u987B\u586B\u5199\u4FEE\u6539\u8BF4\u660E");
      }
      const maskReference = step.kind === "mask-redraw" ? step.params.mask : void 0;
      if (step.kind === "mask-redraw" && (typeof maskReference !== "string" || !maskReference)) {
        throw new Error("\u8499\u7248\u5C40\u90E8\u91CD\u7ED8\u5FC5\u987B\u5148\u4FDD\u5B58 PNG \u8499\u7248");
      }
      const mask = typeof maskReference === "string" ? await normalizeImageRef(maskReference) : void 0;
      const request = {
        prompt,
        referenceImages: referenceImages.length ? referenceImages : void 0,
        aspectRatio: step.kind === "sketch-to-render" || step.kind === "ai-modify" ? normalizeExactAspectRatio(step.params.aspectRatio) : step.params.aspectRatio,
        batchSize: step.params.batchSize,
        imageSize: step.kind === "upscale" ? normalizeUpscaleSize(step.params.imageSize) : void 0,
        modelOptions,
        mask
      };
      const requestedCount = step.kind === "sketch-to-render" || step.kind === "ai-modify" ? Math.max(1, Math.min(8, Number(step.params.batchSize) || 1)) : 1;
      const result = await generateExactImages(
        provider,
        request,
        requestedCount,
        { ...options, nodeId: step.nodeId }
      );
      const providerImages = step.kind === "mask-redraw" ? await Promise.all(result.images.map((image) => compositeMaskedEdit(referenceImages[0], mask, image))) : result.images;
      const images = await postProcessGeneratedOutputImages(step.kind, step.params, providerImages);
      return {
        images,
        model: result.model,
        prompts: images.map(() => prompt),
        providerRequests: result.providerRequests,
        providerOutputSizes: result.providerOutputSizes,
        failures: result.failures.length ? result.failures.map((error) => ({ prompt, error })) : void 0
      };
    }
  }
}
async function resolveImageRefs(refs) {
  const localIds = Array.from(new Set(
    refs.filter(isLocalImageReference).map((ref) => ref.slice("/api/files/".length))
  ));
  const storedInputs = localIds.length === 0 ? [] : await query(`
        SELECT id, source_type, normalized FROM files WHERE id = ANY($1::text[])
      `, [localIds]);
  const metadataById = new Map(storedInputs.map((row) => [row.id, row]));
  return Promise.all(refs.map(async (ref) => {
    const resolved = await normalizeImageRef(ref);
    if (!isLocalImageReference(ref)) return resolved;
    const id = ref.slice("/api/files/".length);
    const metadata = metadataById.get(id);
    if (metadata?.normalized || metadata?.source_type === "generation") return resolved;
    const normalized = await normalizeUploadImageDataUrl(resolved);
    return toDataUrl(normalized.buffer.toString("base64"), normalized.mimeType);
  }));
}

// server/lib/auth.ts
import { createHash, randomBytes as randomBytes2 } from "node:crypto";
var SESSION_COOKIE = "gc_session";
var SESSION_DAYS = 30;
function sessionHash(token) {
  return createHash("sha256").update(token).digest("hex");
}
function cookieValue(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return void 0;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return void 0;
}
async function createSession(userId, options = {}) {
  const token = randomBytes2(32).toString("base64url");
  const now = /* @__PURE__ */ new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1e3).toISOString();
  await transaction(async (client) => {
    const lockedUser = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (lockedUser.rowCount !== 1) throw new Error("\u7528\u6237\u4E0D\u5B58\u5728");
    if (options.markExistingAsReplaced !== false) {
      await client.query(`
        INSERT INTO revoked_sessions (token_hash, reason, revoked_at, expires_at)
        SELECT token_hash, 'replaced', $2, expires_at FROM sessions WHERE user_id = $1
        ON CONFLICT (token_hash) DO UPDATE
          SET reason = excluded.reason, revoked_at = excluded.revoked_at, expires_at = excluded.expires_at
      `, [userId, now.toISOString()]);
    }
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await client.query(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [sessionHash(token), userId, now.toISOString(), expiresAt]
    );
  });
  return { token, expiresAt };
}
function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "true";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1e3
  });
}
function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
}
async function revokeRequestSession(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [sessionHash(token)]);
}
async function revokeUserSessions(userId) {
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}
async function authenticateRequest(req) {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return { status: "unauthenticated" };
  const tokenHash = sessionHash(token);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const row = await queryOne(`
    SELECT u.id, u.account_id, u.display_name, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = 1 AND u.deleted_at IS NULL
  `, [tokenHash, now]);
  if (row) {
    return {
      status: "authenticated",
      user: {
        id: row.id,
        accountId: row.account_id,
        displayName: row.display_name,
        role: row.role,
        mustChangePassword: row.must_change_password === 1
      }
    };
  }
  const revoked = await queryOne(`
    SELECT reason FROM revoked_sessions WHERE token_hash = $1 AND expires_at > $2
  `, [tokenHash, now]);
  return revoked?.reason === "replaced" ? { status: "replaced" } : { status: "unauthenticated" };
}
function authenticateMiddleware() {
  return (req, res, next) => {
    void authenticateRequest(req).then((result) => {
      if (result.status !== "authenticated") {
        const replaced = result.status === "replaced";
        res.status(401).json({
          error: replaced ? "\u8D26\u53F7\u5DF2\u5728\u5176\u4ED6\u8BBE\u5907\u767B\u5F55" : "\u8BF7\u5148\u767B\u5F55",
          code: replaced ? "SESSION_REPLACED" : "UNAUTHENTICATED"
        });
        return;
      }
      req.authUser = result.user;
      next();
    }).catch(next);
  };
}
var requireAuth = authenticateMiddleware();
var requireAuthForSessionCheck = authenticateMiddleware();
function requirePasswordChanged(req, res, next) {
  const user = req.authUser;
  if (user.mustChangePassword) {
    res.status(403).json({ error: "\u9996\u6B21\u767B\u5F55\u5FC5\u987B\u4FEE\u6539\u5BC6\u7801", code: "PASSWORD_CHANGE_REQUIRED" });
    return;
  }
  next();
}
function requireAdmin(req, res, next) {
  const user = req.authUser;
  if (user.role !== "admin") {
    res.status(403).json({ error: "\u9700\u8981\u7BA1\u7406\u5458\u6743\u9650", code: "FORBIDDEN" });
    return;
  }
  next();
}
function requestUser(req) {
  return req.authUser;
}
async function pruneExpiredSessions() {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await transaction(async (client) => {
    await client.query("DELETE FROM sessions WHERE expires_at <= $1", [now]);
    await client.query("DELETE FROM revoked_sessions WHERE expires_at <= $1", [now]);
  });
}

// server/lib/asyncHandler.ts
function asyncHandler(handler) {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

// server/engine/runQueue.ts
import os from "node:os";
import path3 from "node:path";
import { nanoid as nanoid5 } from "nanoid";
var TERMINAL_RUN_STATUSES = /* @__PURE__ */ new Set([
  "cancelled",
  "succeeded",
  "failed",
  "outcome_unknown"
]);
var DEFAULT_LEASE_MS = 45e3;
var DEFAULT_HEARTBEAT_MS = 1e4;
var DEFAULT_POLL_MS = 750;
var DEFAULT_RETRY_DELAYS_MS = [5e3, 15e3];
var CANCELLED_AFTER_START_WARNING = "\u53D6\u6D88\u8BF7\u6C42\u672A\u80FD\u4E2D\u6B62\u5DF2\u7ECF\u5F00\u59CB\u7684\u4E0A\u6E38\u8C03\u7528\uFF0C\u7ED3\u679C\u5DF2\u6309\u5B9E\u9645\u8FD4\u56DE\u4FDD\u5B58";
var DURABLE_RUN_EVENT_BATCH_SIZE = 500;
var CancelledBeforeProviderCall = class extends Error {
  constructor() {
    super("\u4EFB\u52A1\u5DF2\u5728\u4E0A\u6E38\u8C03\u7528\u5F00\u59CB\u524D\u53D6\u6D88");
    this.name = "CancelledBeforeProviderCall";
  }
};
function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(status) || status === "success" || status === "error";
}
async function lockRun(client, runId) {
  return (await client.query(
    "SELECT id, owner_id, project_id, node_id, status, target_step_id, started_at, finished_at FROM generation_runs WHERE id = $1 FOR UPDATE",
    [runId]
  )).rows[0];
}
async function appendRunEvent(client, runId, event, createdAt) {
  const seqRow = (await client.query(`
    SELECT COALESCE(MAX(seq), 0)::int + 1 AS seq
    FROM generation_run_events WHERE run_id = $1
  `, [runId])).rows[0];
  const sequenced = { ...event, seq: seqRow?.seq ?? 1 };
  await client.query(`
    INSERT INTO generation_run_events (run_id, seq, payload_json, created_at)
    VALUES ($1, $2, $3, $4)
  `, [runId, sequenced.seq, JSON.stringify(sequenced), createdAt]);
  return sequenced;
}
async function enqueueGenerationRun(plan, ownerId, context, runType = "workflow") {
  if (!ownerId.trim() || context.userId !== ownerId) throw new Error("run owner is invalid");
  if (plan.steps.length === 0) throw new Error("execution plan has no steps");
  const runId = nanoid5(10);
  const createdAt = Date.now();
  const requestedTargetIndex = plan.steps.findIndex((step) => step.nodeId === context.nodeId);
  const targetIndex = requestedTargetIndex >= 0 ? requestedTargetIndex : plan.steps.length - 1;
  const stepIds = plan.steps.map(() => nanoid5(12));
  const targetStep = plan.steps[targetIndex] ?? plan.steps.at(-1);
  const targetStepId = stepIds[targetIndex] ?? stepIds.at(-1);
  const initialModel = isImageModelId(targetStep.params.modelId) ? targetStep.params.modelId : null;
  await transaction(async (client) => {
    await client.query(`
      INSERT INTO generation_runs (
        id, owner_id, project_id, project_name, node_id, node_label, kind, prompt,
        parameters_json, reference_images_json, model, requested_count, status,
        started_at, plan_json, target_step_id, run_type, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'queued',
        $13, $14, $15, $16, $13
      )
    `, [
      runId,
      ownerId,
      context.projectId ?? null,
      context.projectName ?? null,
      context.nodeId,
      context.nodeLabel,
      context.kind,
      context.prompt ?? null,
      JSON.stringify(context.parameters ?? {}),
      JSON.stringify(context.referenceImages ?? targetStep.inputImages ?? []),
      initialModel,
      context.requestedCount,
      createdAt,
      JSON.stringify(plan),
      targetStepId,
      runType
    ]);
    for (const [index, step] of plan.steps.entries()) {
      const stepId = stepIds[index];
      const model = isImageModelId(step.params.modelId) ? step.params.modelId : null;
      await client.query(`
        INSERT INTO generation_run_steps (
          id, run_id, step_index, node_id, kind, step_json, status, model
        ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)
      `, [stepId, runId, index, step.nodeId, step.kind, JSON.stringify(step), model]);
      await client.query(`
        INSERT INTO generation_jobs (
          id, run_id, step_id, idempotency_key, status, retry_count, available_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'queued', 0, $5, $5, $5)
      `, [nanoid5(12), runId, stepId, `${runId}:${stepId}`, createdAt]);
      await appendRunEvent(client, runId, {
        type: "node-status",
        nodeId: step.nodeId,
        status: "queued",
        startedAt: createdAt
      }, createdAt);
    }
  });
  return { id: runId };
}
async function claimNextJob(workerId, now, leaseMs) {
  return transaction(async (client) => {
    const row = (await client.query(`
      SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
        s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
      FROM generation_jobs j
      JOIN generation_run_steps s ON s.id = j.step_id
      JOIN generation_runs r ON r.id = j.run_id
      WHERE j.status IN ('queued','retry_wait')
        AND j.available_at <= $1
        AND r.status IN ('queued','running','retry_wait')
        AND NOT EXISTS (
          SELECT 1 FROM generation_run_steps previous
          WHERE previous.run_id = s.run_id
            AND previous.step_index < s.step_index
            AND previous.status <> 'succeeded'
        )
      ORDER BY j.available_at, r.started_at, s.step_index
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
    `, [now])).rows[0];
    if (!row) return void 0;
    const run = await lockRun(client, row.run_id);
    if (!run || isTerminalRunStatus(run.status) || run.status === "cancel_requested") return void 0;
    await client.query(`
      UPDATE generation_jobs SET status = 'running', worker_id = $1, lease_expires_at = $2,
        attempt_started_at = NULL, updated_at = $3 WHERE id = $4
    `, [workerId, now + leaseMs, now, row.id]);
    await client.query(`
      UPDATE generation_run_steps SET status = 'running', started_at = COALESCE(started_at, $1), error = NULL
      WHERE id = $2
    `, [now, row.step_id]);
    await client.query(
      "UPDATE generation_runs SET status = 'running', updated_at = $1 WHERE id = $2",
      [now, row.run_id]
    );
    await appendRunEvent(client, row.run_id, {
      type: "node-status",
      nodeId: row.node_id,
      status: "running",
      startedAt: now
    }, now);
    const step = parseJson(row.step_json, void 0);
    if (!step) throw new Error("generation step payload is invalid");
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      nodeId: row.node_id,
      stepIndex: row.step_index,
      step,
      retryCount: row.retry_count,
      startedAt: now
    };
  });
}
async function inputImagesForStep(runId, step) {
  if (!step.upstream?.length) return step.inputImages;
  const rows = await query(`
    SELECT node_id, output_images_json FROM generation_run_steps
    WHERE run_id = $1 AND status = 'succeeded'
  `, [runId]);
  const outputs = new Map(rows.map((row) => [row.node_id, parseJson(row.output_images_json, [])]));
  return step.upstream.flatMap((upstream) => outputs.get(upstream.nodeId) ?? upstream.images);
}
async function markAttemptStarted(job, workerId, now, leaseMs) {
  await transaction(async (client) => {
    const row = (await client.query(
      "SELECT status, worker_id FROM generation_jobs WHERE id = $1 FOR UPDATE",
      [job.id]
    )).rows[0];
    if (!row || row.worker_id !== workerId) throw new Error("generation job lease was lost");
    if (row.status === "cancel_requested") throw new CancelledBeforeProviderCall();
    if (row.status !== "running") throw new Error(`generation job is ${row.status}`);
    await client.query(`
      UPDATE generation_jobs SET attempt_started_at = COALESCE(attempt_started_at, $1),
        lease_expires_at = $2, updated_at = $1 WHERE id = $3
    `, [now, now + leaseMs, job.id]);
    await client.query(`
      UPDATE generation_run_steps SET provider_requests = provider_requests + 1 WHERE id = $1
    `, [job.stepId]);
  });
}
async function persistStepImages(images) {
  const persisted = [];
  for (const image of images) persisted.push(await persistImageRef(image));
  return persisted;
}
async function finalizeSuccessfulRun(client, run, finishedAt, cancellationWarning) {
  const target = run.target_step_id ? (await client.query(`
        SELECT output_images_json, prompts_json, provider_output_sizes_json, failures_json, model
        FROM generation_run_steps WHERE id = $1
      `, [run.target_step_id])).rows[0] : void 0;
  const images = parseJson(target?.output_images_json ?? "[]", []);
  const prompts = parseJson(target?.prompts_json ?? "[]", []);
  const providerOutputSizes = parseJson(target?.provider_output_sizes_json ?? "[]", []);
  const failures = parseJson(target?.failures_json ?? "[]", []);
  const aggregate = (await client.query(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [run.id])).rows[0];
  await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [run.id]);
  for (const [index, image] of images.entries()) {
    await client.query(`
      INSERT INTO generation_outputs (
        id, run_id, image, prompt, provider_output_size, status, error, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'success', NULL, $6)
    `, [
      nanoid5(12),
      run.id,
      image,
      prompts[index] ?? null,
      providerOutputSizes[index] ?? null,
      finishedAt + index
    ]);
  }
  for (const [index, failure] of failures.entries()) {
    await client.query(`
      INSERT INTO generation_outputs (id, run_id, image, prompt, status, error, created_at)
      VALUES ($1, $2, '', $3, 'error', $4, $5)
    `, [nanoid5(12), run.id, failure.prompt ?? null, failure.error, finishedAt + images.length + index]);
  }
  const warning = cancellationWarning ?? (failures.length ? `${failures.length} \u4E2A\u751F\u6210\u4EFB\u52A1\u5931\u8D25` : null);
  const model = target?.model ?? aggregate?.model ?? null;
  const providerRequests = aggregate?.provider_requests ?? 0;
  await client.query(`
    UPDATE generation_runs SET status = 'succeeded', successful_count = $1, provider_requests = $2,
      model = $3, error = $4, finished_at = $5, updated_at = $5 WHERE id = $6
  `, [images.length, providerRequests, model, warning, finishedAt, run.id]);
  if (images.length > 0) {
    await client.query(`
      INSERT INTO usage_events (
        id, owner_id, run_id, project_id, node_id, model, successful_count,
        provider_requests, duration_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (run_id) DO UPDATE SET
        model = excluded.model, successful_count = excluded.successful_count,
        provider_requests = excluded.provider_requests, duration_ms = excluded.duration_ms,
        created_at = excluded.created_at
    `, [
      nanoid5(12),
      run.owner_id,
      run.id,
      run.project_id,
      run.node_id,
      model,
      images.length,
      providerRequests,
      Math.max(0, finishedAt - run.started_at),
      new Date(finishedAt).toISOString()
    ]);
  }
  await appendRunEvent(client, run.id, { type: "done" }, finishedAt);
}
async function finalizeCancelledTargetRun(client, run, targetNodeId, message, finishedAt) {
  const aggregate = (await client.query(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [run.id])).rows[0];
  await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [run.id]);
  await client.query(`
    UPDATE generation_runs SET status = 'cancelled', successful_count = 0, provider_requests = $1,
      model = $2, error = $3, finished_at = $4, updated_at = $4 WHERE id = $5
  `, [aggregate?.provider_requests ?? 0, aggregate?.model ?? null, message, finishedAt, run.id]);
  await appendRunEvent(client, run.id, {
    type: "node-status",
    nodeId: targetNodeId,
    status: "cancelled",
    error: message,
    finishedAt
  }, finishedAt);
  await appendRunEvent(client, run.id, { type: "done" }, finishedAt);
}
async function completeJobSuccess(job, workerId, result, persistedImages, finishedAt) {
  await transaction(async (client) => {
    const locked = (await client.query(
      "SELECT status, worker_id FROM generation_jobs WHERE id = $1 FOR UPDATE",
      [job.id]
    )).rows[0];
    if (!locked || locked.worker_id !== workerId) throw new Error("generation job lease was lost before completion");
    const run = await lockRun(client, job.runId);
    if (!run) throw new Error("generation run disappeared");
    const cancellationWarning = locked.status === "cancel_requested" ? CANCELLED_AFTER_START_WARNING : void 0;
    await client.query(`
      UPDATE generation_jobs SET status = 'succeeded', worker_id = NULL, lease_expires_at = NULL,
        updated_at = $1, last_error = NULL WHERE id = $2
    `, [finishedAt, job.id]);
    await client.query(`
      UPDATE generation_run_steps SET status = 'succeeded', model = $1, output_images_json = $2,
        prompts_json = $3, provider_output_sizes_json = $4, failures_json = $5,
        error = $6, finished_at = $7
      WHERE id = $8
    `, [
      result.model ?? null,
      JSON.stringify(persistedImages),
      JSON.stringify(result.prompts ?? []),
      JSON.stringify(result.providerOutputSizes ?? []),
      JSON.stringify(result.failures ?? []),
      cancellationWarning ?? null,
      finishedAt,
      job.stepId
    ]);
    for (const image of persistedImages) {
      if (!image.startsWith("/api/files/")) continue;
      await client.query(`
        INSERT INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
        VALUES ($1, $2, 'generated', $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
      `, [path3.basename(image), run.owner_id, run.project_id, job.nodeId, run.id, new Date(finishedAt).toISOString()]);
    }
    const partialWarning = result.failures?.length ? `${result.failures.length} \u4E2A\u751F\u6210\u4EFB\u52A1\u5931\u8D25` : void 0;
    await appendRunEvent(client, run.id, {
      type: "node-status",
      nodeId: job.nodeId,
      status: "success",
      images: persistedImages,
      model: result.model,
      prompts: result.prompts,
      providerOutputSizes: result.providerOutputSizes,
      failures: result.failures,
      error: cancellationWarning ?? partialWarning,
      startedAt: job.startedAt,
      finishedAt
    }, finishedAt);
    if (cancellationWarning) {
      await client.query(`
        UPDATE generation_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL, updated_at = $1
        WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
      `, [finishedAt, run.id]);
      await client.query(`
        UPDATE generation_run_steps SET status = 'cancelled', finished_at = $1, error = '\u7528\u6237\u53D6\u6D88\u4E86\u540E\u7EED\u6B65\u9AA4'
        WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
      `, [finishedAt, run.id]);
    }
    const active2 = (await client.query(`
      SELECT COUNT(*)::int AS count FROM generation_jobs
      WHERE run_id = $1 AND status IN ('queued','running','retry_wait','cancel_requested')
    `, [run.id])).rows[0]?.count ?? 0;
    if (active2 === 0) {
      const target = run.target_step_id ? (await client.query(`
            SELECT status, node_id, error FROM generation_run_steps WHERE id = $1
          `, [run.target_step_id])).rows[0] : void 0;
      if (target?.status === "cancelled") {
        await finalizeCancelledTargetRun(
          client,
          run,
          target.node_id,
          target.error ?? "\u7528\u6237\u53D6\u6D88\u4E86\u76EE\u6807\u6B65\u9AA4",
          finishedAt
        );
      } else if (target?.status === "succeeded" || !target) {
        await finalizeSuccessfulRun(client, run, finishedAt, cancellationWarning);
      } else {
        throw new Error(`generation target step ended as ${target.status}`);
      }
    } else {
      await client.query("UPDATE generation_runs SET status = 'running', updated_at = $1 WHERE id = $2", [finishedAt, run.id]);
    }
  });
}
function isRetryableProviderError(error) {
  return error instanceof ProviderError && (error.status === 429 || error.status === 503 && error.category === "gateway_unavailable");
}
async function terminateRun(client, row, status, message, finishedAt) {
  const run = await lockRun(client, row.run_id);
  if (!run || isTerminalRunStatus(run.status)) return;
  await client.query(`
    UPDATE generation_jobs SET status = $1, worker_id = NULL, lease_expires_at = NULL,
      last_error = $2, updated_at = $3 WHERE id = $4
  `, [status, message, finishedAt, row.id]);
  await client.query(`
    UPDATE generation_run_steps SET status = $1, error = $2, finished_at = $3 WHERE id = $4
  `, [status, message, finishedAt, row.step_id]);
  await client.query(`
    UPDATE generation_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL,
      last_error = $1, updated_at = $2
    WHERE run_id = $3 AND id <> $4 AND status IN ('queued','retry_wait','cancel_requested')
  `, ["\u4E0A\u6E38\u6B65\u9AA4\u672A\u5B8C\u6210\uFF0C\u540E\u7EED\u4EFB\u52A1\u5DF2\u505C\u6B62", finishedAt, row.run_id, row.id]);
  await client.query(`
    UPDATE generation_run_steps SET status = 'cancelled', error = $1, finished_at = $2
    WHERE run_id = $3 AND id <> $4 AND status IN ('queued','retry_wait','cancel_requested')
  `, ["\u4E0A\u6E38\u6B65\u9AA4\u672A\u5B8C\u6210\uFF0C\u540E\u7EED\u4EFB\u52A1\u5DF2\u505C\u6B62", finishedAt, row.run_id, row.step_id]);
  const aggregate = (await client.query(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [row.run_id])).rows[0];
  await client.query(`
    UPDATE generation_runs SET status = $1, error = $2, provider_requests = $3,
      model = COALESCE($4, model), finished_at = $5, updated_at = $5 WHERE id = $6
  `, [status, message, aggregate?.provider_requests ?? 0, aggregate?.model ?? null, finishedAt, row.run_id]);
  await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [row.run_id]);
  if (status === "failed") {
    await client.query(`
      INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
      VALUES ($1, $2, '', 'error', $3, $4)
    `, [nanoid5(12), row.run_id, message, finishedAt]);
  }
  const clientStatus = status === "failed" ? "error" : status;
  await appendRunEvent(client, row.run_id, {
    type: "node-status",
    nodeId: row.node_id,
    status: clientStatus,
    error: message,
    startedAt: row.step_started_at ?? void 0,
    finishedAt
  }, finishedAt);
  if (status === "failed") {
    await appendRunEvent(client, row.run_id, {
      type: "run-error",
      nodeId: row.node_id,
      error: message,
      finishedAt
    }, finishedAt);
  } else {
    await appendRunEvent(client, row.run_id, { type: "done" }, finishedAt);
  }
}
async function handleJobError(job, workerId, error, options) {
  const now = options.now?.() ?? Date.now();
  const message = error instanceof CancelledBeforeProviderCall ? error.message : error instanceof ProviderError ? publicProviderErrorMessage(error) : error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderError) {
    console.error("[ai-provider-worker-failure]", JSON.stringify({
      runId: job.runId,
      nodeId: job.nodeId,
      providerId: error.providerId,
      status: error.status ?? null,
      category: error.category,
      retryCount: job.retryCount,
      diagnostic: sanitizedProviderDiagnostic(error) ?? error.message
    }));
  }
  await transaction(async (client) => {
    const row = (await client.query(`
      SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
        s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
      FROM generation_jobs j JOIN generation_run_steps s ON s.id = j.step_id
      JOIN generation_runs r ON r.id = j.run_id WHERE j.id = $1 FOR UPDATE OF j
    `, [job.id])).rows[0];
    if (!row || row.worker_id !== workerId && row.status !== "cancel_requested") return;
    if (error instanceof CancelledBeforeProviderCall) {
      await terminateRun(client, row, "cancelled", message, now);
      return;
    }
    if (error instanceof ProviderError && error.category === "outcome_unknown") {
      await terminateRun(client, row, "outcome_unknown", message, now);
      return;
    }
    if (row.status === "cancel_requested") {
      await terminateRun(client, row, "cancelled", "\u7528\u6237\u53D6\u6D88\u4E86\u4EFB\u52A1\uFF0C\u7CFB\u7EDF\u672A\u7EE7\u7EED\u91CD\u8BD5", now);
      return;
    }
    if (isRetryableProviderError(error) && row.retry_count < 2) {
      const retryNumber = row.retry_count + 1;
      const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
      const baseDelay = retryDelays[Math.min(row.retry_count, retryDelays.length - 1)] ?? DEFAULT_RETRY_DELAYS_MS[1];
      const jitter = Math.floor((options.random?.() ?? Math.random()) * 1e3);
      const availableAt = now + Math.max(0, baseDelay) + jitter;
      await lockRun(client, row.run_id);
      await client.query(`
        UPDATE generation_jobs SET status = 'retry_wait', retry_count = $1, available_at = $2,
          worker_id = NULL, lease_expires_at = NULL, attempt_started_at = NULL, last_error = $3, updated_at = $4
        WHERE id = $5
      `, [retryNumber, availableAt, message, now, row.id]);
      await client.query(`
        UPDATE generation_run_steps SET status = 'retry_wait', error = $1 WHERE id = $2
      `, [message, row.step_id]);
      await client.query("UPDATE generation_runs SET status = 'retry_wait', error = $1, updated_at = $2 WHERE id = $3", [
        message,
        now,
        row.run_id
      ]);
      await appendRunEvent(client, row.run_id, {
        type: "node-status",
        nodeId: row.node_id,
        status: "retry_wait",
        error: message,
        startedAt: row.step_started_at ?? job.startedAt
      }, now);
      return;
    }
    await terminateRun(client, row, "failed", message, now);
  });
}
async function recoverExpiredGenerationJobs(now = Date.now()) {
  return transaction(async (client) => {
    const rows = (await client.query(`
      SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
        s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
      FROM generation_jobs j JOIN generation_run_steps s ON s.id = j.step_id
      JOIN generation_runs r ON r.id = j.run_id
      WHERE j.status IN ('running','cancel_requested') AND j.lease_expires_at < $1
      ORDER BY j.lease_expires_at ASC FOR UPDATE OF j SKIP LOCKED LIMIT 50
    `, [now])).rows;
    for (const row of rows) {
      if (row.attempt_started_at !== null) {
        await terminateRun(
          client,
          row,
          "outcome_unknown",
          "Worker \u5728\u4E0A\u6E38\u8C03\u7528\u5F00\u59CB\u540E\u4E2D\u65AD\uFF0C\u7ED3\u679C\u53EF\u80FD\u5DF2\u7ECF\u751F\u6210\uFF1B\u7CFB\u7EDF\u4E0D\u4F1A\u81EA\u52A8\u91CD\u8BD5",
          now
        );
        continue;
      }
      if (row.status === "cancel_requested") {
        await terminateRun(client, row, "cancelled", "\u4EFB\u52A1\u5DF2\u5728\u4E0A\u6E38\u8C03\u7528\u5F00\u59CB\u524D\u53D6\u6D88", now);
        continue;
      }
      await lockRun(client, row.run_id);
      await client.query(`
        UPDATE generation_jobs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL,
          available_at = $1, updated_at = $1 WHERE id = $2
      `, [now, row.id]);
      await client.query("UPDATE generation_run_steps SET status = 'queued', error = NULL WHERE id = $1", [row.step_id]);
      await client.query("UPDATE generation_runs SET status = 'queued', error = NULL, updated_at = $1 WHERE id = $2", [now, row.run_id]);
      await appendRunEvent(client, row.run_id, {
        type: "node-status",
        nodeId: row.node_id,
        status: "queued",
        error: "Worker \u79DF\u7EA6\u8FC7\u671F\uFF0C\u4EFB\u52A1\u5DF2\u5B89\u5168\u91CD\u65B0\u6392\u961F"
      }, now);
    }
    return rows.length;
  });
}
async function processNextGenerationJob(workerId, options = {}) {
  const now = options.now?.() ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  await recoverExpiredGenerationJobs(now);
  const job = await claimNextJob(workerId, now, leaseMs);
  if (!job) return false;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    const heartbeatNow = options.now?.() ?? Date.now();
    void db().query(`
      UPDATE generation_jobs SET lease_expires_at = $1, updated_at = $2
      WHERE id = $3 AND worker_id = $4 AND status IN ('running','cancel_requested')
    `, [heartbeatNow + leaseMs, heartbeatNow, job.id, workerId]).catch((error) => {
      console.error("[garment-canvas] generation lease heartbeat failed", error);
    });
  }, heartbeatMs);
  heartbeat.unref();
  try {
    const inputImages = await inputImagesForStep(job.runId, job.step);
    const result = await executeStep(
      job.step,
      inputImages,
      options.resolveProvider ?? getProvider,
      {
        runId: job.runId,
        beforeProviderCall: async () => {
          await markAttemptStarted(job, workerId, options.now?.() ?? Date.now(), leaseMs);
        }
      }
    );
    const persistedImages = await persistStepImages(result.images);
    await completeJobSuccess(job, workerId, result, persistedImages, options.now?.() ?? Date.now());
  } catch (error) {
    await handleJobError(job, workerId, error, options);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}
function startGenerationWorker() {
  const workerId = `${os.hostname()}:${process.pid}:${nanoid5(6)}`;
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      while (!stopped && await processNextGenerationJob(workerId)) {
      }
    } catch (error) {
      console.error("[garment-canvas] generation worker failed", error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), DEFAULT_POLL_MS);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
async function getDurableRunForUser(runId, ownerId) {
  const row = await queryOne(`
    SELECT id, status FROM generation_runs
    WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
  `, [runId, ownerId]);
  return row ? { id: row.id, status: row.status, finished: isTerminalRunStatus(row.status) } : void 0;
}
async function readDurableRunEvents(runId, ownerId, afterSeq) {
  const run = await queryOne(`
    SELECT id FROM generation_runs
    WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
  `, [runId, ownerId]);
  if (!run) return void 0;
  const rows = await query(`
    SELECT seq, payload_json FROM generation_run_events
    WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3
  `, [runId, afterSeq, DURABLE_RUN_EVENT_BATCH_SIZE]);
  return rows.map((row) => ({ ...parseJson(row.payload_json, { type: "done" }), seq: row.seq }));
}
async function cancelDurableRun(runId, ownerId) {
  const now = Date.now();
  return transaction(async (client) => {
    const visible = (await client.query(`
      SELECT id FROM generation_runs
      WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
    `, [runId, ownerId])).rows[0];
    if (!visible) return void 0;
    const jobs = (await client.query(`
      SELECT j.id, j.step_id, s.node_id, j.status, j.attempt_started_at
      FROM generation_jobs j JOIN generation_run_steps s ON s.id = j.step_id
      WHERE j.run_id = $1
      ORDER BY j.id
      FOR UPDATE OF j
    `, [runId])).rows;
    const run = (await client.query(`
      SELECT id, owner_id, project_id, node_id, status, target_step_id, started_at, finished_at
      FROM generation_runs
      WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
      FOR UPDATE
    `, [runId, ownerId])).rows[0];
    if (!run) return void 0;
    if (isTerminalRunStatus(run.status)) {
      return { status: run.status, finished: true };
    }
    const running = jobs.find((job) => job.status === "running" || job.status === "cancel_requested");
    if (running) {
      if (running.status === "cancel_requested") {
        return { status: "cancel_requested", finished: false };
      }
      await client.query(`
        UPDATE generation_jobs SET status = 'cancel_requested', updated_at = $1
        WHERE id = $2
      `, [now, running.id]);
      await client.query("UPDATE generation_run_steps SET status = 'cancel_requested' WHERE id = $1", [running.step_id]);
      await client.query(`
        UPDATE generation_jobs SET status = 'cancelled', updated_at = $1, last_error = '\u7528\u6237\u53D6\u6D88\u4E86\u540E\u7EED\u6B65\u9AA4'
        WHERE run_id = $2 AND status IN ('queued','retry_wait')
      `, [now, runId]);
      await client.query(`
        UPDATE generation_run_steps SET status = 'cancelled', finished_at = $1, error = '\u7528\u6237\u53D6\u6D88\u4E86\u540E\u7EED\u6B65\u9AA4'
        WHERE run_id = $2 AND status IN ('queued','retry_wait')
      `, [now, runId]);
      await client.query(`
        UPDATE generation_runs SET status = 'cancel_requested', cancel_requested_at = $1, updated_at = $1
        WHERE id = $2
      `, [now, runId]);
      await appendRunEvent(client, runId, {
        type: "node-status",
        nodeId: running.node_id,
        status: "cancel_requested",
        error: running.attempt_started_at === null ? "\u6B63\u5728\u4E0A\u6E38\u8C03\u7528\u5F00\u59CB\u524D\u53D6\u6D88" : "\u4E0A\u6E38\u4E0D\u652F\u6301\u4E2D\u6B62\uFF0C\u5DF2\u8BB0\u5F55\u53D6\u6D88\u8BF7\u6C42\u5E76\u7B49\u5F85\u771F\u5B9E\u7ED3\u679C"
      }, now);
      return { status: "cancel_requested", finished: false };
    }
    const target = run.target_step_id ? (await client.query(
      "SELECT node_id FROM generation_run_steps WHERE id = $1",
      [run.target_step_id]
    )).rows[0] : void 0;
    await client.query(`
      UPDATE generation_jobs SET status = 'cancelled', updated_at = $1, last_error = '\u7528\u6237\u53D6\u6D88\u4E86\u4EFB\u52A1'
      WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
    `, [now, runId]);
    await client.query(`
      UPDATE generation_run_steps SET status = 'cancelled', finished_at = $1, error = '\u7528\u6237\u53D6\u6D88\u4E86\u4EFB\u52A1'
      WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
    `, [now, runId]);
    await client.query(`
      UPDATE generation_runs SET status = 'cancelled', error = '\u7528\u6237\u53D6\u6D88\u4E86\u4EFB\u52A1',
        cancel_requested_at = $1, finished_at = $1, updated_at = $1 WHERE id = $2
    `, [now, runId]);
    await appendRunEvent(client, runId, {
      type: "node-status",
      nodeId: target?.node_id ?? run.node_id,
      status: "cancelled",
      error: "\u4EFB\u52A1\u5DF2\u5728\u4E0A\u6E38\u8C03\u7528\u5F00\u59CB\u524D\u53D6\u6D88",
      finishedAt: now
    }, now);
    await appendRunEvent(client, runId, { type: "done" }, now);
    return { status: "cancelled", finished: true };
  });
}

// server/routes/generate.ts
var generateRouter = Router();
function isDirectGenerateKind(value) {
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(NODE_SPECS, value)) return false;
  return Boolean(NODE_SPECS[value].providerId);
}
function validateDirectGenerateRequest(kind, request) {
  if (kind === void 0) return { ok: true };
  if (!isDirectGenerateKind(kind)) {
    return { ok: false, error: "kind must identify a supported AI node" };
  }
  if (kind === "sketch-to-render" || kind === "ai-modify") {
    if (typeof request.aspectRatio !== "string" || !Object.prototype.hasOwnProperty.call(EXACT_ASPECT_DIMENSIONS, request.aspectRatio)) {
      return {
        ok: false,
        error: `request.aspectRatio must be one of ${Object.keys(EXACT_ASPECT_DIMENSIONS).join(", ")}`
      };
    }
  }
  if (kind === "upscale" && request.imageSize !== "2K" && request.imageSize !== "4K") {
    return { ok: false, error: "request.imageSize must be 2K or 4K" };
  }
  return { ok: true, kind };
}
generateRouter.post("/", asyncHandler(async (req, res) => {
  const { providerId, modelId: requestedModelId, request, projectId, projectName, nodeId, nodeLabel, kind } = req.body;
  const modelId = requestedModelId ?? providerId;
  if (!modelId || !request?.prompt) {
    res.status(400).json({ error: "modelId and request.prompt are required" });
    return;
  }
  if (!isImageModelId(modelId)) {
    res.status(400).json({ error: "modelId must identify a supported API\u6613 image model" });
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
  if (resolvedKind === "mask-redraw" && (typeof maskSourceRef !== "string" || !maskSourceRef.trim() || typeof request.mask !== "string" || !request.mask.trim())) {
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
  const resolvedRequest = { ...request, modelOptions };
  const run = await enqueueGenerationRun({
    steps: [{
      nodeId: resolvedNodeId,
      kind: resolvedKind,
      inputImages: request.referenceImages ?? [],
      params: {
        ...resolvedRequest,
        modelId,
        ...resolvedKind === "mask-redraw" ? { maskSourceRef } : {}
      }
    }]
  }, user.id, {
    userId: user.id,
    projectId,
    projectName,
    nodeId: resolvedNodeId,
    nodeLabel: nodeLabel ?? "\u76F4\u63A5\u751F\u6210",
    kind: resolvedKind,
    prompt: request.prompt,
    parameters: { ...request, modelId, modelOptions },
    referenceImages: request.referenceImages,
    requestedCount
  }, "direct");
  res.status(202).json({ runId: run.id, status: "queued" });
}));

// server/routes/runPlan.ts
import { Router as Router2 } from "express";

// server/engine/dag.ts
var DagError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "DagError";
  }
};
function assertPlanInputs(plan, edges) {
  const executingNodeIds = new Set(plan.steps.map((step) => step.nodeId));
  for (const step of plan.steps) {
    const spec = NODE_SPECS[step.kind];
    if (!spec.providerId) continue;
    const modelId = isImageModelId(step.params.modelId) ? step.params.modelId : step.kind === "mask-redraw" ? MASK_REDRAW_MODEL_ID : DEFAULT_GENERATION_MODEL_ID;
    if (!isModelAllowedForNode(modelId, step.kind)) {
      throw new DagError(`Model ${modelId} is not allowed for node ${step.nodeId}`);
    }
    const usableImages = (step.upstream ?? []).flatMap(
      (upstream) => executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images
    );
    const maxReferences = Math.min(MAX_REFERENCE_IMAGES, modelMaxReferenceImages(modelId));
    if (usableImages.length > maxReferences) {
      throw new DagError(`Node ${step.nodeId} accepts at most ${maxReferences} reference images for ${modelId}`);
    }
    if (step.kind === "sketch-to-render" && usableImages.length === 0) {
      const prompt = typeof step.params.prompt === "string" ? step.params.prompt.trim() : "";
      if (!prompt) throw new DagError(`Node ${step.nodeId} requires an image or a prompt`);
      continue;
    }
    if (step.kind === "fabric-recolor") {
      const garmentEdges = edges.filter(
        (edge) => edge.target === step.nodeId && edge.targetHandle !== "fabric"
      );
      const garmentIds = new Set(garmentEdges.map((edge) => edge.source));
      const garmentImages = (step.upstream ?? []).filter((upstream) => garmentIds.has(upstream.nodeId)).flatMap(
        (upstream) => executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images
      );
      if (garmentImages.length === 0) {
        throw new DagError(`Node ${step.nodeId} requires a garment image`);
      }
      continue;
    }
    if (step.kind === "mask-redraw") {
      if (usableImages.length === 0) throw new DagError(`Node ${step.nodeId} requires an upstream image`);
      if (typeof step.params.mask !== "string" || !step.params.mask) {
        throw new DagError(`Node ${step.nodeId} requires a saved PNG mask`);
      }
      if (typeof step.params.maskSourceRef !== "string" || step.params.maskSourceRef !== usableImages[0]) {
        throw new DagError(`Node ${step.nodeId} mask does not match its current source image`);
      }
      continue;
    }
    if (usableImages.length === 0) {
      throw new DagError(`Node ${step.nodeId} requires an upstream image`);
    }
  }
}
function buildExecutionPlan(nodes, edges, opts) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  for (const e of edges) {
    if (!nodeMap.has(e.source)) throw new DagError(`Edge source not found: ${e.source}`);
    if (!nodeMap.has(e.target)) throw new DagError(`Edge target not found: ${e.target}`);
  }
  let scope = null;
  if (opts?.onlyNodeId) {
    if (!nodeMap.has(opts.onlyNodeId)) {
      throw new DagError(`Node not found: ${opts.onlyNodeId}`);
    }
    scope = /* @__PURE__ */ new Set([opts.onlyNodeId]);
    if (opts.includeDownstream !== false) {
      const queue2 = [opts.onlyNodeId];
      while (queue2.length) {
        const cur = queue2.shift();
        for (const e of edges) {
          if (e.source === cur && !scope.has(e.target)) {
            scope.add(e.target);
            queue2.push(e.target);
          }
        }
      }
    }
  }
  const inScope = (id) => scope === null || scope.has(id);
  const scopedNodes = nodes.filter((n) => inScope(n.id));
  const scopedEdges = edges.filter((e) => inScope(e.source) && inScope(e.target));
  const indegree = /* @__PURE__ */ new Map();
  for (const n of scopedNodes) indegree.set(n.id, 0);
  for (const e of scopedEdges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);
  const queue = scopedNodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    sorted.push(id);
    for (const e of scopedEdges) {
      if (e.source !== id) continue;
      const d = (indegree.get(e.target) ?? 0) - 1;
      indegree.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  if (sorted.length !== scopedNodes.length) {
    const remaining = scopedNodes.filter((n) => !sorted.includes(n.id)).map((n) => n.id);
    throw new DagError(`Cycle detected in workflow, involved nodes: ${remaining.join(", ")}`);
  }
  const steps = sorted.map((id) => {
    const node = nodeMap.get(id);
    const data = node.data;
    const upstream = [];
    for (const e of edges) {
      if (e.target !== id) continue;
      const srcData = nodeMap.get(e.source).data;
      upstream.push({ nodeId: e.source, images: extractOutputImages(srcData) });
    }
    return {
      nodeId: id,
      kind: data.kind,
      inputImages: upstream.flatMap((u) => u.images),
      upstream,
      params: extractParams(data)
    };
  });
  return { steps };
}
function extractOutputImages(data) {
  switch (data.kind) {
    case "image-input":
      return data.imageUrl ? [data.imageUrl] : [];
    case "sketch-to-render":
    case "ai-modify":
    case "fabric-recolor":
    case "upscale":
    case "print-extract":
    case "print-mutate":
    case "mask-redraw":
      return data.outputImages ?? [];
    case "result":
      return data.images ?? [];
  }
}
function extractParams(data) {
  const modelFields = (preferredAspectRatio = "1:1") => {
    if (!NODE_SPECS[data.kind].providerId) return {};
    const modelId = "modelId" in data && isImageModelId(data.modelId) ? data.modelId : data.kind === "mask-redraw" ? MASK_REDRAW_MODEL_ID : DEFAULT_GENERATION_MODEL_ID;
    return {
      modelId,
      modelOptions: "modelOptions" in data && data.modelOptions ? data.modelOptions : defaultImageModelOptions(modelId, preferredAspectRatio)
    };
  };
  switch (data.kind) {
    case "image-input":
      return { imageUrl: data.imageUrl, imageRole: data.imageRole };
    case "sketch-to-render":
      return {
        prompt: data.prompt,
        aspectRatio: data.aspectRatio,
        batchSize: data.batchSize,
        ...modelFields(data.aspectRatio)
      };
    case "ai-modify":
      return {
        prompt: data.prompt,
        aspectRatio: data.aspectRatio,
        batchSize: data.batchSize,
        ...modelFields(data.aspectRatio)
      };
    case "fabric-recolor":
      return {
        prompt: data.prompt,
        colors: data.colors,
        fabricImageUrl: data.fabricImageUrl,
        ...modelFields()
      };
    case "upscale":
      return { imageSize: data.imageSize, ...modelFields() };
    case "print-extract":
      return { prompt: data.prompt, ...modelFields() };
    case "print-mutate":
      return { prompt: data.prompt, count: data.count, ...modelFields() };
    case "mask-redraw":
      return {
        prompt: data.prompt,
        mask: data.mask,
        maskSourceRef: data.maskSourceRef,
        modelId: MASK_REDRAW_MODEL_ID,
        modelOptions: {}
      };
    case "result":
      return { note: data.note };
  }
}

// server/lib/workflowSchema.ts
var NODE_KINDS = [
  "image-input",
  "sketch-to-render",
  "ai-modify",
  "fabric-recolor",
  "upscale",
  "print-extract",
  "print-mutate",
  "mask-redraw",
  "result"
];
var STATUSES = [
  "idle",
  "queued",
  "running",
  "retry_wait",
  "cancel_requested",
  "success",
  "error",
  "outcome_unknown",
  "cancelled"
];
var IMAGE_ROLES = ["default", "sketch", "garment", "fabric", "reference"];
var ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"];
var IMAGE_SIZES = ["2K", "4K"];
var MAX_NODES = 500;
var MAX_EDGES = 2e3;
var MAX_TEXT_LENGTH = 2e4;
var MAX_IMAGE_REFS = 100;
var SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
var WorkflowValidationError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkflowValidationError";
  }
};
function fail(path11, message) {
  throw new WorkflowValidationError(`${path11}: ${message}`);
}
function record2(value, path11) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path11, "must be an object");
  }
  return value;
}
function stringValue(value, path11, opts) {
  if (typeof value !== "string") fail(path11, "must be a string");
  if (opts?.nonEmpty && value.trim().length === 0) fail(path11, "must not be empty");
  if (value.length > MAX_TEXT_LENGTH) fail(path11, `must be at most ${MAX_TEXT_LENGTH} characters`);
  return value;
}
function optionalString(value, path11) {
  return value === void 0 ? void 0 : stringValue(value, path11);
}
function imageReference(value, path11) {
  const ref = stringValue(value, path11, { nonEmpty: true });
  if (ref.startsWith("data:")) {
    try {
      validateImageDataUrl(ref);
    } catch (error) {
      fail(path11, error instanceof Error ? error.message : "invalid image dataURL");
    }
    return ref;
  }
  const isRemote = /^https?:\/\//i.test(ref);
  if (!isLocalImageReference(ref) && !isRemote) {
    fail(path11, "must be an image dataURL, local /api/files reference, or http(s) URL");
  }
  return ref;
}
function optionalImageReference(value, path11) {
  return value === void 0 ? void 0 : imageReference(value, path11);
}
function finiteNumber(value, path11) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path11, "must be a finite number");
  return value;
}
function oneOf(value, allowed, path11) {
  if (!allowed.includes(value)) fail(path11, `must be one of: ${allowed.join(", ")}`);
  return value;
}
function stringArray(value, path11, max = MAX_IMAGE_REFS) {
  if (!Array.isArray(value)) fail(path11, "must be an array");
  if (value.length > max) fail(path11, `must contain at most ${max} items`);
  return value.map((item, index) => stringValue(item, `${path11}[${index}]`, { nonEmpty: true }));
}
function imageReferenceArray(value, path11, max = MAX_IMAGE_REFS) {
  if (!Array.isArray(value)) fail(path11, "must be an array");
  if (value.length > max) fail(path11, `must contain at most ${max} items`);
  return value.map((item, index) => imageReference(item, `${path11}[${index}]`));
}
function migratedModelFields(kind, raw, preferredAspectRatio = "1:1") {
  const requested = isImageModelId(raw.modelId) && isModelAllowedForNode(raw.modelId, kind) ? raw.modelId : kind === "mask-redraw" ? MASK_REDRAW_MODEL_ID : DEFAULT_GENERATION_MODEL_ID;
  return {
    modelId: requested,
    modelOptions: normalizeImageModelOptions(requested, raw.modelOptions, preferredAspectRatio)
  };
}
function migrateNodeData(kind, raw) {
  switch (kind) {
    case "image-input":
      return { imageRole: "default", ...raw };
    case "sketch-to-render":
      return {
        prompt: "",
        aspectRatio: "3:4",
        batchSize: 1,
        outputImages: [],
        ...raw,
        ...migratedModelFields(kind, raw, typeof raw.aspectRatio === "string" ? raw.aspectRatio : "3:4")
      };
    case "ai-modify":
      return {
        prompt: "",
        aspectRatio: "1:1",
        batchSize: 1,
        outputImages: [],
        ...raw,
        ...migratedModelFields(kind, raw, typeof raw.aspectRatio === "string" ? raw.aspectRatio : "1:1")
      };
    case "fabric-recolor":
      return { colors: [], prompt: "", outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "upscale":
      return { imageSize: "2K", outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "print-extract":
      return { prompt: "", outputImages: [], savedAsAssets: [], ...raw, ...migratedModelFields(kind, raw) };
    case "print-mutate":
      return { prompt: "", count: 4, outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "mask-redraw":
      return {
        prompt: "",
        outputImages: [],
        ...raw,
        modelId: MASK_REDRAW_MODEL_ID,
        modelOptions: defaultImageModelOptions(MASK_REDRAW_MODEL_ID)
      };
    case "result":
      return { images: [], ...raw };
  }
}
function validateModelSelection(kind, raw, path11) {
  if (!NODE_SPECS[kind].providerId) return;
  if (!isImageModelId(raw.modelId)) fail(`${path11}.modelId`, "must be a supported API\u6613 image model");
  if (!isModelAllowedForNode(raw.modelId, kind)) {
    fail(`${path11}.modelId`, `${raw.modelId} is not allowed for ${kind}`);
  }
  const optionsError = imageModelOptionsError(raw.modelId, raw.modelOptions);
  if (optionsError) fail(`${path11}.modelOptions`, optionsError);
}
function validateData(kind, rawValue, path11) {
  const input = record2(rawValue, path11);
  const runtimeStatus = input.status;
  const raw = runtimeStatus !== "idle" && runtimeStatus !== "success" ? { ...input, status: "idle", error: void 0 } : input;
  if (raw.kind !== kind) fail(`${path11}.kind`, `must equal node type ${kind}`);
  stringValue(raw.label, `${path11}.label`, { nonEmpty: true });
  oneOf(raw.status, STATUSES, `${path11}.status`);
  optionalString(raw.error, `${path11}.error`);
  validateModelSelection(kind, raw, path11);
  switch (kind) {
    case "image-input":
      oneOf(raw.imageRole, IMAGE_ROLES, `${path11}.imageRole`);
      optionalImageReference(raw.imageUrl, `${path11}.imageUrl`);
      break;
    case "sketch-to-render":
    case "ai-modify":
      stringValue(raw.prompt, `${path11}.prompt`);
      oneOf(raw.aspectRatio, ASPECT_RATIOS, `${path11}.aspectRatio`);
      oneOf(raw.batchSize, BATCH_SIZES, `${path11}.batchSize`);
      imageReferenceArray(raw.outputImages, `${path11}.outputImages`);
      break;
    case "fabric-recolor": {
      const colors = stringArray(raw.colors, `${path11}.colors`, 8);
      for (let i = 0; i < colors.length; i++) {
        if (!/^#[0-9a-fA-F]{6}$/.test(colors[i])) fail(`${path11}.colors[${i}]`, "must be #RRGGBB");
      }
      stringValue(raw.prompt, `${path11}.prompt`);
      optionalImageReference(raw.fabricImageUrl, `${path11}.fabricImageUrl`);
      imageReferenceArray(raw.outputImages, `${path11}.outputImages`);
      break;
    }
    case "upscale":
      oneOf(raw.imageSize, IMAGE_SIZES, `${path11}.imageSize`);
      imageReferenceArray(raw.outputImages, `${path11}.outputImages`);
      break;
    case "print-extract":
      stringValue(raw.prompt, `${path11}.prompt`);
      imageReferenceArray(raw.outputImages, `${path11}.outputImages`);
      imageReferenceArray(raw.savedAsAssets, `${path11}.savedAsAssets`);
      break;
    case "print-mutate":
      stringValue(raw.prompt, `${path11}.prompt`);
      if (!Number.isInteger(raw.count) || raw.count < 1 || raw.count > 8) {
        fail(`${path11}.count`, "must be an integer from 1 to 8");
      }
      imageReferenceArray(raw.outputImages, `${path11}.outputImages`);
      break;
    case "mask-redraw":
      stringValue(raw.prompt, `${path11}.prompt`);
      optionalImageReference(raw.mask, `${path11}.mask`);
      optionalImageReference(raw.maskSourceRef, `${path11}.maskSourceRef`);
      imageReferenceArray(raw.outputImages, `${path11}.outputImages`);
      break;
    case "result":
      imageReferenceArray(raw.images, `${path11}.images`);
      optionalString(raw.note, `${path11}.note`);
      break;
  }
  return raw;
}
function validateNode(value, index, migrateLegacy) {
  const path11 = `flow.nodes[${index}]`;
  const raw = record2(value, path11);
  const id = stringValue(raw.id, `${path11}.id`, { nonEmpty: true });
  if (!SAFE_ID.test(id)) fail(`${path11}.id`, "must contain only letters, digits, underscore or hyphen");
  const type = oneOf(raw.type, NODE_KINDS, `${path11}.type`);
  const position = record2(raw.position, `${path11}.position`);
  finiteNumber(position.x, `${path11}.position.x`);
  finiteNumber(position.y, `${path11}.position.y`);
  const initialData = record2(raw.data, `${path11}.data`);
  const data = validateData(
    type,
    migrateLegacy ? migrateNodeData(type, initialData) : initialData,
    `${path11}.data`
  );
  return { ...raw, id, type, position: { ...position, x: position.x, y: position.y }, data };
}
function validateEdge(value, index) {
  const path11 = `flow.edges[${index}]`;
  const raw = record2(value, path11);
  const id = stringValue(raw.id, `${path11}.id`, { nonEmpty: true });
  const source = stringValue(raw.source, `${path11}.source`, { nonEmpty: true });
  const target = stringValue(raw.target, `${path11}.target`, { nonEmpty: true });
  if (!SAFE_ID.test(id)) fail(`${path11}.id`, "must contain only letters, digits, underscore or hyphen");
  if (!SAFE_ID.test(source)) fail(`${path11}.source`, "must be a valid node id");
  if (!SAFE_ID.test(target)) fail(`${path11}.target`, "must be a valid node id");
  if (raw.sourceHandle !== void 0 && raw.sourceHandle !== null) stringValue(raw.sourceHandle, `${path11}.sourceHandle`);
  if (raw.targetHandle !== void 0 && raw.targetHandle !== null) stringValue(raw.targetHandle, `${path11}.targetHandle`);
  return { ...raw, id, source, target };
}
function validateAndMigrateFlow(value) {
  const raw = record2(value, "flow");
  const version = raw.schemaVersion;
  const migrateLegacy = version === void 0 || version === 0 || version === 1;
  if (!migrateLegacy && version !== WORKFLOW_SCHEMA_VERSION) {
    fail("flow.schemaVersion", `unsupported version ${String(version)}; current version is ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.nodes)) fail("flow.nodes", "must be an array");
  if (!Array.isArray(raw.edges)) fail("flow.edges", "must be an array");
  if (raw.nodes.length > MAX_NODES) fail("flow.nodes", `must contain at most ${MAX_NODES} nodes`);
  if (raw.edges.length > MAX_EDGES) fail("flow.edges", `must contain at most ${MAX_EDGES} edges`);
  const nodes = raw.nodes.map((node, index) => validateNode(node, index, migrateLegacy));
  const edges = raw.edges.map(validateEdge);
  const nodeIds = /* @__PURE__ */ new Set();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail("flow.nodes", `duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = /* @__PURE__ */ new Set();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) fail("flow.edges", `duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) fail("flow.edges", `edge ${edge.id} source not found: ${edge.source}`);
    if (!nodeIds.has(edge.target)) fail("flow.edges", `edge ${edge.id} target not found: ${edge.target}`);
  }
  for (const node of nodes) {
    const incomingCount = edges.filter((edge) => edge.target === node.id).length;
    if (incomingCount > NODE_SPECS[node.type].inputs) {
      fail(
        "flow.edges",
        `node ${node.id} accepts at most ${NODE_SPECS[node.type].inputs} incoming image connections`
      );
    }
    if (NODE_SPECS[node.type].providerId && incomingCount > MAX_REFERENCE_IMAGES) {
      fail("flow.edges", `node ${node.id} accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
    }
  }
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges };
}

// server/routes/runPlan.ts
var runPlanRouter = Router2();
function requestedCountForStep(kind, params) {
  return kind === "fabric-recolor" ? Math.max(1, Array.isArray(params.colors) ? params.colors.length : 1) : kind === "print-mutate" ? Math.max(1, Math.min(8, Number(params.count) || 4)) : kind === "sketch-to-render" || kind === "ai-modify" ? Math.max(1, Math.min(8, Number(params.batchSize) || 1)) : 1;
}
runPlanRouter.post("/", asyncHandler(async (req, res) => {
  const { nodes, edges, onlyNodeId, includeDownstream, projectId, projectName } = req.body;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    res.status(400).json({ error: "nodes and edges arrays are required" });
    return;
  }
  if (onlyNodeId !== void 0 && (typeof onlyNodeId !== "string" || !onlyNodeId.trim())) {
    res.status(400).json({ error: "onlyNodeId must be a non-empty string" });
    return;
  }
  if (includeDownstream !== void 0 && typeof includeDownstream !== "boolean") {
    res.status(400).json({ error: "includeDownstream must be a boolean" });
    return;
  }
  try {
    const flow = validateAndMigrateFlow({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes,
      edges
    });
    const plan = buildExecutionPlan(flow.nodes, flow.edges, {
      onlyNodeId,
      // 点击单节点默认只执行自己，避免无意触发整条下游产生额外费用。
      includeDownstream: includeDownstream ?? false
    });
    if (plan.steps.length === 0) {
      res.status(400).json({ error: "workflow contains no executable nodes" });
      return;
    }
    assertPlanInputs(plan, flow.edges);
    const targetStep = plan.steps.find((step) => step.nodeId === onlyNodeId) ?? plan.steps[plan.steps.length - 1];
    const targetNode = flow.nodes.find((node) => node.id === targetStep.nodeId);
    const params = targetStep.params;
    const requestedCount = requestedCountForStep(targetStep.kind, params);
    const user = requestUser(req);
    if (typeof projectId === "string") {
      const project = await queryOne(
        "SELECT owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL",
        [projectId]
      );
      if (!project) {
        res.status(404).json({ error: "\u9879\u76EE\u4E0D\u5B58\u5728\u6216\u5DF2\u5220\u9664" });
        return;
      }
      if (project && project.owner_id !== user.id) {
        res.status(403).json({ error: "\u7BA1\u7406\u5458\u53EA\u80FD\u67E5\u770B\u5176\u4ED6\u7528\u6237\u9879\u76EE\uFF0C\u4E0D\u80FD\u8FD0\u884C\u6216\u4FEE\u6539" });
        return;
      }
    }
    const run = await enqueueGenerationRun(plan, user.id, {
      userId: user.id,
      projectId: typeof projectId === "string" ? projectId : void 0,
      projectName: typeof projectName === "string" ? projectName : void 0,
      nodeId: targetStep.nodeId,
      nodeLabel: targetNode?.data.label ?? targetStep.kind,
      kind: targetStep.kind,
      prompt: typeof params.prompt === "string" ? params.prompt : void 0,
      parameters: params,
      referenceImages: targetStep.inputImages,
      requestedCount
    });
    res.status(202).json({ runId: run.id, status: "queued" });
  } catch (err) {
    if (err instanceof DagError || err instanceof WorkflowValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}));
function streamInMemoryRun(run, req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 3000\n\n");
  const send = (event) => {
    if (event.seq !== void 0) res.write(`id: ${event.seq}
`);
    res.write(`data: ${JSON.stringify(event)}

`);
  };
  const lastEventId = Number(req.get("Last-Event-ID") ?? 0);
  const cursor = Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;
  for (const event of run.events) {
    if ((event.seq ?? 0) > cursor) send(event);
  }
  if (run.finished) {
    res.end();
    return;
  }
  run.emitter.on("event", send);
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15e3);
  const close = () => {
    clearInterval(heartbeat);
    run.emitter.off("event", send);
    res.end();
  };
  run.emitter.once("finish", close);
  req.on("close", () => {
    clearInterval(heartbeat);
    run.emitter.off("event", send);
    run.emitter.off("finish", close);
  });
}
var durableRunEventStreamDependencies = {
  readEvents: readDurableRunEvents,
  getRun: getDurableRunForUser,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
};
async function streamDurableRunEvents(runId, ownerId, req, res, overrides = {}) {
  const dependencies = { ...durableRunEventStreamDependencies, ...overrides };
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 3000\n\n");
  let cursor = Number(req.get("Last-Event-ID") ?? 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  let closed = false;
  req.on("close", () => {
    closed = true;
  });
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": keepalive\n\n");
  }, 15e3);
  heartbeat.unref();
  const drain = async () => {
    while (!closed) {
      const events = await dependencies.readEvents(runId, ownerId, cursor);
      if (!events) return false;
      for (const event of events) {
        if (closed) return true;
        if (event.seq !== void 0) {
          cursor = Math.max(cursor, event.seq);
          res.write(`id: ${event.seq}
`);
        }
        res.write(`data: ${JSON.stringify(event)}

`);
      }
      if (events.length < DURABLE_RUN_EVENT_BATCH_SIZE) return true;
    }
    return true;
  };
  try {
    while (!closed) {
      if (!await drain()) break;
      const status = await dependencies.getRun(runId, ownerId);
      if (!status) break;
      if (status.finished) {
        await drain();
        break;
      }
      await dependencies.wait(500);
    }
  } finally {
    clearInterval(heartbeat);
    if (!closed) res.end();
  }
}
runPlanRouter.get("/:id/events", asyncHandler(async (req, res) => {
  const ownerId = requestUser(req).id;
  const durable = await getDurableRunForUser(req.params.id, ownerId);
  if (!durable) {
    const legacyRun = getRunForUser(req.params.id, ownerId);
    if (!legacyRun) {
      res.status(404).json({ error: "run not found" });
      return;
    }
    streamInMemoryRun(legacyRun, req, res);
    return;
  }
  await streamDurableRunEvents(req.params.id, ownerId, req, res);
}));
runPlanRouter.post("/:id/cancel", asyncHandler(async (req, res) => {
  const result = await cancelDurableRun(req.params.id, requestUser(req).id);
  if (!result) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json(result);
}));
runPlanRouter.get("/:id", asyncHandler(async (req, res) => {
  const ownerId = requestUser(req).id;
  const durable = await getDurableRunForUser(req.params.id, ownerId);
  if (durable) {
    res.json({ runId: durable.id, status: durable.status, finished: durable.finished });
    return;
  }
  const run = getRunForUser(req.params.id, ownerId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({ runId: run.id, finished: run.finished });
}));

// server/routes/files.ts
import { Router as Router3 } from "express";
import fs4 from "node:fs";
import path4 from "node:path";
var filesRouter = Router3();
async function canAccessFile(id, req) {
  const user = requestUser(req);
  const access = await queryOne(`
    SELECT f.owner_id,
      EXISTS(SELECT 1 FROM assets a WHERE a.image = $1 AND a.deleted_at IS NULL AND a.scope IN ('global','shared')) AS shared
    FROM files f WHERE f.id = $2
  `, [`/api/files/${id}`, id]);
  if (!access) return "private";
  if (access.owner_id === null || access.shared) return "public";
  if (access.owner_id === user.id || user.role === "admin") return "private";
  return "denied";
}
function setFileCacheHeaders(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.vary("Cookie");
}
filesRouter.post("/", asyncHandler(async (req, res) => {
  const { dataUrl } = req.body;
  if (!dataUrl) {
    res.status(400).json({ error: "dataUrl is required" });
    return;
  }
  try {
    const saved = await saveNormalizedUploadDataUrl(dataUrl);
    try {
      await query(`
        INSERT INTO files (
          id, owner_id, source_type, mime_type, width, height, byte_length, normalized, created_at
        ) VALUES ($1, $2, 'upload', $3, $4, $5, $6, TRUE, $7)
      `, [
        saved.id,
        requestUser(req).id,
        saved.mimeType,
        saved.width,
        saved.height,
        saved.byteLength,
        (/* @__PURE__ */ new Date()).toISOString()
      ]);
    } catch (error) {
      deleteStoredImage(saved.id);
      throw error;
    }
    res.json(saved);
  } catch (err) {
    if (err instanceof ProviderError || err instanceof ImageValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}));
filesRouter.get("/:id/thumbnail", asyncHandler(async (req, res) => {
  const id = path4.basename(req.params.id);
  if (id !== req.params.id || !isSupportedImageFile(id)) {
    res.status(400).json({ error: "invalid file id" });
    return;
  }
  const access = await canAccessFile(id, req);
  if (access === "denied") {
    res.status(403).json({ error: "\u65E0\u6743\u8BBF\u95EE\u6B64\u6587\u4EF6" });
    return;
  }
  try {
    const thumbnail = await ensureThumbnail(id);
    res.setHeader("Content-Type", "image/webp");
    setFileCacheHeaders(res);
    fs4.createReadStream(thumbnail).pipe(res);
  } catch (error) {
    res.status(error instanceof Error && error.message === "file not found" ? 404 : 422).json({ error: error instanceof Error ? error.message : "thumbnail failed" });
  }
}));
filesRouter.get("/:id", asyncHandler(async (req, res) => {
  const id = path4.basename(req.params.id);
  if (id !== req.params.id || !isSupportedImageFile(id)) {
    res.status(400).json({ error: "invalid file id" });
    return;
  }
  const filePath = path4.join(uploadsDir(), id);
  if (!fs4.existsSync(filePath)) {
    res.status(404).json({ error: "file not found" });
    return;
  }
  const access = await canAccessFile(id, req);
  if (access === "denied") {
    res.status(403).json({ error: "\u65E0\u6743\u8BBF\u95EE\u6B64\u6587\u4EF6" });
    return;
  }
  res.setHeader("Content-Type", mimeOfFile(id));
  setFileCacheHeaders(res);
  fs4.createReadStream(filePath).pipe(res);
}));

// server/routes/projects.ts
import { Router as Router4 } from "express";
import { nanoid as nanoid6 } from "nanoid";
var projectsRouter = Router4();
function imageRefs(value, output = /* @__PURE__ */ new Set()) {
  if (typeof value === "string" && value.startsWith("/api/files/")) output.add(value);
  else if (Array.isArray(value)) value.forEach((item) => imageRefs(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => imageRefs(item, output));
  return output;
}
async function syncAssetRefs(client, projectId, ownerId, flow) {
  const refs = [...imageRefs(flow)];
  const assets = await query(`
    SELECT id, image FROM assets
    WHERE deleted_at IS NULL AND (scope IN ('global','shared') OR owner_id = $1)
      AND image = ANY($2::text[])
    FOR KEY SHARE
  `, [ownerId, refs], client);
  const wanted = assets.map((asset) => asset.id);
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await client.query("DELETE FROM project_asset_refs WHERE project_id = $1", [projectId]);
  for (const assetId of wanted) {
    await client.query(
      "INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES ($1, $2, $3)",
      [projectId, assetId, now]
    );
  }
}
async function purgeExpiredProjects() {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const expiredFileIds = await transaction(async (client) => {
    await client.query(`
      DELETE FROM project_asset_refs
      WHERE project_id IN (SELECT id FROM projects WHERE purge_after IS NOT NULL AND purge_after <= $1)
    `, [now]);
    await client.query("DELETE FROM usage_events WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    await client.query("DELETE FROM generation_runs WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    await client.query(`
      DELETE FROM assets
      WHERE purge_after IS NOT NULL AND purge_after <= $1
        AND NOT EXISTS (SELECT 1 FROM project_asset_refs r WHERE r.asset_id = assets.id)
    `, [now]);
    const files = await client.query(
      `DELETE FROM files
       WHERE purge_after IS NOT NULL AND purge_after <= $1
         AND NOT EXISTS (
           SELECT 1 FROM assets a
           WHERE a.image = '/api/files/' || files.id
         )
       RETURNING id`,
      [now]
    );
    await client.query("DELETE FROM projects WHERE purge_after IS NOT NULL AND purge_after <= $1", [now]);
    return files.rows.map((row) => row.id);
  });
  expiredFileIds.forEach(deleteStoredImage);
}
projectsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { id, name, flow } = req.body;
  if (typeof name !== "string" || !name.trim() || name.length > 200 || flow === void 0) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  if (id !== void 0 && (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    res.status(400).json({ error: "id must contain only letters, digits, underscore or hyphen" });
    return;
  }
  try {
    const normalized = validateAndMigrateFlow(flow);
    const projectId = id || nanoid6(10);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const saved = await transaction(async (client) => {
      const existing = await queryOne(
        "SELECT owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
        [projectId],
        client
      );
      if (existing && existing.owner_id !== user.id) return false;
      const result = await client.query(`
        INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $5)
        ON CONFLICT(id) DO UPDATE
          SET name = excluded.name, flow_json = excluded.flow_json, updated_at = excluded.updated_at
          WHERE projects.owner_id = excluded.owner_id
        RETURNING id
      `, [projectId, user.id, name.trim(), JSON.stringify(normalized), now]);
      if (result.rowCount !== 1) return false;
      await syncAssetRefs(client, projectId, user.id, normalized);
      return true;
    });
    if (!saved) {
      res.status(403).json({ error: "\u7BA1\u7406\u5458\u53EA\u80FD\u67E5\u770B\u5176\u4ED6\u7528\u6237\u9879\u76EE\uFF0C\u4E0D\u80FD\u4FEE\u6539" });
      return;
    }
    res.json({ ok: true, id: projectId });
  } catch (error) {
    res.status(error instanceof WorkflowValidationError ? 400 : 500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));
projectsRouter.get("/", asyncHandler(async (req, res) => {
  await purgeExpiredProjects();
  const user = requestUser(req);
  const rows = await query(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.deleted_at IS NULL AND ($1 = 'admin' OR p.owner_id = $2)
    ORDER BY p.updated_at DESC
  `, [user.role, user.id]);
  res.json(rows.map((row) => ({
    id: row.id,
    name: row.name,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    readOnly: row.owner_id !== user.id,
    updatedAt: row.updated_at
  })));
}));
projectsRouter.get("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(`
    SELECT p.id, p.owner_id, u.display_name AS owner_name, p.name, p.flow_json, p.updated_at
    FROM projects p JOIN users u ON u.id = p.owner_id
    WHERE p.id = $1 AND p.deleted_at IS NULL
  `, [req.params.id]);
  if (!row) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  if (row.owner_id !== user.id && user.role !== "admin") {
    res.status(403).json({ error: "\u65E0\u6743\u67E5\u770B\u6B64\u9879\u76EE" });
    return;
  }
  try {
    const flow = validateAndMigrateFlow(JSON.parse(row.flow_json));
    res.json({
      id: row.id,
      name: row.name,
      flow,
      updatedAt: row.updated_at,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      readOnly: row.owner_id !== user.id
    });
  } catch (error) {
    res.status(422).json({
      error: error instanceof WorkflowValidationError ? `\u9879\u76EE\u6570\u636E\u65E0\u6CD5\u8FC1\u79FB\uFF1A${error.message}` : "\u9879\u76EE\u6570\u636E\u635F\u574F"
    });
  }
}));

// server/routes/templates.ts
import { Router as Router5 } from "express";
import fs6 from "node:fs";
import path6 from "node:path";
import { nanoid as nanoid8 } from "nanoid";

// server/lib/atomicJson.ts
import fs5 from "node:fs";
import path5 from "node:path";
import { nanoid as nanoid7 } from "nanoid";
function writeJsonAtomicSync(filePath, value) {
  const dir = path5.dirname(filePath);
  fs5.mkdirSync(dir, { recursive: true });
  const tempPath = path5.join(dir, `.${path5.basename(filePath)}.${process.pid}.${nanoid7(6)}.tmp`);
  try {
    const fd = fs5.openSync(tempPath, "wx", 384);
    try {
      fs5.writeFileSync(fd, `${JSON.stringify(value, null, 2)}
`, "utf-8");
      fs5.fsyncSync(fd);
    } finally {
      fs5.closeSync(fd);
    }
    fs5.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs5.unlinkSync(tempPath);
    } catch {
    }
    throw error;
  }
}

// server/routes/templates.ts
var templatesRouter = Router5();
function templatesDir(sub) {
  const dir = path6.join(config.dataDir(), "templates", sub);
  fs6.mkdirSync(dir, { recursive: true });
  return dir;
}
function templatePath(sub, id) {
  return path6.join(templatesDir(sub), `${path6.basename(id)}.json`);
}
var BUILTIN_CREATED_AT = "2026-08-05T00:00:00.000Z";
function builtinTemplates() {
  return [
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-sketch-recolor",
      name: "\u8349\u56FE\u2192\u6548\u679C\u56FE\u2192\u6539\u6B3E\u2192\u591A\u914D\u8272",
      description: "\u4E0A\u4F20\u8349\u56FE\uFF0C\u6E32\u67D3\u6548\u679C\u56FE\u540E AI \u6539\u6B3E\uFF0C\u518D\u6309\u914D\u8272\u6279\u91CF\u51FA\u56FE",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "image-input",
            position: { x: 0, y: 0 },
            data: { kind: "image-input", label: "\u56FE\u7247\u4E0A\u4F20", status: "idle", imageRole: "sketch" }
          },
          {
            id: "n2",
            type: "sketch-to-render",
            position: { x: 380, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "\u8349\u56FE\u2192\u6548\u679C\u56FE",
              status: "idle",
              prompt: "",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "n3",
            type: "ai-modify",
            position: { x: 760, y: 0 },
            data: {
              kind: "ai-modify",
              label: "AI \u6539\u6B3E",
              status: "idle",
              prompt: "",
              aspectRatio: "1:1",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "n4",
            type: "fabric-recolor",
            position: { x: 1140, y: 0 },
            data: {
              kind: "fabric-recolor",
              label: "\u9762\u6599/\u914D\u8272\u66FF\u6362",
              status: "idle",
              colors: [],
              prompt: "",
              outputImages: []
            }
          }
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2" },
          { id: "e2", source: "n2", target: "n3" },
          { id: "e3", source: "n3", target: "n4", targetHandle: "garment" }
        ]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-sketch-upscale",
      name: "\u8349\u56FE\u2192\u6548\u679C\u56FE\u2192\u9AD8\u6E05\u653E\u5927",
      description: "\u4E0A\u4F20\u8349\u56FE\u6E32\u67D3\u6548\u679C\u56FE\uFF0C\u518D\u653E\u5927\u81F3 2K/4K \u7CBE\u4FEE\u7EC6\u8282",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "image-input",
            position: { x: 0, y: 0 },
            data: { kind: "image-input", label: "\u56FE\u7247\u4E0A\u4F20", status: "idle", imageRole: "sketch" }
          },
          {
            id: "n2",
            type: "sketch-to-render",
            position: { x: 380, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "\u8349\u56FE\u2192\u6548\u679C\u56FE",
              status: "idle",
              prompt: "",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "n3",
            type: "upscale",
            position: { x: 760, y: 0 },
            data: {
              kind: "upscale",
              label: "\u9AD8\u6E05\u653E\u5927",
              status: "idle",
              imageSize: "2K",
              outputImages: []
            }
          }
        ],
        edges: [
          { id: "e1", source: "n1", target: "n2" },
          { id: "e2", source: "n2", target: "n3" }
        ]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-text-recolor",
      name: "\u6587\u751F\u6B3E\u5F0F\u2192\u591A\u914D\u8272",
      description: "\u7EAF\u63D0\u793A\u8BCD\u6587\u751F\u6B3E\u5F0F\u6548\u679C\u56FE\uFF0C\u518D\u6309\u914D\u8272\u6279\u91CF\u51FA\u56FE",
      builtIn: true,
      createdAt: BUILTIN_CREATED_AT,
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "n1",
            type: "sketch-to-render",
            position: { x: 0, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "\u8349\u56FE\u2192\u6548\u679C\u56FE",
              status: "idle",
              prompt: "\u8BBE\u8BA1\u4E00\u6B3E\u7B80\u7EA6\u901A\u52E4\u98CE\u5973\u88C5\u8FDE\u8863\u88D9\uFF0C\u6B63\u9762\u5168\u8EAB\u6548\u679C\u56FE\uFF0C\u6D45\u7070\u7EAF\u8272\u80CC\u666F",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "n2",
            type: "fabric-recolor",
            position: { x: 380, y: 0 },
            data: {
              kind: "fabric-recolor",
              label: "\u9762\u6599/\u914D\u8272\u66FF\u6362",
              status: "idle",
              colors: [],
              prompt: "",
              outputImages: []
            }
          }
        ],
        edges: [{ id: "e1", source: "n1", target: "n2", targetHandle: "garment" }]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-text-to-image",
      name: "\u6587\u751F\u56FE\uFF08\u670D\u88C5\u8BBE\u8BA1\uFF09",
      description: "\u8F93\u5165\u6B3E\u5F0F\u3001\u9762\u6599\u3001\u8272\u5F69\u3001\u6A21\u7279\u3001\u573A\u666F\u4E0E\u6444\u5F71\u8981\u6C42\uFF0C\u76F4\u63A5\u751F\u6210\u670D\u88C5\u8BBE\u8BA1\u6548\u679C\u56FE",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "generate",
            type: "sketch-to-render",
            position: { x: 0, y: 0 },
            data: {
              kind: "sketch-to-render",
              label: "\u6587\u751F\u56FE",
              status: "idle",
              prompt: "\u8BBE\u8BA1\u4E00\u5957\u73B0\u4EE3\u90FD\u5E02\u5973\u88C5\uFF1A\u5ED3\u5F62\u5229\u843D\u7684\u77ED\u6B3E\u897F\u88C5\u642D\u914D\u9AD8\u8170\u9614\u817F\u957F\u88E4\uFF0C\u4F7F\u7528\u6709\u7EC6\u817B\u5782\u5760\u611F\u7684\u6DF1\u7070\u7F8A\u6BDB\u6DF7\u7EBA\u9762\u6599\uFF0C\u5C40\u90E8\u52A0\u5165\u54D1\u5149\u9ED1\u8272\u76AE\u9769\u6EDA\u8FB9\uFF1B\u5E74\u8F7B\u4E9A\u6D32\u5973\u6A21\u7279\u5168\u8EAB\u7AD9\u59FF\uFF0C\u6B63\u9762\u7565\u5FAE\u4FA7\u8EAB\uFF0C\u670D\u88C5\u7ED3\u6784\u3001\u9762\u6599\u7EB9\u7406\u548C\u7F1D\u7EBF\u7EC6\u8282\u6E05\u6670\uFF1B\u6781\u7B80\u6D45\u7070\u6444\u5F71\u68DA\u80CC\u666F\uFF0C\u67D4\u548C\u4FA7\u5149\uFF0C\u9AD8\u7EA7\u65F6\u88C5\u54C1\u724C Lookbook \u98CE\u683C\uFF0C\u5199\u5B9E\u6444\u5F71\uFF0C\u9AD8\u8D28\u611F\uFF0C\u753B\u9762\u5E72\u51C0\uFF0C\u65E0\u6587\u5B57\u3001\u65E0\u6C34\u5370\u3002",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "result",
            type: "result",
            position: { x: 430, y: 0 },
            data: {
              kind: "result",
              label: "\u751F\u6210\u7ED3\u679C",
              status: "idle",
              images: [],
              note: "\u53EF\u4FEE\u6539\u63D0\u793A\u8BCD\u3001\u753B\u5E45\u6BD4\u4F8B\u548C\u751F\u6210\u6570\u91CF\u540E\u91CD\u65B0\u751F\u6210"
            }
          }
        ],
        edges: [{ id: "generate-to-result", source: "generate", target: "result" }]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-person-scene-transfer",
      name: "\u4EBA\u7269\u573A\u666F\u8FC1\u79FB\uFF08\u4EBA\u7269\u2192\u80CC\u666F/\u5EA7\u6905\uFF09",
      description: "\u4E0A\u4F20\u56FE1\u4EBA\u7269\u4E0E\u56FE2\u573A\u666F\uFF0C\u5C06\u4EBA\u7269\u4FDD\u771F\u8FC1\u79FB\u5230\u573A\u666F\u4E2D\u5E76\u5339\u914D\u5EA7\u6905\u3001\u59FF\u6001\u3001\u5149\u5F71\u4E0E\u900F\u89C6",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "subject",
            type: "image-input",
            position: { x: 0, y: -170 },
            data: {
              kind: "image-input",
              label: "\u56FE1 \xB7 \u4EBA\u7269\u4E3B\u4F53",
              status: "idle",
              imageRole: "garment"
            }
          },
          {
            id: "scene",
            type: "image-input",
            position: { x: 0, y: 190 },
            data: {
              kind: "image-input",
              label: "\u56FE2 \xB7 \u573A\u666F\u80CC\u666F",
              status: "idle",
              imageRole: "reference"
            }
          },
          {
            id: "transfer",
            type: "ai-modify",
            position: { x: 430, y: 0 },
            data: {
              kind: "ai-modify",
              label: "\u4EBA\u7269\u573A\u666F\u8FC1\u79FB",
              status: "idle",
              prompt: "\u4E25\u683C\u6309\u7167\u8F93\u5165\u987A\u5E8F\u5904\u7406\uFF1A\u56FE1\u662F\u9700\u8981\u4FDD\u7559\u7684\u4EBA\u7269\u4E3B\u4F53\uFF0C\u56FE2\u662F\u76EE\u6807\u573A\u666F\u3002\u5C06\u56FE1\u4E2D\u7684\u540C\u4E00\u4EBA\u7269\u5B8C\u6574\u8FC1\u79FB\u5230\u56FE2\u7684\u80CC\u666F\u4E2D\uFF0C\u5E76\u8BA9\u4EBA\u7269\u81EA\u7136\u5750\u5728\u56FE2\u7684\u6905\u5B50\u4E0A\u3002\u4FDD\u6301\u56FE1\u4EBA\u7269\u7684\u8138\u90E8\u8EAB\u4EFD\u3001\u53D1\u578B\u3001\u4F53\u578B\u3001\u670D\u88C5\u6B3E\u5F0F\u3001\u989C\u8272\u4E0E\u6750\u8D28\u7EC6\u8282\u4E0D\u53D8\uFF1B\u4FDD\u6301\u56FE2\u7684\u80CC\u666F\u3001\u6905\u5B50\u3001\u6784\u56FE\u4E0E\u7A7A\u95F4\u9648\u8BBE\u4E0D\u53D8\u3002\u6839\u636E\u6905\u5B50\u7684\u671D\u5411\u548C\u9AD8\u5EA6\u8C03\u6574\u4EBA\u7269\u5750\u59FF\u3001\u80A2\u4F53\u906E\u6321\u3001\u6BD4\u4F8B\u4E0E\u900F\u89C6\uFF0C\u4F7F\u8EAB\u4F53\u4E0E\u6905\u9762\u6B63\u786E\u63A5\u89E6\uFF0C\u8865\u5145\u81EA\u7136\u7684\u63A5\u89E6\u9634\u5F71\uFF0C\u5E76\u7EDF\u4E00\u5149\u7EBF\u65B9\u5411\u3001\u8272\u6E29\u3001\u666F\u6DF1\u4E0E\u753B\u9762\u8D28\u611F\u3002\u4E0D\u8981\u590D\u5236\u56FE2\u4E2D\u7684\u4EBA\u7269\uFF0C\u4E0D\u8981\u6539\u53D8\u4EBA\u7269\u8EAB\u4EFD\uFF0C\u4E0D\u8981\u65B0\u589E\u591A\u4F59\u4EBA\u7269\u6216\u5BB6\u5177\u3002\u8F93\u51FA\u4E00\u5F20\u771F\u5B9E\u3001\u81EA\u7136\u3001\u65E0\u62FC\u8D34\u75D5\u8FF9\u7684\u5B8C\u6574\u56FE\u7247\u3002",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "result",
            type: "result",
            position: { x: 860, y: 0 },
            data: {
              kind: "result",
              label: "\u8FC1\u79FB\u7ED3\u679C",
              status: "idle",
              images: [],
              note: "\u4EBA\u7269\u6765\u81EA\u56FE1\uFF0C\u573A\u666F\u4E0E\u6905\u5B50\u6765\u81EA\u56FE2"
            }
          }
        ],
        edges: [
          { id: "subject-to-transfer", source: "subject", target: "transfer" },
          { id: "scene-to-transfer", source: "scene", target: "transfer" },
          { id: "transfer-to-result", source: "transfer", target: "result" }
        ]
      }
    },
    {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id: "builtin-pattern-style-transfer",
      name: "\u56FE\u6848\u98CE\u683C\u8FC1\u79FB\uFF08\u56FE\u6848\u2192\u53C2\u8003\u98CE\u683C\uFF09",
      description: "\u4FDD\u7559\u56FE1\u7684\u4E3B\u9898\u4E0E\u6784\u56FE\uFF0C\u4F7F\u7528\u56FE2\u7684\u6750\u6599\u3001\u5DE5\u827A\u3001\u8272\u5F69\u548C\u89C6\u89C9\u8BED\u8A00\u91CD\u65B0\u6F14\u7ECE",
      builtIn: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      flow: {
        schemaVersion: WORKFLOW_SCHEMA_VERSION,
        nodes: [
          {
            id: "pattern",
            type: "image-input",
            position: { x: 0, y: -170 },
            data: {
              kind: "image-input",
              label: "\u56FE1 \xB7 \u539F\u59CB\u56FE\u6848",
              status: "idle",
              imageRole: "garment"
            }
          },
          {
            id: "style",
            type: "image-input",
            position: { x: 0, y: 190 },
            data: {
              kind: "image-input",
              label: "\u56FE2 \xB7 \u98CE\u683C\u53C2\u8003",
              status: "idle",
              imageRole: "reference"
            }
          },
          {
            id: "transfer",
            type: "ai-modify",
            position: { x: 430, y: 0 },
            data: {
              kind: "ai-modify",
              label: "\u56FE\u6848\u98CE\u683C\u8FC1\u79FB",
              status: "idle",
              prompt: "\u4E25\u683C\u6309\u7167\u8F93\u5165\u987A\u5E8F\u5904\u7406\uFF1A\u56FE1\u662F\u5FC5\u987B\u4FDD\u7559\u7684\u539F\u59CB\u56FE\u6848\uFF0C\u56FE2\u662F\u4EC5\u7528\u4E8E\u5B66\u4E60\u6750\u6599\u3001\u5DE5\u827A\u3001\u8272\u5F69\u548C\u89C6\u89C9\u8BED\u8A00\u7684\u98CE\u683C\u53C2\u8003\u3002\u4FDD\u7559\u56FE1\u7684\u4E3B\u9898\u5143\u7D20\u3001\u6570\u91CF\u3001\u6784\u56FE\u5E03\u5C40\u3001\u8F6E\u5ED3\u6BD4\u4F8B\u548C\u4E3B\u8981\u8BC6\u522B\u7279\u5F81\uFF0C\u5C06\u5B83\u4EEC\u91CD\u65B0\u6F14\u7ECE\u4E3A\u56FE2\u7684\u9762\u6599\u7EB9\u7406\u3001\u624B\u5DE5\u5DE5\u827A\u3001\u7B14\u89E6\u3001\u914D\u8272\u548C\u8D28\u611F\u3002\u4E0D\u8981\u590D\u5236\u56FE2\u7684\u4E3B\u4F53\u6216\u6784\u56FE\uFF0C\u4E0D\u8981\u4E22\u5931\u56FE1\u7684\u4E3B\u4F53\uFF0C\u4E0D\u8981\u65B0\u589E\u65E0\u5173\u6587\u5B57\u3001\u6C34\u5370\u6216\u5143\u7D20\u3002\u8F93\u51FA\u5B8C\u6574\u3001\u6E05\u6670\u3001\u53EF\u7528\u4E8E\u670D\u88C5\u5370\u82B1\u7684\u5355\u5F20\u56FE\u6848\u3002",
              aspectRatio: "3:4",
              batchSize: 1,
              outputImages: []
            }
          },
          {
            id: "result",
            type: "result",
            position: { x: 860, y: 0 },
            data: {
              kind: "result",
              label: "\u8FC1\u79FB\u7ED3\u679C",
              status: "idle",
              images: [],
              note: "\u56FE\u6848\u4E3B\u9898\u6765\u81EA\u56FE1\uFF0C\u6750\u6599\u3001\u5DE5\u827A\u4E0E\u89C6\u89C9\u98CE\u683C\u6765\u81EA\u56FE2"
            }
          }
        ],
        edges: [
          { id: "pattern-to-transfer", source: "pattern", target: "transfer" },
          { id: "style-to-transfer", source: "style", target: "transfer" },
          { id: "transfer-to-result", source: "transfer", target: "result" }
        ]
      }
    }
  ];
}
function ensureBuiltinTemplates() {
  fs6.rmSync(templatePath("builtin", "builtin-style-transfer"), { force: true });
  for (const tpl of builtinTemplates()) {
    const filePath = templatePath("builtin", tpl.id);
    if (!fs6.existsSync(filePath)) writeJsonAtomicSync(filePath, tpl);
  }
}
ensureBuiltinTemplates();
function readTemplates(sub) {
  const dir = templatesDir(sub);
  const list = [];
  for (const f of fs6.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      list.push(readTemplateFile(path6.join(dir, f)));
    } catch {
    }
  }
  return list;
}
function readTemplateFile(filePath) {
  const raw = JSON.parse(fs6.readFileSync(filePath, "utf-8"));
  if (raw.schemaVersion !== void 0 && raw.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new WorkflowValidationError(`unsupported template schemaVersion: ${String(raw.schemaVersion)}`);
  }
  const flow = validateAndMigrateFlow(raw.flow);
  if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name || typeof raw.description !== "string" || typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) {
    throw new WorkflowValidationError("invalid template metadata");
  }
  if (raw.thumbnail !== void 0 && !isLocalImageReference(raw.thumbnail)) {
    throw new WorkflowValidationError("template thumbnail must be a local /api/files image reference");
  }
  return { ...raw, schemaVersion: WORKFLOW_SCHEMA_VERSION, flow };
}
function templateForResponse(template) {
  return template.thumbnail ? { ...template, thumbnail: thumbnailUrlForImage(template.thumbnail) } : template;
}
templatesRouter.get("/", (_req, res) => {
  try {
    const builtin = readTemplates("builtin");
    const user = readTemplates("user").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.json([...builtin, ...user].map(templateForResponse));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
templatesRouter.get("/:id", (req, res) => {
  const id = req.params.id;
  const filePath = fs6.existsSync(templatePath("user", id)) ? templatePath("user", id) : templatePath("builtin", id);
  if (!fs6.existsSync(filePath)) {
    res.status(404).json({ error: "template not found" });
    return;
  }
  try {
    res.json(templateForResponse(readTemplateFile(filePath)));
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 422 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
templatesRouter.post("/", (req, res) => {
  const { name, description, thumbnail, flow } = req.body;
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200 || flow === void 0) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  try {
    if (description !== void 0 && typeof description !== "string") throw new WorkflowValidationError("description must be a string");
    if (thumbnail !== void 0 && !isLocalImageReference(thumbnail)) {
      throw new WorkflowValidationError("thumbnail must be a local /api/files image reference");
    }
    const id = nanoid8(10);
    const template = {
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      id,
      name: name.trim(),
      description: description ?? "",
      ...thumbnail ? { thumbnail } : {},
      flow: validateAndMigrateFlow(flow),
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    writeJsonAtomicSync(templatePath("user", id), template);
    res.json({ ok: true, id });
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
templatesRouter.delete("/:id", (req, res) => {
  const id = req.params.id;
  if (fs6.existsSync(templatePath("builtin", id))) {
    res.status(403).json({ error: "builtin template cannot be deleted" });
    return;
  }
  const filePath = templatePath("user", id);
  if (!fs6.existsSync(filePath)) {
    res.status(404).json({ error: "template not found" });
    return;
  }
  try {
    fs6.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// server/routes/assets.ts
import { Router as Router6 } from "express";
import { nanoid as nanoid9 } from "nanoid";
import path7 from "node:path";
var assetsRouter = Router6();
var CATEGORIES = ["print", "fabric", "reference"];
var TRASH_DAYS = 15;
function mapAsset(row, currentUserId) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    scope: row.scope,
    name: row.name,
    category: row.category,
    image: row.image,
    thumbnail: thumbnailUrlForImage(row.image),
    ...row.source_note ? { sourceNote: row.source_note } : {},
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    purgeAfter: row.purge_after,
    canManage: row.scope === "global" ? false : row.owner_id === currentUserId
  };
}
async function purgeExpiredAssets() {
  await query(`
    DELETE FROM assets WHERE purge_after IS NOT NULL AND purge_after <= $1
      AND NOT EXISTS (SELECT 1 FROM project_asset_refs r WHERE r.asset_id = assets.id)
  `, [(/* @__PURE__ */ new Date()).toISOString()]);
}
assetsRouter.get("/", asyncHandler(async (req, res) => {
  await purgeExpiredAssets();
  const user = requestUser(req);
  const category = req.query.category;
  if (category && !CATEGORIES.includes(category)) {
    res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(", ")}` });
    return;
  }
  const includeDeleted = req.query.deleted === "true";
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const searchPattern = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await query(`
    SELECT a.*, u.display_name AS owner_name
    FROM assets a LEFT JOIN users u ON u.id = a.owner_id
    WHERE ($1::text IS NULL OR a.category = $1)
      AND ($6::text IS NULL OR a.name ILIKE $6)
      AND (${includeDeleted ? "a.deleted_at IS NOT NULL" : "a.deleted_at IS NULL"})
      AND (${includeDeleted ? "$2 = 'admin' OR a.owner_id = $3" : "$2 = 'admin' OR a.scope IN ('global','shared') OR a.owner_id = $3"})
    ORDER BY a.created_at DESC
    LIMIT $4 OFFSET $5
  `, [category ?? null, user.role, user.id, limit, offset, searchPattern]);
  res.json(rows.map((row) => ({
    ...mapAsset(row, user.id),
    canManage: row.scope === "global" ? user.role === "admin" : row.owner_id === user.id
  })));
}));
assetsRouter.post("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { name, category, image, sourceNote, scope } = req.body;
  if (typeof name !== "string" || !name.trim() || name.length > 200 || !category || !CATEGORIES.includes(category) || typeof image !== "string" || !image) {
    res.status(400).json({ error: "name, category and image are required" });
    return;
  }
  if (scope === "global" && user.role !== "admin") {
    res.status(403).json({ error: "\u53EA\u6709\u7BA1\u7406\u5458\u53EF\u4EE5\u521B\u5EFA\u901A\u7528\u7D20\u6750" });
    return;
  }
  let saved;
  try {
    if (sourceNote !== void 0 && (typeof sourceNote !== "string" || sourceNote.length > 2e3)) {
      throw new ImageValidationError("sourceNote must be a string of at most 2000 characters");
    }
    const finalScope = scope === "global" && user.role === "admin" ? "global" : scope === "shared" ? "shared" : "private";
    saved = image.startsWith("data:") ? await saveNormalizedUploadDataUrl(image) : void 0;
    const imageUrl2 = saved?.url ?? (isLocalImageReference(image) ? image : "");
    if (!imageUrl2) throw new ImageValidationError("image must be a local image reference or valid image dataURL");
    const id = nanoid9(10);
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const created = await transaction(async (client) => {
      if (saved) {
        await client.query(`
          INSERT INTO files (
            id, owner_id, source_type, mime_type, width, height, byte_length, normalized, created_at
          ) VALUES ($1, $2, 'asset', $3, $4, $5, $6, TRUE, $7)
          ON CONFLICT (id) DO NOTHING
        `, [
          saved.id,
          finalScope === "global" ? null : user.id,
          saved.mimeType,
          saved.width,
          saved.height,
          saved.byteLength,
          createdAt
        ]);
      } else {
        const access = await queryOne(`
          SELECT f.owner_id,
            EXISTS(
              SELECT 1 FROM assets a
              WHERE a.image = $1 AND a.deleted_at IS NULL AND a.scope IN ('global','shared')
            ) AS shared
          FROM files f WHERE f.id = $2
        `, [imageUrl2, path7.basename(imageUrl2)], client);
        if (!access || access.owner_id !== null && access.owner_id !== user.id && user.role !== "admin" && !access.shared) {
          return false;
        }
      }
      if (finalScope === "global") {
        await client.query(`
          UPDATE files SET owner_id = NULL, deleted_at = NULL, purge_after = NULL WHERE id = $1
        `, [path7.basename(imageUrl2)]);
      }
      await client.query(`
        INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [id, finalScope === "global" ? null : user.id, finalScope, name.trim(), category, imageUrl2, sourceNote ?? null, createdAt]);
      return true;
    });
    if (!created) {
      if (saved) deleteStoredImage(saved.id);
      res.status(404).json({ error: "image file not found" });
      return;
    }
    res.status(201).json({ ok: true, id });
  } catch (error) {
    if (saved) deleteStoredImage(saved.id);
    res.status(error instanceof ImageValidationError ? 400 : 500).json({ error: error instanceof Error ? error.message : String(error) });
  }
}));
assetsRouter.patch("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(
    "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NULL",
    [req.params.id]
  );
  if (!row) {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
  if (!canManage) {
    res.status(403).json({ error: "\u65E0\u6743\u4FEE\u6539\u6B64\u7D20\u6750" });
    return;
  }
  const { name, scope } = req.body;
  if (name !== void 0 && (typeof name !== "string" || !name.trim() || name.length > 200)) {
    res.status(400).json({ error: "\u7D20\u6750\u540D\u79F0\u65E0\u6548" });
    return;
  }
  if (scope === "global" && user.role !== "admin") {
    res.status(403).json({ error: "\u53EA\u6709\u7BA1\u7406\u5458\u53EF\u4EE5\u8BBE\u7F6E\u901A\u7528\u7D20\u6750" });
    return;
  }
  const nextScope = scope ?? row.scope;
  await query("UPDATE assets SET name = COALESCE($1, name), scope = $2, owner_id = $3 WHERE id = $4", [
    name?.trim() ?? null,
    nextScope,
    nextScope === "global" ? null : row.owner_id ?? user.id,
    req.params.id
  ]);
  res.json({ ok: true });
}));
assetsRouter.post("/:id/references", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { projectId } = req.body;
  if (typeof projectId !== "string" || !projectId) {
    res.status(400).json({ error: "projectId is required" });
    return;
  }
  const linked = await transaction(async (client) => {
    const project = await queryOne(`
      SELECT id FROM projects
      WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL
      FOR UPDATE
    `, [projectId, user.id], client);
    if (!project) return false;
    const asset = await queryOne(`
      SELECT id FROM assets WHERE id = $1 AND deleted_at IS NULL
        AND (scope IN ('global','shared') OR owner_id = $2)
      FOR KEY SHARE
    `, [req.params.id, user.id], client);
    if (!asset) return false;
    await client.query(`
      INSERT INTO project_asset_refs (project_id, asset_id, created_at) VALUES ($1, $2, $3)
      ON CONFLICT (project_id, asset_id) DO NOTHING
    `, [projectId, req.params.id, (/* @__PURE__ */ new Date()).toISOString()]);
    return true;
  });
  if (!linked) {
    res.status(404).json({ error: "project or asset not found" });
    return;
  }
  res.json({ ok: true });
}));
assetsRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const result = await transaction(async (client) => {
    const row = await queryOne(
      "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
      [req.params.id],
      client
    );
    if (!row) return { status: "missing" };
    const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
    if (!canManage) return { status: "forbidden" };
    const ref = await queryOne(
      "SELECT project_id FROM project_asset_refs WHERE asset_id = $1 LIMIT 1",
      [req.params.id],
      client
    );
    if (ref) return { status: "referenced" };
    const deletedAt = /* @__PURE__ */ new Date();
    const purgeAfter = new Date(deletedAt.getTime() + TRASH_DAYS * 24 * 60 * 60 * 1e3);
    await client.query("UPDATE assets SET deleted_at = $1, purge_after = $2 WHERE id = $3", [
      deletedAt.toISOString(),
      purgeAfter.toISOString(),
      req.params.id
    ]);
    return { status: "deleted", purgeAfter: purgeAfter.toISOString() };
  });
  if (result.status === "missing") {
    res.status(404).json({ error: "asset not found" });
    return;
  }
  if (result.status === "forbidden") {
    res.status(403).json({ error: "\u65E0\u6743\u5220\u9664\u6B64\u7D20\u6750" });
    return;
  }
  if (result.status === "referenced") {
    res.status(409).json({ error: "\u7D20\u6750\u6B63\u5728\u88AB\u9879\u76EE\u4F7F\u7528\uFF0C\u4E0D\u80FD\u5220\u9664" });
    return;
  }
  res.json({ ok: true, purgeAfter: result.purgeAfter });
}));
assetsRouter.post("/:id/restore", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(
    "SELECT owner_id, scope FROM assets WHERE id = $1 AND deleted_at IS NOT NULL",
    [req.params.id]
  );
  if (!row) {
    res.status(404).json({ error: "\u56DE\u6536\u7AD9\u4E2D\u6CA1\u6709\u6B64\u7D20\u6750" });
    return;
  }
  const canManage = row.scope === "global" ? user.role === "admin" : row.owner_id === user.id;
  if (!canManage) {
    res.status(403).json({ error: "\u65E0\u6743\u6062\u590D\u6B64\u7D20\u6750" });
    return;
  }
  await query("UPDATE assets SET deleted_at = NULL, purge_after = NULL WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));

// server/lib/rateLimit.ts
function createRateLimitMiddleware(options = {}) {
  const windowMs = options.windowMs ?? 6e4;
  const maxRequests = options.maxRequests ?? 100;
  const now = options.now ?? Date.now;
  const buckets = /* @__PURE__ */ new Map();
  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || "unknown";
    const currentTime = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= currentTime) {
      bucket = { count: 0, resetAt: currentTime + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      res.status(429).json({
        error: "Too many requests, please slow down",
        retryAfter: Math.max(1, Math.ceil((bucket.resetAt - currentTime) / 1e3))
      });
      return;
    }
    next();
  };
}

// server/routes/auth.ts
import { Router as Router7 } from "express";
import { nanoid as nanoid10 } from "nanoid";
var authRouter = Router7();
function publicUser(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    ...row.active === void 0 ? {} : { active: row.active === 1 },
    ...row.created_at ? { createdAt: row.created_at } : {}
  };
}
authRouter.post("/login", asyncHandler(async (req, res) => {
  const { accountId, password } = req.body;
  if (typeof accountId !== "string" || typeof password !== "string" || !accountId.trim() || !password) {
    res.status(400).json({ error: "\u8D26\u53F7\u548C\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A" });
    return;
  }
  const row = await queryOne(`
    SELECT id, account_id, display_name, role, password_hash, must_change_password, active
    FROM users WHERE account_id = $1 AND deleted_at IS NULL
  `, [accountId.trim()]);
  if (!row || row.active !== 1 || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({ error: "\u8D26\u53F7\u6216\u5BC6\u7801\u9519\u8BEF" });
    return;
  }
  const session = await createSession(row.id);
  setSessionCookie(res, session.token);
  res.json({ user: publicUser(row), expiresAt: session.expiresAt });
}));
authRouter.get("/me", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  requireAuthForSessionCheck(req, res, next);
}, (req, res) => {
  res.json({ user: requestUser(req) });
});
authRouter.use(requireAuth);
authRouter.post("/logout", asyncHandler(async (req, res) => {
  await revokeRequestSession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
}));
authRouter.post("/change-password", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "\u5F53\u524D\u5BC6\u7801\u548C\u65B0\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A" });
    return;
  }
  const invalid = validatePassword(newPassword);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const row = await queryOne("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({ error: "\u5F53\u524D\u5BC6\u7801\u9519\u8BEF" });
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  await query("UPDATE users SET password_hash = $1, must_change_password = 0, updated_at = $2 WHERE id = $3", [
    hashPassword(newPassword),
    now,
    user.id
  ]);
  const session = await createSession(user.id, { markExistingAsReplaced: false });
  setSessionCookie(res, session.token);
  res.json({ ok: true, user: { ...user, mustChangePassword: false }, expiresAt: session.expiresAt });
}));
authRouter.use(requirePasswordChanged);
authRouter.get("/users", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query(`
    SELECT id, account_id, display_name, role, must_change_password, active, created_at
    FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC
  `);
  res.json(rows.map(publicUser));
}));
authRouter.post("/users", requireAdmin, asyncHandler(async (req, res) => {
  const { accountId, displayName, password, role } = req.body;
  if (typeof accountId !== "string" || !/^[A-Za-z0-9@._+-]{3,64}$/.test(accountId) || typeof displayName !== "string" || !displayName.trim() || displayName.length > 100 || typeof password !== "string") {
    res.status(400).json({ error: "\u8D26\u53F7\u3001\u540D\u79F0\u6216\u5BC6\u7801\u683C\u5F0F\u65E0\u6548" });
    return;
  }
  const invalid = validatePassword(password);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const id = nanoid10(12);
  try {
    await query(`
      INSERT INTO users (id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $6)
    `, [id, accountId, displayName.trim(), role === "admin" ? "admin" : "user", hashPassword(password), now]);
    res.status(201).json({ id });
  } catch (error) {
    const duplicate = typeof error === "object" && error !== null && "code" in error && error.code === "23505";
    res.status(duplicate ? 409 : 500).json({ error: duplicate ? "\u8D26\u53F7\u5DF2\u5B58\u5728" : String(error) });
  }
}));
authRouter.patch("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const actor = requestUser(req);
  const { active: active2, displayName } = req.body;
  if (req.params.id === actor.id && active2 === false) {
    res.status(400).json({ error: "\u4E0D\u80FD\u505C\u7528\u5F53\u524D\u7BA1\u7406\u5458\u8D26\u53F7" });
    return;
  }
  const row = await queryOne("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!row) {
    res.status(404).json({ error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  if (typeof displayName === "string" && displayName.trim() && displayName.length <= 100) {
    await query("UPDATE users SET display_name = $1, updated_at = $2 WHERE id = $3", [displayName.trim(), now, req.params.id]);
  }
  if (typeof active2 === "boolean") {
    await query("UPDATE users SET active = $1, updated_at = $2 WHERE id = $3", [active2 ? 1 : 0, now, req.params.id]);
    if (!active2) await revokeUserSessions(req.params.id);
  }
  res.json({ ok: true });
}));
authRouter.post("/users/:id/reset-password", requireAdmin, asyncHandler(async (req, res) => {
  const { password } = req.body;
  if (typeof password !== "string") {
    res.status(400).json({ error: "\u65B0\u5BC6\u7801\u4E0D\u80FD\u4E3A\u7A7A" });
    return;
  }
  const invalid = validatePassword(password);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const result = await db().query(`
    UPDATE users SET password_hash = $1, must_change_password = 1, updated_at = $2
    WHERE id = $3 AND deleted_at IS NULL
  `, [hashPassword(password), (/* @__PURE__ */ new Date()).toISOString(), req.params.id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  await revokeUserSessions(req.params.id);
  res.json({ ok: true });
}));
authRouter.delete("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const actor = requestUser(req);
  if (req.params.id === actor.id) {
    res.status(400).json({ error: "\u4E0D\u80FD\u5220\u9664\u5F53\u524D\u7BA1\u7406\u5458\u8D26\u53F7" });
    return;
  }
  const { transferToUserId, deleteData } = req.body;
  if (!transferToUserId && deleteData !== true) {
    res.status(400).json({ error: "\u5FC5\u987B\u9009\u62E9\u6570\u636E\u63A5\u6536\u7528\u6237\uFF0C\u6216\u660E\u786E\u5C06\u6570\u636E\u653E\u5165 15 \u5929\u56DE\u6536\u7AD9" });
    return;
  }
  const source = await queryOne("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!source) {
    res.status(404).json({ error: "\u7528\u6237\u4E0D\u5B58\u5728" });
    return;
  }
  if (transferToUserId) {
    const target = await queryOne(
      "SELECT id FROM users WHERE id = $1 AND active = 1 AND deleted_at IS NULL",
      [transferToUserId]
    );
    if (!target) {
      res.status(400).json({ error: "\u6570\u636E\u63A5\u6536\u7528\u6237\u4E0D\u5B58\u5728\u6216\u5DF2\u505C\u7528" });
      return;
    }
  }
  const now = /* @__PURE__ */ new Date();
  const nowIso = now.toISOString();
  const purgeAfter = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1e3).toISOString();
  await transaction(async (client) => {
    if (transferToUserId) {
      for (const table of ["projects", "assets", "files", "generation_runs", "usage_events"]) {
        await client.query(`UPDATE ${table} SET owner_id = $1 WHERE owner_id = $2`, [transferToUserId, req.params.id]);
      }
    } else {
      await client.query(
        "UPDATE projects SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL",
        [nowIso, purgeAfter, req.params.id]
      );
      await client.query(
        "UPDATE assets SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL",
        [nowIso, purgeAfter, req.params.id]
      );
      for (const table of ["files", "generation_runs", "usage_events"]) {
        await client.query(
          `UPDATE ${table} SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL`,
          [nowIso, purgeAfter, req.params.id]
        );
      }
    }
    await client.query("DELETE FROM sessions WHERE user_id = $1", [req.params.id]);
    await client.query("UPDATE users SET active = 0, deleted_at = $1, updated_at = $1 WHERE id = $2", [nowIso, req.params.id]);
  });
  res.json({ ok: true, purgeAfter: transferToUserId ? null : purgeAfter });
}));

// server/routes/history.ts
import { Router as Router8 } from "express";
var historyRouter = Router8();
function encodeCursor(cursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}
function decodeCursor(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "string" || value.length === 0 || value.length > 2e3) {
    throw new Error("invalid history cursor");
  }
  const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  if (!Number.isSafeInteger(decoded.before) || Number(decoded.before) < 0 || !Number.isSafeInteger(decoded.startedAt) || Number(decoded.startedAt) < 0 || typeof decoded.runId !== "string" || !decoded.runId) {
    throw new Error("invalid history cursor");
  }
  return { before: Number(decoded.before), startedAt: Number(decoded.startedAt), runId: decoded.runId };
}
function parseJson2(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
historyRouter.get("/", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const requestedUserId = typeof req.query.userId === "string" ? req.query.userId : void 0;
  if (requestedUserId && user.role !== "admin" && requestedUserId !== user.id) {
    res.status(403).json({ error: "\u65E0\u6743\u67E5\u770B\u5176\u4ED6\u7528\u6237\u8BB0\u5F55" });
    return;
  }
  const ownerId = requestedUserId ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  let cursor;
  try {
    cursor = decodeCursor(req.query.cursor);
  } catch {
    res.status(400).json({ error: "\u5386\u53F2\u5206\u9875\u6E38\u6807\u65E0\u6548" });
    return;
  }
  const requestedBefore = Number(req.query.before);
  const before = cursor?.before ?? (Number.isFinite(requestedBefore) && requestedBefore >= 0 ? requestedBefore : Date.now());
  const runCandidates = await query(`
    SELECT r.id, r.started_at
    FROM generation_runs r
    WHERE ($1::text IS NULL OR r.owner_id = $1)
      AND r.deleted_at IS NULL
      AND r.started_at <= $2
      AND (
        $3::bigint IS NULL OR r.started_at < $3
        OR (r.started_at = $3 AND r.id < $4)
      )
      AND (
        r.status IN ('queued','running','retry_wait','cancel_requested','cancelled','outcome_unknown','failed','succeeded')
        OR EXISTS (SELECT 1 FROM generation_outputs output WHERE output.run_id = r.id)
      )
    ORDER BY r.started_at DESC, r.id DESC
    LIMIT $5
  `, [ownerId, before, cursor?.startedAt ?? null, cursor?.runId ?? null, limit + 1]);
  const hasMore = runCandidates.length > limit;
  const pageRuns = runCandidates.slice(0, limit);
  if (pageRuns.length === 0) {
    res.json({ records: [], nextCursor: null, hasMore: false });
    return;
  }
  const rows = await query(`
    SELECT r.*, o.id AS output_id, o.image, o.prompt AS output_prompt,
      o.provider_output_size, o.status AS output_status, o.error AS output_error,
      u.display_name AS owner_name
    FROM generation_runs r
    JOIN users u ON u.id = r.owner_id
    LEFT JOIN generation_outputs o ON o.run_id = r.id
    WHERE r.id = ANY($1::text[])
    ORDER BY r.started_at DESC, r.id DESC, o.created_at ASC, o.id ASC
  `, [pageRuns.map((run) => run.id)]);
  const records = rows.map((row) => {
    const runStatus = row.status === "succeeded" ? "success" : row.status === "failed" ? "error" : row.status;
    return {
      id: row.output_id ?? row.id,
      runId: row.id,
      image: row.image ?? "",
      thumbnail: row.image ? thumbnailUrlForImage(row.image) : "",
      nodeId: row.node_id,
      nodeLabel: row.node_label,
      kind: row.kind,
      projectId: row.project_id,
      projectName: row.project_name,
      ownerId: row.owner_id,
      ownerName: row.owner_name,
      prompt: row.output_prompt ?? row.prompt,
      parameters: parseJson2(row.parameters_json, {}),
      referenceImages: parseJson2(row.reference_images_json, []),
      model: row.model,
      requestedCount: row.requested_count,
      successfulCount: row.successful_count,
      providerRequests: row.provider_requests,
      providerOutputSize: row.provider_output_size,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.output_status ?? runStatus,
      error: row.output_error ?? row.error
    };
  });
  const lastRun = pageRuns.at(-1);
  res.json({
    records,
    nextCursor: hasMore && lastRun ? encodeCursor({ before, startedAt: lastRun.started_at, runId: lastRun.id }) : null,
    hasMore
  });
}));
historyRouter.delete("/:id", asyncHandler(async (req, res) => {
  const user = requestUser(req);
  const row = await queryOne(`
    SELECT r.owner_id, r.id AS run_id FROM generation_outputs o
    JOIN generation_runs r ON r.id = o.run_id WHERE o.id = $1 AND r.owner_id = $2
  `, [req.params.id, user.id]);
  if (!row) {
    res.status(404).json({ error: "\u8BB0\u5F55\u4E0D\u5B58\u5728" });
    return;
  }
  await query("DELETE FROM generation_outputs WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
}));

// server/routes/usage.ts
import { Router as Router9 } from "express";
var usageRouter = Router9();
async function queryRows(ownerId, from, to) {
  return query(`
    SELECT e.*, u.account_id, u.display_name
    FROM usage_events e JOIN users u ON u.id = e.owner_id
    WHERE ($1::text IS NULL OR e.owner_id = $1)
      AND e.deleted_at IS NULL
      AND ($2::text IS NULL OR e.created_at >= $2)
      AND ($3::text IS NULL OR e.created_at <= $3)
    ORDER BY e.created_at DESC
  `, [ownerId, from, to]);
}
function csvCell(value) {
  const text = value == null ? "" : String(value);
  const safeText = typeof value === "string" && /^\s*[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safeText) ? `"${safeText.replaceAll('"', '""')}"` : safeText;
}
usageRouter.get("/", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const user = requestUser(req);
  const selected = typeof req.query.userId === "string" ? req.query.userId : void 0;
  if (selected && user.role !== "admin" && selected !== user.id) {
    res.status(403).json({ error: "\u65E0\u6743\u67E5\u770B\u5176\u4ED6\u7528\u6237\u6D88\u8017" });
    return;
  }
  const ownerId = selected ?? (user.role === "admin" && req.query.all === "true" ? null : user.id);
  const from = typeof req.query.from === "string" && Number.isFinite(Date.parse(req.query.from)) ? req.query.from : null;
  const to = typeof req.query.to === "string" && Number.isFinite(Date.parse(req.query.to)) ? req.query.to : null;
  const rows = await queryRows(ownerId, from, to);
  if (req.query.format === "csv") {
    const header = ["\u8BB0\u5F55ID", "\u8D26\u53F7", "\u7528\u6237", "\u751F\u6210\u4EFB\u52A1", "\u9879\u76EE", "\u8282\u70B9", "\u6A21\u578B", "\u6210\u529F\u56FE\u7247\u6570", "\u670D\u52A1\u5546\u8BF7\u6C42\u6570", "\u8017\u65F6\u6BEB\u79D2", "\u65F6\u95F4"];
    const lines = [header, ...rows.map((row) => [
      row.id,
      row.account_id,
      row.display_name,
      row.run_id,
      row.project_id,
      row.node_id,
      row.model,
      row.successful_count,
      row.provider_requests,
      row.duration_ms,
      row.created_at
    ])].map((line) => line.map(csvCell).join(","));
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="usage-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(`\uFEFF${lines.join("\r\n")}`);
    return;
  }
  res.json(rows.map((row) => ({
    id: row.id,
    userId: row.owner_id,
    accountId: row.account_id,
    displayName: row.display_name,
    runId: row.run_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    model: row.model,
    successfulCount: row.successful_count,
    providerRequests: row.provider_requests,
    durationMs: row.duration_ms,
    createdAt: row.created_at
  })));
}));

// server/routes/aiDiagnostics.ts
import sharp6 from "sharp";
import { Router as Router10 } from "express";
function configuredGateway() {
  const url = new URL(config.apiyiBaseUrl());
  if (url.protocol !== "https:") throw new Error("APIYI_BASE_URL \u5FC5\u987B\u4F7F\u7528 HTTPS");
  config.apiyiApiKey();
  return { host: url.host };
}
function providerSettings(providerId) {
  configuredGateway();
  const contract = getImageModelContract(providerId);
  const probes = [
    ...contract.generation ? ["generate"] : [],
    "edit"
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
      timeoutMs: contract.timeoutMs
    }
  };
}
var getDiagnostics = asyncHandler(async (_req, res) => {
  let gateway = "\u672A\u914D\u7F6E";
  try {
    gateway = configuredGateway().host;
  } catch {
  }
  const providers2 = IMAGE_MODEL_IDS.map((providerId) => {
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
          ...contract.generation ? ["generate"] : [],
          "edit"
        ],
        configured: false,
        error: error instanceof Error ? error.message : "\u914D\u7F6E\u7F3A\u5931"
      };
    }
  });
  res.json({ gateway, providers: providers2 });
});
function diagnosticModelOptions(modelId) {
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
var diagnosticImagesPromise;
function diagnosticImages() {
  diagnosticImagesPromise ??= (async () => {
    const width = 1024;
    const height = 1024;
    const source = await sharp6({
      create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } }
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
    const mask = await sharp6(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();
    return {
      source: `data:image/png;base64,${source.toString("base64")}`,
      mask: `data:image/png;base64,${mask.toString("base64")}`
    };
  })();
  return diagnosticImagesPromise;
}
var probeDiagnostics = asyncHandler(async (req, res) => {
  const { providerId, mode } = req.body;
  if (!isImageModelId(providerId) || mode !== "generate" && mode !== "edit") {
    res.status(400).json({ error: "providerId \u6216\u8BCA\u65AD\u65B9\u5F0F\u65E0\u6548" });
    return;
  }
  const settings = providerSettings(providerId);
  if (!settings.probes.includes(mode)) {
    res.status(400).json({ error: `${providerId} \u4E0D\u652F\u6301${mode === "generate" ? "\u6587\u751F\u56FE" : "\u53C2\u8003\u56FE\u7F16\u8F91"}\u8BCA\u65AD` });
    return;
  }
  const startedAt = Date.now();
  try {
    const provider = getProvider(providerId);
    const prompt = "\u670D\u88C5\u8BBE\u8BA1\u7CFB\u7EDF\u8FDE\u901A\u6027\u6D4B\u8BD5\uFF1A\u751F\u6210\u4E00\u5757\u7EAF\u767D\u8272\u65B9\u5F62\u9762\u6599\u8272\u5361\uFF0C\u4E0D\u5305\u542B\u6587\u5B57";
    const modelOptions = diagnosticModelOptions(providerId);
    const result = mode === "generate" ? await provider.generate({ prompt, batchSize: 1, aspectRatio: "1:1", modelOptions }) : await (async () => {
      const images = await diagnosticImages();
      return provider.edit({
        prompt: "\u4FDD\u6301\u753B\u9762\u4E3A\u7EAF\u767D\u8272\u65B9\u5F62\u8272\u5361\uFF0C\u4E0D\u6DFB\u52A0\u6587\u5B57",
        referenceImages: [images.source],
        mask: providerId === "gpt-image-2" ? images.mask : void 0,
        batchSize: 1,
        aspectRatio: "1:1",
        modelOptions
      });
    })();
    res.json({
      ok: true,
      providerId,
      mode,
      model: settings.model,
      imageCount: result.images.length,
      durationMs: Date.now() - startedAt
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
      durationMs: Date.now() - startedAt
    });
  }
});
function createAiDiagnosticsRouter(probeRateLimit) {
  const router = Router10();
  router.use(requireAdmin);
  router.get("/", getDiagnostics);
  router.post("/probe", probeRateLimit, probeDiagnostics);
  return router;
}

// server/lib/legacyMigration.ts
import fs7 from "node:fs";
import path8 from "node:path";
import { nanoid as nanoid11 } from "nanoid";
var LEGACY_PLACEHOLDER_NOTE = "\u4ECE\u5347\u7EA7\u524D\u670D\u52A1\u5668\u6587\u4EF6\u8FC1\u79FB";
async function migrateLegacyData() {
  const admin = await queryOne(`
    SELECT id FROM users WHERE role = 'admin' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1
  `);
  if (!admin) return;
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const uploads = path8.join(config.dataDir(), "uploads");
  const uploadFiles = fs7.existsSync(uploads) ? fs7.readdirSync(uploads) : [];
  if (uploadFiles.length > 0) {
    await transaction(async (client) => {
      for (const file of uploadFiles) {
        const id = path8.basename(file);
        await client.query(`
          INSERT INTO files (id, owner_id, source_type, created_at) VALUES ($1, NULL, 'legacy', $2)
          ON CONFLICT (id) DO NOTHING
        `, [id, now]);
      }
    });
  }
  const projects = path8.join(config.dataDir(), "projects");
  if (fs7.existsSync(projects)) {
    await transaction(async (client) => {
      for (const file of fs7.readdirSync(projects)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs7.readFileSync(path8.join(projects, file), "utf-8"));
          if (typeof raw.id !== "string" || typeof raw.name !== "string") continue;
          const flow = validateAndMigrateFlow(raw.flow);
          const updatedAt = typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt)) ? raw.updatedAt : now;
          await client.query(`
            INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
            VALUES ($1, $2, $3, $4, $5, $5) ON CONFLICT (id) DO NOTHING
          `, [raw.id, admin.id, raw.name, JSON.stringify(flow), updatedAt]);
        } catch {
        }
      }
    });
  }
  const assets = path8.join(config.dataDir(), "assets");
  if (fs7.existsSync(assets)) {
    await transaction(async (client) => {
      for (const file of fs7.readdirSync(assets)) {
        if (!file.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs7.readFileSync(path8.join(assets, file), "utf-8"));
          if (typeof raw.id !== "string" || typeof raw.name !== "string" || !["print", "fabric", "reference"].includes(String(raw.category)) || typeof raw.image !== "string" || !isLocalImageReference(raw.image)) continue;
          const note = typeof raw.sourceNote === "string" ? raw.sourceNote : null;
          const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : now;
          const existing = await queryOne(
            "SELECT id, owner_id, scope, name, source_note FROM assets WHERE image = $1 LIMIT 1",
            [raw.image],
            client
          );
          if (!existing) {
            await client.query(`
              INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
              VALUES ($1, NULL, 'global', $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
            `, [raw.id, raw.name, raw.category, raw.image, note, createdAt]);
          } else if (existing.owner_id === null && existing.scope === "global" && existing.name === `\u5386\u53F2\u7D20\u6750-${path8.parse(path8.basename(raw.image)).name}` && existing.source_note === LEGACY_PLACEHOLDER_NOTE) {
            await client.query(`
              UPDATE assets SET name = $1, category = $2, source_note = $3, created_at = $4
              WHERE id = $5
            `, [raw.name, raw.category, note, createdAt, existing.id]);
          }
        } catch {
        }
      }
    });
  }
  if (uploadFiles.length > 0) {
    await transaction(async (client) => {
      for (const file of uploadFiles) {
        const id = path8.basename(file);
        const image = `/api/files/${id}`;
        const existing = await queryOne(
          "SELECT id FROM assets WHERE image = $1 LIMIT 1",
          [image],
          client
        );
        if (!existing) {
          await client.query(`
            INSERT INTO assets (id, owner_id, scope, name, category, image, source_note, created_at)
            VALUES ($1, NULL, 'global', $2, 'reference', $3, $4, $5)
          `, [nanoid11(10), `\u5386\u53F2\u7D20\u6750-${path8.parse(id).name}`, image, LEGACY_PLACEHOLDER_NOTE, now]);
        }
      }
    });
  }
}

// server/lib/staticFrontend.ts
import express from "express";
import path9 from "node:path";
var HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
function explicitlyAcceptsHtml(req) {
  const accept = req.get("Accept") ?? "";
  return /\btext\/html\b/i.test(accept) && req.accepts("html") === "html";
}
function mountProductionFrontend(app2, distDir2) {
  const distIndex2 = path9.join(distDir2, "index.html");
  const assetsDir = path9.join(distDir2, "assets") + path9.sep;
  app2.use(express.static(distDir2, {
    index: false,
    fallthrough: true,
    setHeaders: (res, filePath) => {
      if (path9.resolve(filePath) === path9.resolve(distIndex2)) {
        res.setHeader("Cache-Control", "no-store");
      } else if (filePath.startsWith(assetsDir) && HASHED_ASSET.test(path9.basename(filePath))) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else {
        res.setHeader("Cache-Control", "no-cache");
      }
    }
  }));
  app2.use("/assets", (_req, res) => {
    res.status(404).type("text/plain").send("Asset not found");
  });
  app2.get("*", (req, res) => {
    const isResourcePath = path9.extname(req.path) !== "";
    if (isResourcePath || !explicitlyAcceptsHtml(req)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(distIndex2);
  });
}

// server/index.ts
var app = express2();
app.use(express2.json({ limit: "50mb" }));
var aiRateLimit = createRateLimitMiddleware();
var loginRateLimit = createRateLimitMiddleware({ windowMs: 6e4, maxRequests: 10 });
var aiDiagnosticsRouter = createAiDiagnosticsRouter(aiRateLimit);
app.get("/api/health", (_req, res) => res.json({ ok: true, status: "alive" }));
var isProduction = process.env.NODE_ENV === "production";
var apiOnly = config.apiOnly();
var distDir = path10.join(ROOT_DIR, "dist");
var distIndex = path10.join(distDir, "index.html");
function dataDirWritable() {
  const dataDir = config.dataDir();
  const probePath = path10.join(dataDir, `.readiness-${process.pid}-${Date.now()}`);
  let fd;
  let writable = false;
  try {
    fs8.mkdirSync(dataDir, { recursive: true });
    if (!fs8.statSync(dataDir).isDirectory()) return false;
    fd = fs8.openSync(probePath, "wx");
    fs8.writeSync(fd, "ready");
    writable = true;
  } catch {
    writable = false;
  } finally {
    try {
      if (fd !== void 0) fs8.closeSync(fd);
    } catch {
      writable = false;
    }
    try {
      fs8.rmSync(probePath, { force: true });
    } catch {
      writable = false;
    }
  }
  return writable;
}
async function readiness() {
  const checks = {
    dataDirWritable: dataDirWritable(),
    frontend: !isProduction || apiOnly || fs8.existsSync(distIndex),
    aiConfigured: config.aiConfigReady(),
    database: await databaseReady(),
    usersConfigured: await hasUsers()
  };
  return { ok: Object.values(checks).every(Boolean), checks, mode: apiOnly ? "api-only" : "full" };
}
app.get("/api/ready", asyncHandler(async (_req, res) => {
  const ready = await readiness();
  res.status(ready.ok ? 200 : 503).json(ready);
}));
app.use("/api/auth/login", loginRateLimit);
app.use("/api/auth", authRouter);
app.use("/api", requireAuth, requirePasswordChanged);
app.use("/api/generate", aiRateLimit, generateRouter);
app.post("/api/run-plan", aiRateLimit);
app.use("/api/run-plan", runPlanRouter);
app.use("/api/files", filesRouter);
app.use("/api/projects", projectsRouter);
app.use("/api/templates", templatesRouter);
app.use("/api/assets", assetsRouter);
app.use("/api/history", historyRouter);
app.use("/api/usage", usageRouter);
app.use("/api/ai-diagnostics", aiDiagnosticsRouter);
app.use("/api", (_req, res) => res.status(404).json({ error: "API not found" }));
if (isProduction && !apiOnly) {
  if (!fs8.existsSync(distIndex)) {
    throw new Error(
      `Production frontend is missing: ${distIndex}. Run npm run build, or set API_ONLY=true for an API-only deployment.`
    );
  }
  mountProductionFrontend(app, distDir);
}
var apiErrorHandler = (error, _req, res, _next) => {
  console.error("[garment-canvas] request failed", error);
  if (!res.headersSent) res.status(500).json({ error: "\u670D\u52A1\u5668\u6682\u65F6\u65E0\u6CD5\u5904\u7406\u8BF7\u6C42" });
};
app.use(apiErrorHandler);
var port = config.port();
async function start() {
  await initializeDatabase();
  await pruneExpiredSessions();
  await migrateLegacyData();
  const initialReadiness = await readiness();
  if (!initialReadiness.ok) throw new Error(`Server is not ready: ${JSON.stringify(initialReadiness.checks)}`);
  const sessionPruneTimer = setInterval(() => {
    void pruneExpiredSessions().catch((error) => {
      console.error("[garment-canvas] session cleanup failed", error);
    });
  }, 6 * 60 * 60 * 1e3);
  sessionPruneTimer.unref();
  startGenerationWorker();
  app.listen(port, () => {
    console.log(`[garment-canvas] server listening on http://localhost:${port} (${initialReadiness.mode})`);
  });
}
await start();
