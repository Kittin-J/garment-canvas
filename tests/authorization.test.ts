import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express, { type Request } from "express";
import type { AddressInfo } from "node:net";
import type { AuthenticatedRequest, AuthUser } from "../server/lib/auth";
import { resetPostgresTestDatabase } from "./postgresTestDatabase";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "garment-canvas-authorization-"));
process.env.DATA_DIR = temp;
process.env.SQLITE_IMPORT_FILE = "missing.db";
process.env.INITIAL_ADMIN_ACCOUNT_ID = "authorization-admin";
process.env.INITIAL_ADMIN_PASSWORD = "Initial1234";

await resetPostgresTestDatabase();
const { closeDatabaseForTests, initializeDatabase, query, queryOne } = await import("../server/lib/database");
const { createRun } = await import("../server/engine/runner");
const { buildExecutionPlan } = await import("../server/engine/dag");
const { runPlanRouter } = await import("../server/routes/runPlan");
const { assetsRouter } = await import("../server/routes/assets");
const { filesRouter } = await import("../server/routes/files");
const { projectsRouter } = await import("../server/routes/projects");
const { usageRouter } = await import("../server/routes/usage");
const { historyRouter } = await import("../server/routes/history");

const users: Record<string, AuthUser> = {
  owner: {
    id: "user-owner",
    accountId: "owner",
    displayName: "Owner",
    role: "user",
    mustChangePassword: false,
  },
  other: {
    id: "user-other",
    accountId: "other",
    displayName: "Other",
    role: "user",
    mustChangePassword: false,
  },
  admin: {
    id: "user-admin",
    accountId: "admin",
    displayName: "Admin",
    role: "admin",
    mustChangePassword: false,
  },
};

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function flow(images: string[] = []) {
  return {
    schemaVersion: 1,
    nodes: images.map((imageUrl, index) => ({
      id: `image_${index}`,
      type: "image-input",
      position: { x: index * 100, y: 0 },
      data: {
        kind: "image-input",
        label: `图片 ${index + 1}`,
        status: "idle",
        imageRole: "default",
        imageUrl,
      },
    })),
    edges: [],
  };
}

await initializeDatabase();
const now = new Date().toISOString();
for (const user of Object.values(users)) {
  await query(`
    INSERT INTO users (id, account_id, display_name, role, password_hash, active, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'test-only', 1, $5, $5)
  `, [user.id, user.accountId, user.displayName, user.role, now]);
}

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const user = users[String(req.headers["x-test-user"] ?? "")];
  if (!user) {
    res.status(401).json({ error: "test user required" });
    return;
  }
  (req as AuthenticatedRequest).authUser = user;
  next();
});
app.use("/run-plan", runPlanRouter);
app.use("/assets", assetsRouter);
app.use("/files", filesRouter);
app.use("/projects", projectsRouter);
app.use("/usage", usageRouter);
app.use("/history", historyRouter);

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});
const address = server.address() as AddressInfo;
const baseUrl = `http://127.0.0.1:${address.port}`;

function request(pathname: string, user: keyof typeof users, init: RequestInit = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-test-user": user,
      ...init.headers,
    },
  });
}

console.log("运行任务与素材引用授权回归测试");

await test("Run 状态与 SSE 仅任务所有者可读，管理员也不隐式越权", async () => {
  const plan = buildExecutionPlan([{
    id: "result",
    type: "result",
    data: { kind: "result", label: "结果", status: "idle", images: [] },
  }], []);
  const run = await createRun(plan, users.owner.id);

  assert.equal((await request(`/run-plan/${run.id}`, "owner")).status, 200);
  assert.equal((await request(`/run-plan/${run.id}`, "other")).status, 404);
  assert.equal((await request(`/run-plan/${run.id}`, "admin")).status, 404);
  assert.equal((await request(`/run-plan/${run.id}/events`, "other")).status, 404);
});

