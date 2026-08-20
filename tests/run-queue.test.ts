import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { ProviderError } from "../server/providers/base";
import type { AuthenticatedRequest } from "../server/lib/auth";
import type { GenerationRecordContext } from "../server/lib/generationRecords";
import type { ProviderResolver } from "../server/engine/runner";
import type { AIProvider, ExecutionPlan, ImageGenRequest, ImageGenResult, NodeExecution } from "../src/types/workflow";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-run-queue-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "queue-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const database = await import("../server/lib/database");
const queue = await import("../server/engine/runQueue");
const { generateRouter } = await import("../server/routes/generate");
const { streamDurableRunEvents } = await import("../server/routes/runPlan");
await database.initializeDatabase();

const owner = await database.queryOne<{ id: string }>("SELECT id FROM users WHERE account_id = 'queue-admin'");
assert.ok(owner);

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
let sequence = 0;
let clock = Date.now() + 10_000;
let passed = 0;

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function tick(amount = 1_000): number {
  clock = Math.max(clock + amount, Date.now() + 1_000);
  return clock;
}

function step(nodeId: string, upstream?: NodeExecution["upstream"]): NodeExecution {
  return {
    nodeId,
    kind: "print-extract",
    inputImages: upstream ? [] : [PNG_DATA_URL],
    upstream,
    params: {
      prompt: "提取印花",
      modelId: "gpt-image-2-vip",
      modelOptions: { size: "1280x1280" },
    },
  };
}

function context(nodeId: string): GenerationRecordContext {
  return {
    userId: owner.id,
    nodeId,
    nodeLabel: nodeId,
    kind: "print-extract",
    prompt: "提取印花",
    requestedCount: 1,
  };
}

async function enqueueSingle(prefix: string): Promise<string> {
  sequence += 1;
  const nodeId = `${prefix}-${sequence}`;
  const run = await queue.enqueueGenerationRun({ steps: [step(nodeId)] }, owner.id, context(nodeId));
  return run.id;
}

function resolver(
  behavior: (request: ImageGenRequest, call: number) => ImageGenResult | Promise<ImageGenResult>,
): { resolveProvider: ProviderResolver; calls: () => number } {
  let calls = 0;
  const invoke = async (request: ImageGenRequest) => {
    calls += 1;
    return behavior(request, calls);
  };
  const provider: AIProvider = {
    id: "gpt-image-2-vip",
    async generate(request) { return invoke(request); },
    async edit(request) { return invoke(request); },
  };
  return { resolveProvider: () => provider, calls: () => calls };
}

async function runRow(runId: string) {
  return database.queryOne<{
    status: string; error: string | null; provider_requests: number; successful_count: number;
  }>(
    "SELECT status, error, provider_requests, successful_count FROM generation_runs WHERE id = $1",
    [runId],
  );
}

console.log("PostgreSQL 持久生成队列测试");

await test("入队立即返回且数据库重连后 queued 任务仍可执行并重放事件", async () => {
  const fake = resolver(() => ({
    images: [PNG_DATA_URL], model: "gpt-image-2-vip", providerOutputSizes: ["2048x2048"],
  }));
  const runId = await enqueueSingle("restart");
  assert.equal(fake.calls(), 0, "入队阶段不得调用上游");
  assert.equal((await runRow(runId))?.status, "queued");

  await database.closeDatabaseForTests();
  await database.initializeDatabase();
  const now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-restart", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), true);
  assert.equal(fake.calls(), 1);
  assert.deepEqual(await runRow(runId), {
    status: "succeeded", error: null, provider_requests: 1, successful_count: 1,
  });
  const output = await database.queryOne<{ image: string; provider_output_size: string | null }>(
    "SELECT image, provider_output_size FROM generation_outputs WHERE run_id = $1 AND status = 'success'", [runId],
  );
  assert.match(output?.image ?? "", /^\/api\/files\//);
  assert.equal(output?.provider_output_size, "2048x2048");

  const allEvents = await queue.readDurableRunEvents(runId, owner.id, 0);
  assert.ok(allEvents && allEvents.length >= 4);
  assert.deepEqual(allEvents.map((event) => event.seq), allEvents.map((_event, index) => index + 1));
  const cursor = allEvents[1].seq ?? 0;
  const replay = await queue.readDurableRunEvents(runId, owner.id, cursor);
  assert.deepEqual(replay?.map((event) => event.seq), allEvents.slice(2).map((event) => event.seq));
});

await test("明确 429 最多自动重放两次并保留三次真实请求计数", async () => {
  const fake = resolver(() => {
    throw new ProviderError("AI 服务当前繁忙，请稍后重试", 429, "stub", "rate_limited");
  });
  const runId = await enqueueSingle("rate-limit");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = tick();
    assert.equal(await queue.processNextGenerationJob("worker-429", {
      resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
    }), true);
  }
  assert.equal(fake.calls(), 3);
  assert.deepEqual(await runRow(runId), {
    status: "failed", error: "AI 服务当前繁忙，请稍后重试", provider_requests: 3, successful_count: 0,
  });
  const job = await database.queryOne<{ retry_count: number; status: string }>(
    "SELECT retry_count, status FROM generation_jobs WHERE run_id = $1", [runId],
  );
  assert.deepEqual(job, { retry_count: 2, status: "failed" });
  const now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-429", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), false);
});

