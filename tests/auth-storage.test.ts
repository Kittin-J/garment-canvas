import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-auth-"));
process.env.DATA_DIR = temp;
process.env.INITIAL_ADMIN_ACCOUNT_ID = "test-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

const { db, closeDatabaseForTests } = await import("../server/lib/database");
const { authenticatedUser, createSession, SESSION_COOKIE } = await import("../server/lib/auth");
const { verifyPassword } = await import("../server/lib/password");
const {
  completeGenerationRecord, createGenerationRecord, failGenerationRecord, registerGeneratedFiles,
} = await import("../server/lib/generationRecords");

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("用户、会话与消耗存储回归测试");
const database = db();
const admin = database.prepare("SELECT * FROM users WHERE account_id = 'test-admin'").get() as Record<string, unknown>;

test("首次启动从私密环境创建管理员且强制改密", () => {
  assert.equal(admin.role, "admin");
  assert.equal(admin.must_change_password, 1);
  assert.equal(verifyPassword("Initial1234", String(admin.password_hash)), true);
  assert.equal(String(admin.password_hash).includes("Initial1234"), false);
});

test("单账号新登录会使旧设备会话失效", () => {
  const first = createSession(String(admin.id));
  const firstRequest = { headers: { cookie: `${SESSION_COOKIE}=${first.token}` } } as Request;
  assert.equal(authenticatedUser(firstRequest)?.id, admin.id);
  const second = createSession(String(admin.id));
  const secondRequest = { headers: { cookie: `${SESSION_COOKIE}=${second.token}` } } as Request;
  assert.equal(authenticatedUser(firstRequest), undefined);
  assert.equal(authenticatedUser(secondRequest)?.id, admin.id);
  const count = database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ?").get(admin.id) as { count: number };
  assert.equal(count.count, 1);
});

test("成功图片写消耗流水，失败任务不写消耗", () => {
  createGenerationRecord("run-success", {
    userId: String(admin.id), nodeId: "node", nodeLabel: "AI 改款", kind: "ai-modify", requestedCount: 2,
  }, 1000);
  completeGenerationRecord({
    runId: "run-success", images: ["/api/files/a.png"], model: "stub", providerRequests: 3,
    startedAt: 1000, finishedAt: 2000,
  });
  createGenerationRecord("run-failure", {
    userId: String(admin.id), nodeId: "node", nodeLabel: "AI 改款", kind: "ai-modify", requestedCount: 1,
  }, 3000);
  failGenerationRecord("run-failure", "timeout", 4000);
  const rows = database.prepare("SELECT run_id, successful_count, provider_requests FROM usage_events ORDER BY run_id").all() as Array<Record<string, unknown>>;
  assert.deepEqual(rows, [{ run_id: "run-success", successful_count: 1, provider_requests: 3 }]);
});

test("执行计划中的中间生成图片也登记用户和节点归属", () => {
  const context = {
    userId: String(admin.id), projectId: "project-1", nodeId: "target", nodeLabel: "结果", kind: "result", requestedCount: 1,
  };
  registerGeneratedFiles(context, "run-success", "upstream-ai", ["/api/files/intermediate.png"], 5000);
  const file = database.prepare("SELECT owner_id, project_id, node_id, run_id FROM files WHERE id = ?")
    .get("intermediate.png") as Record<string, unknown>;
  assert.deepEqual(file, {
    owner_id: admin.id,
    project_id: "project-1",
    node_id: "upstream-ai",
    run_id: "run-success",
  });
});

console.log(`\n通过 ${passed} 项`);
closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