await test("所有鉴权图片禁止缓存，撤回共享后立即恢复访问控制", async () => {
  const upload = await request("/files", "owner", {
    method: "POST",
    body: JSON.stringify({
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    }),
  });
  const uploaded = await upload.json() as { id: string; url: string; error?: string };
  assert.equal(upload.status, 200, uploaded.error);

  const hijack = await request("/assets", "other", {
    method: "POST",
    body: JSON.stringify({
      name: "越权共享", category: "reference", scope: "shared", image: uploaded.url,
    }),
  });
  assert.equal(hijack.status, 404);

  for (const pathname of [`/files/${uploaded.id}`, `/files/${uploaded.id}/thumbnail`]) {
    const privateResponse = await request(pathname, "owner");
    assert.equal(privateResponse.status, 200);
    assert.equal(privateResponse.headers.get("cache-control"), "private, no-store");
    assert.match(privateResponse.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
    await privateResponse.arrayBuffer();

    assert.equal((await request(pathname, "other")).status, 403);
  }

  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES ('uploaded-shared-asset', $1, 'shared', '可共享图片', 'reference', $2, $3)
  `, [users.owner.id, uploaded.url, now]);

  for (const pathname of [`/files/${uploaded.id}`, `/files/${uploaded.id}/thumbnail`]) {
    const sharedResponse = await request(pathname, "other");
    assert.equal(sharedResponse.status, 200);
    assert.equal(sharedResponse.headers.get("cache-control"), "private, no-store");
    assert.match(sharedResponse.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
    await sharedResponse.arrayBuffer();
  }

  const revoke = await request("/assets/uploaded-shared-asset", "owner", {
    method: "PATCH",
    body: JSON.stringify({ scope: "private" }),
  });
  assert.equal(revoke.status, 200, await revoke.text());

  for (const pathname of [`/files/${uploaded.id}`, `/files/${uploaded.id}/thumbnail`]) {
    const denied = await request(pathname, "other");
    assert.equal(denied.status, 403);
    await denied.arrayBuffer();

    const ownerResponse = await request(pathname, "owner");
    assert.equal(ownerResponse.status, 200);
    assert.equal(ownerResponse.headers.get("cache-control"), "private, no-store");
    assert.match(ownerResponse.headers.get("vary") ?? "", /(?:^|,\s*)Cookie(?:,|$)/i);
    await ownerResponse.arrayBuffer();
  }
});

await test("管理员创建通用素材时解除底层文件的个人归属", async () => {
  const upload = await request("/files", "admin", {
    method: "POST",
    body: JSON.stringify({
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    }),
  });
  const uploaded = await upload.json() as { id: string; url: string; error?: string };
  assert.equal(upload.status, 200, uploaded.error);

  const create = await request("/assets", "admin", {
    method: "POST",
    body: JSON.stringify({
      name: "通用素材", category: "reference", scope: "global", image: uploaded.url,
    }),
  });
  assert.equal(create.status, 201, await create.text());
  assert.deepEqual(
    await queryOne<{ owner_id: string | null; deleted_at: string | null; purge_after: string | null }>(
      "SELECT owner_id, deleted_at, purge_after FROM files WHERE id = $1",
      [uploaded.id],
    ),
    { owner_id: null, deleted_at: null, purge_after: null },
  );
});

await query(`
  INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
  VALUES
    ('shared-asset', $1, 'shared', '共享素材', 'reference', '/api/files/shared.png', $3),
    ('other-private', $2, 'private', '他人私有素材', 'reference', '/api/files/private.png', $3)
`, [users.owner.id, users.other.id, now]);
await query(`
  INSERT INTO projects (id, owner_id, name, flow_json, updated_at, created_at)
  VALUES ('owner-project', $1, 'Owner Project', $2, $3, $3)
`, [users.owner.id, JSON.stringify(flow()), now]);

await test("素材引用接口拒绝跨用户与管理员写入他人项目", async () => {
  for (const actor of ["other", "admin"] as const) {
    const response = await request("/assets/shared-asset/references", actor, {
      method: "POST",
      body: JSON.stringify({ projectId: "owner-project" }),
    });
    assert.equal(response.status, 404);
  }
  const missing = await request("/assets/shared-asset/references", "owner", {
    method: "POST",
    body: JSON.stringify({ projectId: "unsaved-project" }),
  });
  assert.equal(missing.status, 404);
  const count = await queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM project_asset_refs WHERE project_id = 'owner-project'",
  );
  assert.equal(count?.count, 0);
});

await test("普通用户的回收站只显示自己删除的素材", async () => {
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at, deleted_at, purge_after)
    VALUES ('other-deleted-shared', $1, 'shared', '他人已删共享素材', 'reference',
      '/api/files/deleted-shared.png', $2, $2, $3)
  `, [users.other.id, now, new Date(Date.now() + 86_400_000).toISOString()]);
  const response = await request("/assets?deleted=true", "owner");
  assert.equal(response.status, 200);
  const rows = await response.json() as Array<{ id: string }>;
  assert.equal(rows.some((row) => row.id === "other-deleted-shared"), false);
});