await test("确认临时的 503 最多重放两次，第三次成功后请求数仍准确", async () => {
  const fake = resolver((_request, call) => {
    if (call <= 2) {
      throw new ProviderError("AI 服务暂时不可用，请稍后重试", 503, "stub", "gateway_unavailable");
    }
    return { images: [PNG_DATA_URL], model: "gpt-image-2-vip" };
  });
  const runId = await enqueueSingle("temporary-503");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = tick();
    assert.equal(await queue.processNextGenerationJob("worker-503", {
      resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
    }), true);
  }
  assert.equal(fake.calls(), 3);
  assert.deepEqual(await runRow(runId), {
    status: "succeeded", error: null, provider_requests: 3, successful_count: 1,
  });
});

await test("超时或连接不确定结果进入 outcome_unknown 且绝不重放", async () => {
  const fake = resolver(() => {
    throw new ProviderError(
      "AI 请求已超时，结果可能已经生成；为避免重复计费，系统不会自动重试",
      504,
      "stub",
      "outcome_unknown",
    );
  });
  const runId = await enqueueSingle("unknown");
  let now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-unknown", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), true);
  assert.equal(fake.calls(), 1);
  assert.equal((await runRow(runId))?.status, "outcome_unknown");
  assert.equal((await runRow(runId))?.provider_requests, 1);
  now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-unknown", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), false);
  assert.equal(fake.calls(), 1);
});

await test("invalid_response 是确定失败且不会进入自动重试", async () => {
  const fake = resolver(() => {
    throw new ProviderError("AI 服务返回了损坏的图片数据", 502, "stub", "invalid_response");
  });
  const runId = await enqueueSingle("invalid-response");
  let now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-invalid-response", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), true);
  assert.equal(fake.calls(), 1);
  assert.equal((await runRow(runId))?.status, "failed");
  const job = await database.queryOne<{ retry_count: number; status: string }>(
    "SELECT retry_count, status FROM generation_jobs WHERE run_id = $1", [runId],
  );
  assert.deepEqual(job, { retry_count: 0, status: "failed" });
  now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-invalid-response", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, retryDelaysMs: [0, 0],
  }), false);
  assert.equal(fake.calls(), 1);
});

