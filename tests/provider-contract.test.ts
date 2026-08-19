import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import sharp from "sharp";
import { config } from "../server/config";
import { validateImageDataUrl } from "../server/lib/imageValidation";
import { createRateLimitMiddleware } from "../server/lib/rateLimit";
import { image2Provider } from "../server/providers/image2";
import { IMAGE2_COLLAGE_LAYOUT, MAX_REFERENCE_INPUT_PIXELS } from "../server/providers/image2References";
import { nanobananaProvider } from "../server/providers/nanobanana";
import { fetchWithRetry, ProviderError } from "../server/providers/base";
import { createAiDiagnosticsRouter } from "../server/routes/aiDiagnostics";

let passed = 0;

const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const VALID_PNG_DATA_URL = `data:image/png;base64,${VALID_PNG_BASE64}`;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

function setEnv(name: string, value: string | undefined): () => void {
  const original = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  };
}

function installFetchMock(
  implementation: (input: string | URL | Request, init?: RequestInit) => Response | Promise<Response>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = implementation as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function solidPngDataUrl(color: { r: number; g: number; b: number }): Promise<string> {
  const buffer = await sharp({
    create: {
      width: 24,
      height: 24,
      channels: 3,
      background: color,
    },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function svgDataUrl(width: number, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function assertPixelColor(
  data: Buffer,
  width: number,
  channels: number,
  x: number,
  y: number,
  expected: { r: number; g: number; b: number },
): void {
  const offset = (y * width + x) * channels;
  assert.ok(Math.abs(data[offset] - expected.r) <= 2);
  assert.ok(Math.abs(data[offset + 1] - expected.g) <= 2);
  assert.ok(Math.abs(data[offset + 2] - expected.b) <= 2);
}

async function main(): Promise<void> {
  console.log("Provider / 限流契约测试");

  await test("模型 ID 必须由部署显式配置", () => {
    const restoreModel = setEnv("NANOBANANA_MODEL", undefined);
    const restoreTimeout = setEnv("AI_TIMEOUT_MS", undefined);
    try {
      assert.throws(() => config.nanobananaModel(), /NANOBANANA_MODEL/);
      assert.equal(config.aiTimeoutMs(), 300_000);
    } finally {
      restoreTimeout();
      restoreModel();
    }
  });

  await test("Provider 公共请求出口拒绝非 HTTPS 且不会发送 Bearer 请求", async () => {
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return Response.json({ data: [] });
    });
    try {
      await assert.rejects(
        () => fetchWithRetry("http://gateway.example/v1/images/generations", () => ({
          headers: { Authorization: "Bearer secret" },
        })),
        (error: unknown) => error instanceof ProviderError && error.category === "invalid_request",
      );
      assert.equal(calls, 0);
    } finally {
      restoreFetch();
    }
  });

  await test("nanobanana 文生图调用 Images generations 契约", async () => {
    const restoreBase = setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1");
    const restoreKey = setEnv("NANOBANANA_API_KEY", "nanobanana-test-key");
    const restoreModel = setEnv("NANOBANANA_MODEL", "gpt-image-2");
    const restoreN = setEnv("NANOBANANA_SUPPORTS_N", "false");
    const restoreRetries = setEnv("AI_MAX_RETRIES", "0");
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const restoreFetch = installFetchMock((input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
    });
    try {
      const result = await nanobananaProvider.generate({
        prompt: "服装效果图",
        aspectRatio: "3:4",
        batchSize: 1,
      });
      assert.equal(capturedUrl, "https://gateway.example/v1/images/generations");
      assert.equal(new Headers(capturedInit?.headers).get("authorization"), "Bearer nanobanana-test-key");
      assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
        model: "gpt-image-2",
        prompt: "服装效果图",
        size: "1024x1536",
        quality: "low",
        output_format: "png",
      });
      assert.deepEqual(result.images, [VALID_PNG_DATA_URL]);
    } finally {
      restoreFetch();
      restoreRetries();
      restoreN();
      restoreModel();
      restoreKey();
      restoreBase();
    }
  });

  await test("nanobanana 多参考图使用单数 image 拼图和官方 edits 参数", async () => {
    const restores = [
      setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1"),
      setEnv("NANOBANANA_API_KEY", "nanobanana-test-key"),
      setEnv("NANOBANANA_MODEL", "gpt-image-2"),
      setEnv("NANOBANANA_SUPPORTS_N", "false"),
      setEnv("NANOBANANA_SUPPORTS_MULTI_REFERENCE", "true"),
      setEnv("NANOBANANA_MAX_REFERENCE_IMAGES", "8"),
      setEnv("AI_MAX_RETRIES", "0"),
    ];
    let capturedUrl = "";
    let capturedForm: FormData | undefined;
    const restoreFetch = installFetchMock((input, init) => {
      capturedUrl = String(input);
      capturedForm = init?.body as FormData;
      return Response.json({ data: [{ url: "https://cdn.example/result.png" }] });
    });
    try {
      const referenceImages = await Promise.all([
        solidPngDataUrl({ r: 220, g: 30, b: 30 }),
        solidPngDataUrl({ r: 30, g: 30, b: 220 }),
      ]);
      const result = await nanobananaProvider.edit!({
        prompt: "延伸款式",
        aspectRatio: "1:1",
        batchSize: 2,
        referenceImages,
      });
      assert.equal(capturedUrl, "https://gateway.example/v1/images/edits");
      assert.equal(capturedForm?.get("model"), "gpt-image-2");
      const sentPrompt = String(capturedForm?.get("prompt"));
      assert.match(sentPrompt, /^Reference collage: Image 1\.\.2 are arranged row by row/);
      assert.ok(sentPrompt.endsWith("延伸款式"));
      assert.equal(capturedForm?.get("n"), null);
      assert.equal(capturedForm?.get("size"), "1024x1024");
      assert.equal(capturedForm?.get("quality"), "low");
      assert.equal(capturedForm?.get("output_format"), "png");
      assert.ok(capturedForm?.get("image") instanceof Blob);
      assert.equal(capturedForm?.getAll("image").length, 1);
      assert.equal(capturedForm?.getAll("image[]").length, 0);
      assert.deepEqual(result.images, ["https://cdn.example/result.png"]);
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("image2 的 2 图和 8 图按顺序编号合成单张拼图，且限制最多 8 图", async () => {
    const restores = [
      setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1"),
      setEnv("CHANGE2PRO_API_KEY", "image2-test-key"),
      setEnv("IMAGE2_MODEL", "gpt-image-2"),
      setEnv("IMAGE2_SUPPORTS_N", "false"),
      setEnv("IMAGE2_SUPPORTS_MULTI_REFERENCE", "true"),
      setEnv("IMAGE2_MAX_REFERENCE_IMAGES", "8"),
      setEnv("AI_MAX_RETRIES", "0"),
    ];
    let capturedForm: FormData | undefined;
    let calls = 0;
    const restoreFetch = installFetchMock((_input, init) => {
      calls += 1;
      capturedForm = init?.body as FormData;
      return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
    });
    const colors = [
      { r: 230, g: 20, b: 20 },
      { r: 20, g: 180, b: 20 },
      { r: 20, g: 20, b: 230 },
      { r: 230, g: 180, b: 20 },
      { r: 220, g: 20, b: 200 },
      { r: 20, g: 200, b: 200 },
      { r: 230, g: 100, b: 20 },
      { r: 100, g: 40, b: 180 },
    ];
    const refs = await Promise.all(colors.map((color) => solidPngDataUrl(color)));
    try {
      for (const count of [2, 8]) {
        await image2Provider.edit({ prompt: "多图融合", referenceImages: refs.slice(0, count) });
        const image = capturedForm?.get("image");
        assert.ok(image instanceof Blob);
        assert.equal(capturedForm?.getAll("image").length, 1);
        assert.equal(capturedForm?.getAll("image[]").length, 0);
        assert.equal(capturedForm?.get("quality"), "low");
        assert.equal(capturedForm?.get("output_format"), "png");
        const sentPrompt = String(capturedForm?.get("prompt"));
        assert.match(sentPrompt, new RegExp(`^Reference collage: Image 1\\.\\.${count} are arranged row by row`));
        assert.ok(sentPrompt.endsWith("多图融合"));

        const decoded = await sharp(Buffer.from(await image.arrayBuffer()))
          .raw()
          .toBuffer({ resolveWithObject: true });
        const { padding, gap, labelHeight, tileSize, maxColumns } = IMAGE2_COLLAGE_LAYOUT;
        const columns = Math.min(count, maxColumns);
        const rows = Math.ceil(count / columns);
        assert.equal(decoded.info.width, padding * 2 + columns * tileSize + (columns - 1) * gap);
        assert.equal(decoded.info.height, padding * 2 + rows * (labelHeight + tileSize) + (rows - 1) * gap);

        for (let index = 0; index < count; index += 1) {
          const column = index % columns;
          const row = Math.floor(index / columns);
          const x = padding + column * (tileSize + gap) + Math.floor(tileSize / 2);
          const y = padding + row * (labelHeight + tileSize + gap) + labelHeight + Math.floor(tileSize / 2);
          assertPixelColor(decoded.data, decoded.info.width, decoded.info.channels, x, y, colors[index]);
        }
      }

      const callsBeforeRejection = calls;
      await assert.rejects(
        () => image2Provider.edit({ prompt: "超量", referenceImages: [...refs, refs[0]] }),
        /最多支持 8 张参考图/,
      );
      assert.equal(calls, callsBeforeRejection, "超过 8 图应在调用网关前拒绝");
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("image2 单参考图原样使用单数 image，并发送官方 edits 输出参数", async () => {
    const restores = [
      setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1"),
      setEnv("CHANGE2PRO_API_KEY", "image2-test-key"),
      setEnv("IMAGE2_MODEL", "gpt-image-2"),
      setEnv("IMAGE2_SUPPORTS_N", "false"),
      setEnv("AI_MAX_RETRIES", "0"),
    ];
    let capturedForm: FormData | undefined;
    const restoreFetch = installFetchMock((_input, init) => {
      capturedForm = init?.body as FormData;
      return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
    });
    try {
      const referenceImage = await solidPngDataUrl({ r: 80, g: 120, b: 160 });
      await image2Provider.edit({
        prompt: "印花裂变",
        referenceImages: [referenceImage],
      });
      assert.equal(capturedForm?.get("model"), "gpt-image-2");
      assert.equal(capturedForm?.get("size"), null);
      assert.equal(capturedForm?.get("n"), null);
      assert.equal(capturedForm?.get("quality"), "low");
      assert.equal(capturedForm?.get("output_format"), "png");
      assert.equal(capturedForm?.get("prompt"), "印花裂变");
      const image = capturedForm?.get("image");
      assert.ok(image instanceof Blob);
      assert.equal(capturedForm?.getAll("image").length, 1);
      assert.equal(capturedForm?.getAll("image[]").length, 0);
      assert.deepEqual(
        Buffer.from(await image.arrayBuffer()),
        Buffer.from(referenceImage.split(",")[1], "base64"),
      );
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("多参考图与 mask 组合在拼图和网关请求前被两个 Provider 拒绝", async () => {
    const restores = [
      setEnv("IMAGE2_SUPPORTS_MULTI_REFERENCE", "true"),
      setEnv("IMAGE2_MAX_REFERENCE_IMAGES", "8"),
      setEnv("NANOBANANA_SUPPORTS_MULTI_REFERENCE", "true"),
      setEnv("NANOBANANA_MAX_REFERENCE_IMAGES", "8"),
    ];
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
    });
    const invalidReferences = [
      "data:image/png;base64,not-a-valid-image",
      "data:image/png;base64,still-not-a-valid-image",
    ];
    try {
      for (const provider of [image2Provider, nanobananaProvider]) {
        await assert.rejects(
          () => provider.edit!({
            prompt: "修改",
            referenceImages: invalidReferences,
            mask: "data:image/png;base64,also-invalid",
          }),
          (error: unknown) => error instanceof ProviderError &&
            error.status === 400 &&
            error.message.includes("多参考图拼图暂不支持蒙版"),
        );
      }
      assert.equal(calls, 0);
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("多参考图能力开关关闭时在拼图和网关请求前拒绝", async () => {
    const restores = [
      setEnv("IMAGE2_SUPPORTS_MULTI_REFERENCE", "false"),
      setEnv("NANOBANANA_SUPPORTS_MULTI_REFERENCE", "false"),
    ];
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
    });
    const invalidReferences = [
      "data:image/png;base64,not-a-valid-image",
      "data:image/png;base64,still-not-a-valid-image",
    ];
    try {
      for (const provider of [image2Provider, nanobananaProvider]) {
        await assert.rejects(
          () => provider.edit!({ prompt: "修改", referenceImages: invalidReferences }),
          (error: unknown) => error instanceof ProviderError &&
            error.status === 400 &&
            error.message.includes("未开启多参考图"),
        );
      }
      assert.equal(calls, 0);
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("多参考图拼图在解码时限制每张图最多 40MP", async () => {
    const restores = [
      setEnv("IMAGE2_SUPPORTS_MULTI_REFERENCE", "true"),
      setEnv("IMAGE2_MAX_REFERENCE_IMAGES", "8"),
    ];
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
    });
    try {
      assert.equal(MAX_REFERENCE_INPUT_PIXELS, 40_000_000);
      const smallReference = await solidPngDataUrl({ r: 20, g: 30, b: 40 });
      await assert.rejects(
        () => image2Provider.edit({
          prompt: "大图",
          referenceImages: [
            svgDataUrl(7_000, 6_000),
            smallReference,
          ],
        }),
        /pixel limit/i,
      );
      assert.equal(calls, 0);
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("image2 edits 收到 400 时只请求一次", async () => {
    const restores = [
      setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1"),
      setEnv("CHANGE2PRO_API_KEY", "image2-test-key"),
      setEnv("IMAGE2_MODEL", "gpt-image-2"),
      setEnv("IMAGE2_SUPPORTS_N", "false"),
      setEnv("AI_MAX_RETRIES", "3"),
    ];
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "invalid image request" } }), { status: 400 });
    });
    try {
      const referenceImage = await solidPngDataUrl({ r: 40, g: 80, b: 120 });
      await assert.rejects(
        () => image2Provider.edit({ prompt: "修改", referenceImages: [referenceImage] }),
        (error: unknown) => error instanceof ProviderError && error.status === 400,
      );
      assert.equal(calls, 1);
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("image2 文生图保留低质量 PNG 输出参数", async () => {
    const restoreBase = setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1");
    const restoreKey = setEnv("CHANGE2PRO_API_KEY", "image2-test-key");
    const restoreModel = setEnv("IMAGE2_MODEL", "gpt-image-2");
    const restoreN = setEnv("IMAGE2_SUPPORTS_N", "false");
    const restoreRetries = setEnv("AI_MAX_RETRIES", "0");
    let body: Record<string, unknown> = {};
    const restoreFetch = installFetchMock((_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
    });
    try {
      await image2Provider.generate({ prompt: "印花", batchSize: 8 });
      assert.equal("n" in body, false, "不支持批量 n 的网关不得收到 n 参数");
      assert.equal(body.quality, "low");
      assert.equal(body.output_format, "png");
    } finally {
      restoreFetch();
      restoreRetries();
      restoreN();
      restoreModel();
      restoreKey();
      restoreBase();
    }
  });

  await test("声明支持批量 n 时按网关上限发送", async () => {
    const restores = [
      setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1"),
      setEnv("CHANGE2PRO_API_KEY", "image2-test-key"),
      setEnv("IMAGE2_MODEL", "image-model"),
      setEnv("IMAGE2_SUPPORTS_N", "true"),
      setEnv("IMAGE2_MAX_BATCH", "2"),
      setEnv("AI_MAX_RETRIES", "0"),
    ];
    let body: Record<string, unknown> = {};
    const restoreFetch = installFetchMock((_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ data: [{ b64_json: VALID_PNG_BASE64 }] });
    });
    try {
      await image2Provider.generate({ prompt: "批量", batchSize: 4 });
      assert.equal(body.n, 2);
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("GPT Images 响应拒绝损坏 base64、仅 PNG 签名、截断 IDAT、JPEG 伪装和非法 URL", async () => {
    const restores = [
      setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1"),
      setEnv("CHANGE2PRO_API_KEY", "image2-test-key"),
      setEnv("NANOBANANA_API_KEY", "nanobanana-test-key"),
      setEnv("IMAGE2_MODEL", "gpt-image-2"),
      setEnv("NANOBANANA_MODEL", "gpt-image-2"),
      setEnv("AI_MAX_RETRIES", "3"),
    ];
    const jpegBase64 = (await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 120, g: 80, b: 40 } },
    }).jpeg().toBuffer()).toString("base64");
    const invalidBase64 = "not-canonical-base64-response";
    const signatureOnlyBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");
    const validPng = Buffer.from(VALID_PNG_BASE64, "base64");
    const idatTypeOffset = validPng.indexOf(Buffer.from("IDAT"));
    assert.ok(idatTypeOffset > 12, "PNG fixture must contain an IDAT chunk");
    const idatLength = validPng.readUInt32BE(idatTypeOffset - 4);
    assert.ok(idatLength > 1, "PNG fixture IDAT must be large enough to truncate");
    const truncatedPngBase64 = validPng
      .subarray(0, idatTypeOffset + 4 + Math.floor(idatLength / 2))
      .toString("base64");
    assert.doesNotThrow(
      () => validateImageDataUrl(`data:image/png;base64,${signatureOnlyBase64}`),
      "signature-only fixture must demonstrate the old magic-byte-only gap",
    );
    assert.doesNotThrow(
      () => validateImageDataUrl(`data:image/png;base64,${truncatedPngBase64}`),
      "truncated-IDAT fixture must pass the old magic-byte-only check",
    );
    const signedRelativeUrl = "/result.png?token=must-not-appear-in-diagnostics";
    let responsePayload: unknown = {};
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return Response.json(responsePayload);
    });
    try {
      const scenarios = [
        {
          provider: image2Provider,
          providerId: "gpt-image-2",
          payload: { data: [{ b64_json: invalidBase64 }] },
          itemIndex: 0,
          secret: invalidBase64,
        },
        {
          provider: nanobananaProvider,
          providerId: "nanobanana",
          payload: { data: [{ b64_json: signatureOnlyBase64 }] },
          itemIndex: 0,
          secret: signatureOnlyBase64,
        },
        {
          provider: image2Provider,
          providerId: "gpt-image-2",
          payload: { data: [{ b64_json: truncatedPngBase64 }] },
          itemIndex: 0,
          secret: truncatedPngBase64.slice(-24),
        },
        {
          provider: nanobananaProvider,
          providerId: "nanobanana",
          payload: { data: [{ b64_json: jpegBase64 }] },
          itemIndex: 0,
          secret: jpegBase64.slice(0, 24),
        },
        {
          provider: image2Provider,
          providerId: "gpt-image-2",
          payload: { data: [{ b64_json: VALID_PNG_BASE64 }, { url: signedRelativeUrl }] },
          itemIndex: 1,
          secret: "must-not-appear-in-diagnostics",
        },
      ];

      for (const scenario of scenarios) {
        responsePayload = scenario.payload;
        calls = 0;
        await assert.rejects(
          () => scenario.provider.generate({ prompt: "响应校验" }),
          (error: unknown) => {
            assert.ok(error instanceof ProviderError);
            assert.equal(error.status, 502);
            assert.equal(error.category, "invalid_response");
            assert.equal(error.providerId, scenario.providerId);
            assert.match(error.message, /无效图片/);
            assert.match(error.diagnostic ?? "", new RegExp(`item ${scenario.itemIndex}`));
            assert.equal((error.diagnostic ?? "").includes(scenario.secret), false);
            assert.equal(error.message.includes(scenario.secret), false);
            return true;
          },
        );
        assert.equal(calls, 1, "200 响应内的损坏图片不应触发付费重试");
      }
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("GPT Images 合法 HTTPS URL 只做结构校验，Provider 不额外下载", async () => {
    const restores = [
      setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1"),
      setEnv("CHANGE2PRO_API_KEY", "image2-test-key"),
      setEnv("IMAGE2_MODEL", "gpt-image-2"),
      setEnv("AI_MAX_RETRIES", "3"),
    ];
    const signedUrl = "https://cdn.example/result.png?token=private-signed-value";
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return Response.json({ data: [{ url: signedUrl }] });
    });
    try {
      const result = await image2Provider.generate({ prompt: "URL 响应" });
      assert.deepEqual(result.images, [signedUrl]);
      assert.equal(calls, 1, "Provider 只应请求一次网关，URL 下载留给持久化边界");
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("安全拒绝的常见正反向措辞均正确分类，且 4xx 不重试", async () => {
    const restoreRetries = setEnv("AI_MAX_RETRIES", "2");
    let responseBody: unknown = {};
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return new Response(JSON.stringify(responseBody), { status: 400 });
    });
    try {
      for (const error of [
        { message: "content policy violation: raw gateway detail" },
        { message: "Your request was rejected as a result of our safety system." },
        { code: "content_filter", message: "The response was filtered by the content management policy." },
        { code: "ResponsibleAIPolicyViolation", message: "The request was blocked." },
      ]) {
        responseBody = { error };
        calls = 0;
        await assert.rejects(
          () => fetchWithRetry("https://gateway.example/v1/images/edits", () => ({}), { providerId: "test" }),
          (caught: unknown) => caught instanceof ProviderError &&
            caught.category === "content_refused" &&
            caught.message === "本次请求未通过 AI 安全审核，请调整提示词或参考图片后重试",
        );
        assert.equal(calls, 1);
      }

      responseBody = {
        error: {
          code: "unknown_parameter",
          message: "Unknown parameter: tools[0].n",
        },
      };
      calls = 0;
      await assert.rejects(
        () => fetchWithRetry("https://gateway.example/v1/images/edits", () => ({}), { providerId: "test" }),
        (caught: unknown) => caught instanceof ProviderError && caught.category === "invalid_request",
      );
      assert.equal(calls, 1);
    } finally {
      restoreFetch();
      restoreRetries();
    }
  });

  await test("网关 401/403 鉴权失败提示管理员检查配置，且不重试", async () => {
    let status = 401;
    let responseMessage = "content policy violation while validating the API key";
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: responseMessage } }), { status });
    });
    try {
      for (const scenario of [
        { status: 401, message: "content policy violation while validating the API key" },
        { status: 403, message: "model gpt-image-2 is not available for this API key" },
      ]) {
        status = scenario.status;
        responseMessage = scenario.message;
        calls = 0;
        await assert.rejects(
          () => fetchWithRetry("https://gateway.example/v1/images/generations", () => ({}), {
            maxRetries: 2,
            providerId: "test",
          }),
          (error: unknown) => error instanceof ProviderError &&
            error.status === status &&
            error.category === "gateway_authentication" &&
            error.message === "AI 网关鉴权失败，请联系管理员检查 API Key 或账号权限",
        );
        assert.equal(calls, 1);
      }
    } finally {
      restoreFetch();
    }
  });

  await test("AI 诊断只对 POST probe 限流，GET 配置检查不消耗额度", async () => {
    const restores = [
      setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1"),
      setEnv("CHANGE2PRO_API_KEY", "diagnostic-test-key"),
      setEnv("NANOBANANA_MODEL", "nanobanana-test-model"),
      setEnv("IMAGE2_MODEL", "image2-test-model"),
    ];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { authUser: unknown }).authUser = {
        id: "admin-test",
        accountId: "admin-test",
        displayName: "Admin Test",
        role: "admin",
        mustChangePassword: false,
      };
      next();
    });
    app.use("/api/ai-diagnostics", createAiDiagnosticsRouter(createRateLimitMiddleware({
      windowMs: 60_000,
      maxRequests: 1,
    })));
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/ai-diagnostics`;
    try {
      assert.equal((await fetch(baseUrl)).status, 200);
      assert.equal((await fetch(baseUrl)).status, 200);

      const firstProbe = await fetch(`${baseUrl}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "invalid", mode: "invalid" }),
      });
      assert.equal(firstProbe.status, 400);
      const limitedProbe = await fetch(`${baseUrl}/probe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId: "invalid", mode: "invalid" }),
      });
      assert.equal(limitedProbe.status, 429);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("AI 限流按 IP 计数并在窗口结束后重置", () => {
    let currentTime = 10_000;
    const middleware = createRateLimitMiddleware({
      windowMs: 60_000,
      maxRequests: 2,
      now: () => currentTime,
    });
    let statusCode = 200;
    let payload: unknown;
    let nextCalls = 0;
    const req = { ip: "127.0.0.1", socket: {} } as Request;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(value: unknown) {
        payload = value;
        return this;
      },
    } as unknown as Response;
    const next = (() => {
      nextCalls += 1;
    }) as NextFunction;

    middleware(req, res, next);
    middleware(req, res, next);
    middleware(req, res, next);
    assert.equal(nextCalls, 2);
    assert.equal(statusCode, 429);
    assert.deepEqual(payload, { error: "Too many requests, please slow down", retryAfter: 60 });

    currentTime += 60_000;
    middleware(req, res, next);
    assert.equal(nextCalls, 3);
  });

  await test("单跳反向代理下不同客户端使用独立限流桶", async () => {
    const app = express();
    app.set("trust proxy", 1);
    app.use(createRateLimitMiddleware({ windowMs: 60_000, maxRequests: 1 }));
    app.get("/limited", (req, res) => res.json({ ip: req.ip }));

    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/limited`;
    try {
      const firstClient = await fetch(url, { headers: { "X-Forwarded-For": "192.168.2.10" } });
      assert.equal(firstClient.status, 200);
      assert.deepEqual(await firstClient.json(), { ip: "192.168.2.10" });
      assert.equal((await fetch(url, { headers: { "X-Forwarded-For": "192.168.2.10" } })).status, 429);

      const secondClient = await fetch(url, { headers: { "X-Forwarded-For": "192.168.2.11" } });
      assert.equal(secondClient.status, 200);
      assert.deepEqual(await secondClient.json(), { ip: "192.168.2.11" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  console.log(`\n通过 ${passed} 项`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