await test("素材名称搜索按字面子串匹配，且不绕过 scope 权限过滤", async () => {
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES
      ('search-own-print', $1, 'private', '花朵印花A', 'print', '/api/files/search-a.png', $3),
      ('search-other-private', $2, 'private', '花朵印花B', 'print', '/api/files/search-b.png', $3)
  `, [users.owner.id, users.other.id, now]);
  const response = await request("/assets?search=%E8%8A%B1%E6%9C%B5", "owner");
  assert.equal(response.status, 200);
  const ids = (await response.json() as Array<{ id: string }>).map((row) => row.id);
  assert.equal(ids.includes("search-own-print"), true);
  assert.equal(ids.includes("search-other-private"), false);
});

await test("素材名称搜索把 % 和 _ 当字面字符而非 LIKE 通配符", async () => {
  await query(`
    INSERT INTO assets (id, owner_id, scope, name, category, image, created_at)
    VALUES
      ('search-percent', $1, 'private', 'A%B', 'reference', '/api/files/search-p.png', $2),
      ('search-plain', $1, 'private', 'AB', 'reference', '/api/files/search-q.png', $2),
      ('search-underscore', $1, 'private', 'A_C', 'reference', '/api/files/search-u.png', $2),
      ('search-anychar', $1, 'private', 'AXC', 'reference', '/api/files/search-x.png', $2)
  `, [users.owner.id, now]);

  const percent = await request("/assets?search=A%25B", "owner");
  assert.equal(percent.status, 200);
  const percentIds = (await percent.json() as Array<{ id: string }>).map((row) => row.id);
  assert.equal(percentIds.includes("search-percent"), true);
  assert.equal(percentIds.includes("search-plain"), false);

  const underscore = await request("/assets?search=A_C", "owner");
  assert.equal(underscore.status, 200);
  const underscoreIds = (await underscore.json() as Array<{ id: string }>).map((row) => row.id);
  assert.equal(underscoreIds.includes("search-underscore"), true);
  assert.equal(underscoreIds.includes("search-anychar"), false);
});

await test("不存在或已删除的 projectId 不能污染运行历史元数据", async () => {
  const response = await request("/run-plan", "owner", {
    method: "POST",
    body: JSON.stringify({
      nodes: [{
        id: "result-only", type: "result", position: { x: 0, y: 0 },
        data: { kind: "result", label: "结果", status: "idle", images: [] },
      }],
      edges: [],
      projectId: "missing-project",
    }),
  });
  assert.equal(response.status, 404);
});

await test("项目保存按最终画布原子同步可访问素材引用", async () => {
  const save = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({
      id: "owner-project",
      name: "Owner Project",
      flow: flow(["/api/files/shared.png", "/api/files/private.png"]),
    }),
  });
  assert.equal(save.status, 200, await save.text());
  const refs = await query<{ asset_id: string }>(
    "SELECT asset_id FROM project_asset_refs WHERE project_id = $1 ORDER BY asset_id",
    ["owner-project"],
  );
  assert.deepEqual(refs, [{ asset_id: "shared-asset" }]);

  const clear = await request("/projects", "owner", {
    method: "POST",
    body: JSON.stringify({ id: "owner-project", name: "Owner Project", flow: flow() }),
  });
  assert.equal(clear.status, 200, await clear.text());
  const remaining = await queryOne<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM project_asset_refs WHERE project_id = $1",
    ["owner-project"],
  );
  assert.equal(remaining?.count, 0);
});

await test("素材删除与项目引用写入使用互斥行锁避免 TOCTOU", () => {
  const assetsSource = fs.readFileSync(new URL("../server/routes/assets.ts", import.meta.url), "utf8");
  const projectsSource = fs.readFileSync(new URL("../server/routes/projects.ts", import.meta.url), "utf8");
  assert.match(assetsSource, /SELECT owner_id, scope FROM assets[\s\S]*FOR UPDATE/);
  assert.match(projectsSource, /FROM assets[\s\S]*FOR KEY SHARE/);
});

await test("删除他人的历史记录统一返回 404，不泄露记录是否存在", async () => {
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
    ) VALUES ('history-other-run', $1, 'node', '节点', 'ai-modify', 1, 'error', 1, 2)
  `, [users.other.id]);
  await query(`
    INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
    VALUES ('history-other-output', 'history-other-run', '', 'error', '失败', 2)
  `);
  assert.equal((await request("/history/history-other-output", "owner", { method: "DELETE" })).status, 404);
  assert.equal((await request("/history/missing-output", "owner", { method: "DELETE" })).status, 404);
});

