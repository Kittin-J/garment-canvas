import assert from "node:assert/strict";
import {
  fetchWithRetry,
  ProviderError,
  providerErrorFromResponse,
  sanitizedProviderDiagnostic,
} from "../server/providers/base";
import { generateExactImages } from "../server/providers/exact";
import type { AIProvider } from "../src/types/workflow";

const originalFetch = globalThis.fetch;

let providerCalls = 0;
const retryableProvider: AIProvider = {
  id: "stub",
  async generate() {
    providerCalls += 1;
    if (providerCalls === 1) {
      throw new ProviderError("AI 服务当前繁忙，请稍后重试", 429, "stub", "rate_limited");
    }
    return { images: ["unexpected-local-retry"], model: "stub-model" };
  },
  async edit() { throw new Error("unexpected edit"); },
};

await assert.rejects(
  () => generateExactImages(retryableProvider, { prompt: "重试归队列" }, 1),
  (error: unknown) => error instanceof ProviderError && error.status === 429,
);
assert.equal(providerCalls, 1, "Provider/精确批量层不得自行重放付费请求");

let fetchCalls = 0;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  return new Response(JSON.stringify({ error: { message: "temporary channel capacity unavailable" } }), {
    status: 503,
  });
}) as typeof fetch;
try {
  await assert.rejects(
    () => fetchWithRetry("https://gateway.example/v1/images/generations", () => ({}), {
      providerId: "stub", maxRetries: 99,
    }),
    (error: unknown) => error instanceof ProviderError && error.category === "gateway_unavailable",
  );
  assert.equal(fetchCalls, 1);
} finally {
  globalThis.fetch = originalFetch;
}

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new TypeError("connection reset after upload");
}) as typeof fetch;
try {
  await assert.rejects(
    () => fetchWithRetry("https://gateway.example/v1/images/edits", () => ({}), { providerId: "stub" }),
    (error: unknown) => error instanceof ProviderError && error.category === "outcome_unknown",
  );
  assert.equal(networkCalls, 1);
} finally {
  globalThis.fetch = originalFetch;
}

const deterministic503 = providerErrorFromResponse(
  503,
  JSON.stringify({ error: { message: "resolution=4k is unsupported; resolution must be 1k or 2k" } }),
  "grok-imagine-image",
);
assert.equal(deterministic503.category, "invalid_request");

const diagnostic = sanitizedProviderDiagnostic(new ProviderError(
  "失败",
  400,
  "stub",
  "invalid_request",
  'HTTP 400: {"error":{"message":"key sk-secret at https://signed.example/x?token=abc data:image/png;base64,AAAA","type":"invalid_request_error"}}',
));
assert.ok(diagnostic?.includes("[redacted-key]"));
assert.ok(diagnostic?.includes("[redacted-url]"));
assert.ok(diagnostic?.includes("[redacted-image]"));
assert.ok(!diagnostic?.includes("sk-secret"));
assert.ok(!diagnostic?.includes("signed.example"));

console.log("  ✓ Provider 单次发送、未知结果保护与诊断脱敏");
