import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";
import express from "express";
import type { AddressInfo } from "node:net";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-auth-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "test-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, initializeDatabase, query, queryOne } = await import("../server/lib/database");
const { authenticateRequest, authenticatedUser, createSession, SESSION_COOKIE } = await import("../server/lib/auth");
const { authRouter } = await import("../server/routes/auth");
const { verifyPassword } = await import("../server/lib/password");
const {
  completeGenerationRecord, createGenerationRecord, failGenerationRecord, registerGeneratedFiles,
} = await import("../server/lib/generationRecords");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("用户、会话与 PostgreSQL 消耗存储回归测试");
await initializeDatabase();
const admin = await queryOne<Record<string, unknown>>("SELECT * FROM users WHERE account_id = $1", ["test-admin"]);
assert.ok(admin);
let replacedToken = "";
let activeToken = "";

await test("首次启动从私密环境创建管理员且强制改密", () => {
  assert.equal(admin.role, "admin");
  assert.equal(admin.must_change_password, 1);
  assert.equal(verifyPassword("Initial1234", String(admin.password_hash)), true);
  assert.equal(String(admin.password_hash).includes("Initial1234"), false);
});

await test("单账号新登录会使旧设备会话失效", async () => {
  const first = await createSession(String(admin.id));
  replacedToken = first.token;
  const firstRequest = { headers: { cookie: `${SESSION_COOKIE}=${first.token}` } } as Request;
  assert.equal((await authenticatedUser(firstRequest))?.id, admin.id);
  const second = await createSession(String(admin.id));
  activeToken = second.token;
  const secondRequest = { headers: { cookie: `${SESSION_COOKIE}=${second.token}` } } as Request;
  assert.equal(await authenticatedUser(firstRequest), undefined);
  assert.equal((await authenticateRequest(firstRequest)).status, "replaced");
  assert.equal((await authenticatedUser(secondRequest))?.id, admin.id);
  const count = await queryOne<{ count: number }>("SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = $1", [admin.id]);
  assert.equal(count?.count, 1);
});

await test("认证 401 不清 Cookie，旧设备仍收到明确替换原因且显式退出会清理", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${address.port}/api/auth/me`;
    const protectedEndpoint = `http://127.0.0.1:${address.port}/api/auth/users`;
    const protectedResponse = await fetch(protectedEndpoint, {
      headers: { cookie: `${SESSION_COOKIE}=${replacedToken}` },
    });
    assert.equal(protectedResponse.status, 401);
    assert.equal(protectedResponse.headers.get("set-cookie"), null);

    const replaced = await fetch(endpoint, { headers: { cookie: `${SESSION_COOKIE}=${replacedToken}` } });
    assert.equal(replaced.status, 401);
    assert.equal(replaced.headers.get("cache-control"), "no-store");
    assert.equal(replaced.headers.get("set-cookie"), null);
    assert.deepEqual(await replaced.json(), {
      error: "账号已在其他设备登录",
      code: "SESSION_REPLACED",
    });

    const active = await fetch(endpoint, { headers: { cookie: `${SESSION_COOKIE}=${activeToken}` } });
    assert.equal(active.status, 200);
    assert.equal(active.headers.get("cache-control"), "no-store");
    assert.equal(((await active.json()) as { user: { id: string } }).user.id, admin.id);

    const anonymous = await fetch(endpoint);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    assert.equal(anonymous.headers.get("set-cookie"), null);
    assert.equal(((await anonymous.json()) as { code: string }).code, "UNAUTHENTICATED");

    const logout = await fetch(endpoint.replace(/\/me$/, "/logout"), {
      method: "POST",
      headers: { cookie: `${SESSION_COOKIE}=${activeToken}` },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie") ?? "", /^gc_session=;/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

await test("同一账号并发登录均正常响应且最终仅保留一个有效设备", async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/auth", authRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}/api/auth`;
    const login = () => fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "test-admin", password: "Initial1234" }),
    });
    const responses = await Promise.all([login(), login()]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const cookies = responses.map((response) => response.headers.get("set-cookie")?.split(";")[0] ?? "");
    assert.ok(cookies.every(Boolean));
    const meResponses = await Promise.all(cookies.map((cookie) => fetch(`${base}/me`, { headers: { cookie } })));
    assert.deepEqual(meResponses.map((response) => response.status).sort(), [200, 401]);
    const count = await queryOne<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM sessions WHERE user_id = $1",
      [admin.id],
    );
    assert.equal(count?.count, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

await test("成功图片写消耗流水，失败任务不写消耗", async () => {
  await createGenerationRecord("run-success", {
    userId: String(admin.id), nodeId: "node", nodeLabel: "AI 改款", kind: "ai-modify", requestedCount: 2,
  }, 1000);
  await completeGenerationRecord({
    runId: "run-success", images: ["/api/files/a.png"], model: "stub", providerRequests: 3,
    startedAt: 1000, finishedAt: 2000,
  });
  await createGenerationRecord("run-failure", {
    userId: String(admin.id), nodeId: "node", nodeLabel: "AI 改款", kind: "ai-modify", requestedCount: 1,
  }, 3000);
  await failGenerationRecord("run-failure", "timeout", 4000);
  const rows = await query<Record<string, unknown>>(
    "SELECT run_id, successful_count, provider_requests FROM usage_events ORDER BY run_id",
  );
  assert.deepEqual(rows, [{ run_id: "run-success", successful_count: 1, provider_requests: 3 }]);
});

await test("执行计划中的中间生成图片也登记用户和节点归属", async () => {
  const context = {
    userId: String(admin.id), projectId: "project-1", nodeId: "target", nodeLabel: "结果", kind: "result", requestedCount: 1,
  };
  await registerGeneratedFiles(context, "run-success", "upstream-ai", ["/api/files/intermediate.png"], 5000);
  const file = await queryOne<Record<string, unknown>>(
    "SELECT owner_id, project_id, node_id, run_id FROM files WHERE id = $1",
    ["intermediate.png"],
  );
  assert.deepEqual(file, {
    owner_id: admin.id,
    project_id: "project-1",
    node_id: "upstream-ai",
    run_id: "run-success",
  });
});

console.log(`\n通过 ${passed} 项`);
await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