interface HistoryPage {
  records: Array<{ id: string; runId: string }>;
  nextCursor: string | null;
  hasMore: boolean;
}

await test("历史分页固定在首次快照，期间新增记录不会推移游标造成缺口", async () => {
  for (const [id, startedAt] of [["snapshot-3", 3_000], ["snapshot-2", 2_000], ["snapshot-1", 1_000]] as const) {
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
      ) VALUES ($1, $2, 'node', '节点', 'ai-modify', 1, 'error', $3, $3)
    `, [id, users.owner.id, startedAt]);
    await query(`
      INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
      VALUES ($1, $2, '', 'error', '失败', $3)
    `, [`${id}-output`, id, startedAt]);
  }
  const first = await request("/history?limit=1&before=2500", "owner");
  assert.equal(first.status, 200);
  const firstPage = await first.json() as HistoryPage;
  assert.equal(firstPage.records[0].runId, "snapshot-2");
  assert.equal(firstPage.hasMore, true);
  assert.ok(firstPage.nextCursor);
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
    ) VALUES ('snapshot-new', $1, 'node', '节点', 'ai-modify', 1, 'error', 4000, 4000)
  `, [users.owner.id]);
  await query(`
    INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
    VALUES ('snapshot-new-output', 'snapshot-new', '', 'error', '失败', 4000)
  `);
  const second = await request(
    `/history?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    "owner",
  );
  assert.equal(second.status, 200);
  assert.equal(((await second.json()) as HistoryPage).records[0].runId, "snapshot-1");
});

await test("运行任务完成并展开为多条输出时不会令下一页漏项或重复", async () => {
  for (const [id, startedAt, status] of [
    ["cursor-running", 7_000, "running"],
    ["cursor-second", 6_000, "error"],
    ["cursor-third", 5_000, "error"],
  ] as const) {
    await query(`
      INSERT INTO generation_runs (
        id, owner_id, node_id, node_label, kind, requested_count, status, started_at, finished_at
      ) VALUES ($1, $2, 'node', '节点', 'ai-modify', 2, $3, $4, $4)
    `, [id, users.owner.id, status, startedAt]);
    if (status === "error") {
      await query(`
        INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
        VALUES ($1, $2, '', 'error', '失败', $3)
      `, [`${id}-output`, id, startedAt]);
    }
  }

  const first = await request("/history?limit=2&before=7500", "owner");
  assert.equal(first.status, 200);
  const firstPage = await first.json() as HistoryPage;
  assert.deepEqual(firstPage.records.map((record) => record.runId), ["cursor-running", "cursor-second"]);
  assert.ok(firstPage.nextCursor);

  await query(`
    INSERT INTO generation_outputs (id, run_id, image, status, created_at) VALUES
      ('cursor-running-output-1', 'cursor-running', '/api/files/cursor-1.png', 'success', 7100),
      ('cursor-running-output-2', 'cursor-running', '/api/files/cursor-2.png', 'success', 7101)
  `);
  await query(
    "UPDATE generation_runs SET status = 'success', successful_count = 2, finished_at = 7101 WHERE id = 'cursor-running'",
  );

  const second = await request(
    `/history?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`,
    "owner",
  );
  assert.equal(second.status, 200);
  const secondPage = await second.json() as HistoryPage;
  assert.equal(secondPage.records[0].runId, "cursor-third");
  assert.equal(secondPage.records.some((record) => record.runId === "cursor-running"), false);
  assert.equal(secondPage.records.some((record) => record.runId === "cursor-second"), false);
});

await query("UPDATE users SET display_name = $1 WHERE id = $2", [
  "  =HYPERLINK(\"https://example.invalid\",\"打开\")",
  users.owner.id,
]);
await query(`
  INSERT INTO generation_runs (
    id, owner_id, project_id, node_id, node_label, kind, model,
    requested_count, successful_count, provider_requests, status, started_at, finished_at
  ) VALUES
    ('usage-owner-run', $1, '+PROJECT', '@NODE', '测试节点', 'ai-modify', '-MODEL', 1, 1, 1, 'success', 1, 2),
    ('usage-other-run', $2, 'other-project', 'other-node', '其他节点', 'ai-modify', 'safe-model', 1, 1, 1, 'success', 1, 2)
`, [users.owner.id, users.other.id]);
await query(`
  INSERT INTO usage_events (
    id, owner_id, run_id, project_id, node_id, model,
    successful_count, provider_requests, duration_ms, created_at
  ) VALUES
    ('usage-owner', $1, 'usage-owner-run', '+PROJECT', '@NODE', '-MODEL', 1, 1, 1, $3),
    ('usage-other', $2, 'usage-other-run', 'other-project', 'other-node', 'safe-model', 1, 1, 1, $3)
`, [users.owner.id, users.other.id, now]);

await test("消耗记录按用户隔离，管理员可查看全部且响应禁止缓存", async () => {
  const forbidden = await request(`/usage?userId=${users.other.id}`, "owner");
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get("cache-control"), "no-store");

  const ownerResponse = await request("/usage?all=true", "owner");
  assert.equal(ownerResponse.status, 200);
  assert.equal(ownerResponse.headers.get("cache-control"), "no-store");
  const ownerRows = await ownerResponse.json() as Array<{ id: string }>;
  assert.deepEqual(ownerRows.map((row) => row.id), ["usage-owner"]);

  const adminResponse = await request("/usage?all=true", "admin");
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(
    (await adminResponse.json() as Array<{ id: string }>).map((row) => row.id).sort(),
    ["usage-other", "usage-owner"],
  );
});

await test("CSV 导出阻断公式注入并设置安全下载响应头", async () => {
  const response = await request("/usage?all=true&format=csv", "admin");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type") ?? "", /^text\/csv;\s*charset=utf-8/i);
  assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="usage-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");

  const csvBytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...csvBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = csvBytes.subarray(3).toString("utf8");
  assert.ok(csv.startsWith("记录ID,"));
  assert.match(csv, /"'  =HYPERLINK\(""https:\/\/example\.invalid"",""打开""\)"/);
  assert.match(csv, /,'\+PROJECT,'@NODE,'-MODEL,1,1,1,/);
  assert.match(csv, /\r\n/);
});

console.log(`\n通过 ${passed} 项`);
await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
await closeDatabaseForTests();
fs.rmSync(temp, { recursive: true, force: true });
