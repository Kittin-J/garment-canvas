import assert from "node:assert/strict";
import { ProviderError, sanitizedProviderDiagnostic } from "../server/providers/base";
import { generateExactImages } from "../server/providers/exact";
import type { AIProvider } from "../src/types/workflow";

let calls = 0;
const transientProvider: AIProvider = {
  id: "stub",
  async generate() {
    calls += 1;
    if (calls === 1) {
      throw new ProviderError(
        "当前 AI 模型不可用，请联系管理员检查模型配置",
        404,
        "stub",
        "model_unavailable",
        'HTTP 404: {"error":{"message":"model temporarily not available"}}',
      );
    }
    return { images: ["recovered"], model: "stub-model" };
  },
  async edit() { throw new Error("unexpected edit"); },
};

const recovered = await generateExactImages(
  transientProvider,
  { prompt: "重试" },
  1,
  { runId: "run-test", transientRetryDelaysMs: [0, 0] },
);
assert.equal(calls, 2);
assert.deepEqual(recovered.images, ["recovered"]);
assert.deepEqual(recovered.failures, []);

let permanentCalls = 0;
const permanentProvider: AIProvider = {
  id: "stub",
  async generate() {
    permanentCalls += 1;
    throw new ProviderError("参数错误", 400, "stub", "invalid_request", "HTTP 400: bad size");
  },
  async edit() { throw new Error("unexpected edit"); },
};
await assert.rejects(
  generateExactImages(permanentProvider, { prompt: "错误参数" }, 1, { transientRetryDelaysMs: [0, 0] }),
  /参数错误/,
);
assert.equal(permanentCalls, 1);

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

console.log("  ✓ provider transient retry and diagnostic redaction");