await test("租约在上游调用前过期可安全重排，调用开始后过期则结果未知", async () => {
  const safeRunId = await enqueueSingle("lease-safe");
  const expiredAt = tick();
  await database.query(`
    UPDATE generation_jobs SET status = 'running', worker_id = 'dead-worker', lease_expires_at = $1,
      attempt_started_at = NULL WHERE run_id = $2
  `, [expiredAt - 1, safeRunId]);
  await database.query("UPDATE generation_run_steps SET status = 'running' WHERE run_id = $1", [safeRunId]);
  await database.query("UPDATE generation_runs SET status = 'running' WHERE id = $1", [safeRunId]);
  assert.equal(await queue.recoverExpiredGenerationJobs(expiredAt), 1);
  assert.equal((await runRow(safeRunId))?.status, "queued");
  const safeFake = resolver(() => ({ images: [PNG_DATA_URL], model: "gpt-image-2-vip" }));
  const safeNow = tick();
  assert.equal(await queue.processNextGenerationJob("worker-recovered", {
    resolveProvider: safeFake.resolveProvider, now: () => safeNow, random: () => 0,
  }), true);
  assert.equal((await runRow(safeRunId))?.status, "succeeded");

  const unknownRunId = await enqueueSingle("lease-unknown");
  const unknownExpiry = tick();
  await database.query(`
    UPDATE generation_jobs SET status = 'running', worker_id = 'dead-worker', lease_expires_at = $1,
      attempt_started_at = $2 WHERE run_id = $3
  `, [unknownExpiry - 1, unknownExpiry - 100, unknownRunId]);
  await database.query(`
    UPDATE generation_run_steps SET status = 'running', provider_requests = 1 WHERE run_id = $1
  `, [unknownRunId]);
  await database.query("UPDATE generation_runs SET status = 'running' WHERE id = $1", [unknownRunId]);
  assert.equal(await queue.recoverExpiredGenerationJobs(unknownExpiry), 1);
  assert.equal((await runRow(unknownRunId))?.status, "outcome_unknown");
  assert.equal((await runRow(unknownRunId))?.provider_requests, 1);
});

await test("queued 任务可直接取消且不会调用上游", async () => {
  const fake = resolver(() => ({ images: [PNG_DATA_URL], model: "gpt-image-2-vip" }));
  const runId = await enqueueSingle("cancel-queued");
  assert.deepEqual(await queue.cancelDurableRun(runId, owner.id), { status: "cancelled", finished: true });
  const now = tick();
  assert.equal(await queue.processNextGenerationJob("worker-cancelled", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0,
  }), false);
  assert.equal(fake.calls(), 0);
  assert.equal((await runRow(runId))?.status, "cancelled");
});

await test("取消事务先等待 job 锁，再获取 run 锁，避免与 Worker 完成路径死锁", async () => {
  const runId = await enqueueSingle("cancel-lock-order");
  const blocker = await database.db().connect();
  let cancellation: ReturnType<typeof queue.cancelDurableRun> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SET LOCAL lock_timeout = '1s'");
    await blocker.query("SELECT id FROM generation_jobs WHERE run_id = $1 FOR UPDATE", [runId]);
    cancellation = queue.cancelDurableRun(runId, owner.id);
    await new Promise<void>((resolve) => setTimeout(resolve, 75));
    await blocker.query("SELECT id FROM generation_runs WHERE id = $1 FOR UPDATE", [runId]);
    await blocker.query("ROLLBACK");
    assert.deepEqual(await cancellation, { status: "cancelled", finished: true });
  } finally {
    await blocker.query("ROLLBACK").catch(() => undefined);
    blocker.release();
  }
});

await test("目标步骤调用开始后的取消请求保留真实成功结果并记录警告", async () => {
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const fake = resolver(async () => {
    started();
    await releasePromise;
    return { images: [PNG_DATA_URL], model: "gpt-image-2-vip" };
  });
  const runId = await enqueueSingle("cancel-running-target");
  const now = tick();
  const processing = queue.processNextGenerationJob("worker-running-target", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, heartbeatMs: 60_000,
  });
  await startedPromise;
  assert.deepEqual(await queue.cancelDurableRun(runId, owner.id), { status: "cancel_requested", finished: false });
  assert.deepEqual(await queue.cancelDurableRun(runId, owner.id), { status: "cancel_requested", finished: false });
  release();
  assert.equal(await processing, true);
  const row = await runRow(runId);
  assert.equal(row?.status, "succeeded");
  assert.match(row?.error ?? "", /未能中止已经开始的上游调用/);
  assert.equal(row?.provider_requests, 1);
  assert.equal(row?.successful_count, 1);
});

