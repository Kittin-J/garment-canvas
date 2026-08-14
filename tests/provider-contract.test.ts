import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import { config } from "../server/config";
import { createRateLimitMiddleware } from "../server/lib/rateLimit";
import { image2Provider } from "../server/providers/image2";
import { nanobananaProvider } from "../server/providers/nanobanana";
import { fetchWithRetry, ProviderError } from "../server/providers/base";
import { createAiDiagnosticsRouter } from "../server/routes/aiDiagnostics";

let passed = 0;

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
      return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
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
      assert.deepEqual(result.images, ["data:image/png;base64,aW1hZ2U="]);
    } finally {
      restoreFetch();
      restoreRetries();
      restoreN();
      restoreModel();
      restoreKey();
      restoreBase();
    }
  });

  await test("nanobanana 多参考图使用 image[] multipart edits 契约", async () => {
    const restoreBase = setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1");
    const restoreKey = setEnv("NANOBANANA_API_KEY", "nanobanana-test-key");
    const restoreModel = setEnv("NANOBANANA_MODEL", "gpt-image-2");
    const restoreN = setEnv("NANOBANANA_SUPPORTS_N", "false");
    const restoreRetries = setEnv("AI_MAX_RETRIES", "0");
    let capturedUrl = "";
    let capturedForm: FormData | undefined;
    const restoreFetch = installFetchMock((input, init) => {
      capturedUrl = String(input);
      capturedForm = init?.body as FormData;
      return Response.json({ data: [{ url: "https://cdn.example/result.png" }] });
    });
    try {
      const result = await nanobananaProvider.edit!({
        prompt: "延伸款式",
        aspectRatio: "1:1",
        batchSize: 2,
        referenceImages: [
          "data:image/png;base64,iVBORw0KGgo=",
          "data:image/png;base64,iVBORw0KGgo=",
        ],
      });
      assert.equal(capturedUrl, "https://gateway.example/v1/images/edits");
      assert.equal(capturedForm?.get("model"), "gpt-image-2");
      assert.equal(capturedForm?.get("prompt"), "延伸款式");
      assert.equal(capturedForm?.get("n"), null);
      assert.equal(capturedForm?.get("image"), null);
      assert.equal(capturedForm?.getAll("image[]").length, 2);
      assert.ok(capturedForm?.getAll("image[]").every((value) => value instanceof Blob));
      assert.deepEqual(result.images, ["https://cdn.example/result.png"]);
    } finally {
      restoreFetch();
      restoreRetries();
      restoreN();
      restoreModel();
      restoreKey();
      restoreBase();
    }
  });

  await test("image2 多参考图保持顺序并限制最多 8 图", async () => {
    const restoreBase = setEnv("CHANGE2PRO_BASE_URL", "https://gateway.example/v1");
    const restoreKey = setEnv("CHANGE2PRO_API_KEY", "image2-test-key");
    const restoreModel = setEnv("IMAGE2_MODEL", "gpt-image-2");
    const restoreRetries = setEnv("AI_MAX_RETRIES", "0");
    let capturedForm: FormData | undefined;
    const restoreFetch = installFetchMock((_input, init) => {
      capturedForm = init?.body as FormData;
      return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
    });
    const refs = Array.from({ length: 8 }, () => "data:image/png;base64,iVBORw0KGgo=");
    try {
      await image2Provider.edit({ prompt: "多图融合", referenceImages: refs });
      assert.equal(capturedForm?.get("image"), null);
      assert.equal(capturedForm?.getAll("image[]").length, 8);
      await assert.rejects(
        () => image2Provider.edit({ prompt: "超量", referenceImages: [...refs, refs[0]] }),
        /最多支持 8 张参考图/,
      );
    } finally {
      restoreFetch();
      restoreRetries();
      restoreModel();
      restoreKey();
      restoreBase();
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
      return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
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
      return Response.json({ data: [{ b64_json: "aW1hZ2U=" }] });
    });
    try {
      await image2Provider.generate({ prompt: "批量", batchSize: 4 });
      assert.equal(body.n, 2);
    } finally {
      restoreFetch();
      restores.reverse().forEach((restore) => restore());
    }
  });

  await test("内容拒绝转换为用户提示，且 4xx 参数错误不重试", async () => {
    const restoreRetries = setEnv("AI_MAX_RETRIES", "2");
    let calls = 0;
    const restoreFetch = installFetchMock(() => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "content policy violation: raw gateway detail" } }), { status: 400 });
    });
    try {
      await assert.rejects(
        () => fetchWithRetry("https://gateway.example/v1/images/edits", () => ({}), { providerId: "test" }),
        (error: unknown) => error instanceof ProviderError && error.category === "content_refused" && error.message === "原图案无法完整复刻，可尝试风格化重绘",
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

  console.log(`\n通过 ${passed} 项`);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