await test("取消早期运行步骤时，已取消的目标步骤决定整次运行终态", async () => {
  sequence += 1;
  const firstNode = `cancel-chain-first-${sequence}`;
  const targetNode = `cancel-chain-target-${sequence}`;
  const plan: ExecutionPlan = {
    steps: [step(firstNode), step(targetNode, [{ nodeId: firstNode, images: [] }])],
  };
  const run = await queue.enqueueGenerationRun(plan, owner.id, context(targetNode));
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const releasePromise = new Promise<void>((resolve) => { release = resolve; });
  const fake = resolver(async () => {
    started();
    await releasePromise;
    return { images: [PNG_DATA_URL], model: "gpt-image-2-vip" };
  });
  const now = tick();
  const processing = queue.processNextGenerationJob("worker-cancel-chain", {
    resolveProvider: fake.resolveProvider, now: () => now, random: () => 0, heartbeatMs: 60_000,
  });
  await startedPromise;
  assert.deepEqual(await queue.cancelDurableRun(run.id, owner.id), { status: "cancel_requested", finished: false });
  release();
  assert.equal(await processing, true);
  assert.equal(fake.calls(), 1);
  assert.deepEqual(await runRow(run.id), {
    status: "cancelled", error: "用户取消了后续步骤", provider_requests: 1, successful_count: 0,
  });
  const target = await database.queryOne<{ status: string }>(
    "SELECT status FROM generation_run_steps WHERE run_id = $1 AND node_id = $2", [run.id, targetNode],
  );
  assert.equal(target?.status, "cancelled");
  const events = await queue.readDurableRunEvents(run.id, owner.id, 0);
  assert.ok(events?.some((event) => event.type === "node-status" && event.nodeId === targetNode && event.status === "cancelled"));
});

await test("SSE 在观察到终态后再次 drain，发送同一提交中的最后事件", async () => {
  const request = new EventEmitter() as EventEmitter & Request;
  request.get = () => undefined;
  const writes: string[] = [];
  let ended = false;
  const response = {
    writeHead: () => response,
    write: (chunk: string) => { writes.push(chunk); return true; },
    end: () => { ended = true; return response; },
  } as unknown as Response;
  let reads = 0;
  await streamDurableRunEvents("race-run", owner.id, request, response, {
    readEvents: async (_runId, _ownerId, afterSeq) => {
      reads += 1;
      if (afterSeq === 0) {
        return [{ type: "node-status", nodeId: "race-node", status: "running", seq: 1 }];
      }
      if (afterSeq === 1) {
        return [
          {
            type: "node-status", nodeId: "race-node", status: "success",
            images: ["/api/files/race.png"], seq: 2,
          },
          { type: "done", seq: 3 },
        ];
      }
      return [];
    },
    getRun: async () => ({ id: "race-run", status: "succeeded", finished: true }),
    wait: async () => undefined,
  });
  const body = writes.join("");
  assert.equal(reads, 2);
  assert.match(body, /id: 2/);
  assert.match(body, /\"type\":\"done\"/);
  assert.equal(ended, true);
});

await test("直连蒙版任务把第一张参考图持久绑定为 maskSourceRef", async () => {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    (req as AuthenticatedRequest).authUser = {
      id: owner.id, accountId: "queue-admin", displayName: "Queue Admin",
      role: "admin", mustChangePassword: false,
    };
    next();
  });
  app.use("/api/generate", generateRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: "gpt-image-2",
        kind: "mask-redraw",
        nodeId: "direct-mask-test",
        request: {
          prompt: "只修改左侧衣袖",
          referenceImages: [PNG_DATA_URL],
          mask: PNG_DATA_URL,
          modelOptions: {},
        },
      }),
    });
    const body = await response.json() as { runId?: string; error?: string };
    assert.equal(response.status, 202, body.error);
    assert.ok(body.runId);
    const stored = await database.queryOne<{ step_json: string }>(
      "SELECT step_json FROM generation_run_steps WHERE run_id = $1", [body.runId],
    );
    assert.ok(stored);
    const queuedStep = JSON.parse(stored.step_json) as NodeExecution;
    assert.equal(queuedStep.kind, "mask-redraw");
    assert.deepEqual(queuedStep.inputImages, [PNG_DATA_URL]);
    assert.equal(queuedStep.params.maskSourceRef, PNG_DATA_URL);
    assert.deepEqual(await queue.cancelDurableRun(body.runId, owner.id), { status: "cancelled", finished: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

await database.closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
console.log(`\n通过 ${passed} 项`);
