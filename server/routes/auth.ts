import { Router } from "express";
import { nanoid } from "nanoid";
import {
  clearSessionCookie,
  createSession,
  requireAuth,
  requireAuthForSessionCheck,
  requireAdmin,
  requirePasswordChanged,
  requestUser,
  revokeRequestSession,
  revokeUserSessions,
  setSessionCookie,
} from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { db, query, queryOne, transaction } from "../lib/database";
import { hashPassword, validatePassword, verifyPassword } from "../lib/password";

export const authRouter = Router();

interface UserRow {
  id: string;
  account_id: string;
  display_name: string;
  role: "admin" | "user";
  must_change_password: number;
  active?: number;
  created_at?: string;
}

function publicUser(row: UserRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
    ...(row.active === undefined ? {} : { active: row.active === 1 }),
    ...(row.created_at ? { createdAt: row.created_at } : {}),
  };
}

authRouter.post("/login", asyncHandler(async (req, res) => {
  const { accountId, password } = req.body as { accountId?: string; password?: string };
  if (typeof accountId !== "string" || typeof password !== "string" || !accountId.trim() || !password) {
    res.status(400).json({ error: "账号和密码不能为空" });
    return;
  }
  const row = await queryOne<UserRow & { password_hash: string; active: number }>(`
    SELECT id, account_id, display_name, role, password_hash, must_change_password, active
    FROM users WHERE account_id = $1 AND deleted_at IS NULL
  `, [accountId.trim()]);
  if (!row || row.active !== 1 || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({ error: "账号或密码错误" });
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
  const { currentPassword, newPassword } = req.body as { currentPassword?: string; newPassword?: string };
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    res.status(400).json({ error: "当前密码和新密码不能为空" });
    return;
  }
  const invalid = validatePassword(newPassword);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const row = await queryOne<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({ error: "当前密码错误" });
    return;
  }
  const now = new Date().toISOString();
  await query("UPDATE users SET password_hash = $1, must_change_password = 0, updated_at = $2 WHERE id = $3", [
    hashPassword(newPassword), now, user.id,
  ]);
  const session = await createSession(user.id, { markExistingAsReplaced: false });
  setSessionCookie(res, session.token);
  res.json({ ok: true, user: { ...user, mustChangePassword: false }, expiresAt: session.expiresAt });
}));

authRouter.use(requirePasswordChanged);

authRouter.get("/users", requireAdmin, asyncHandler(async (_req, res) => {
  const rows = await query<UserRow>(`
    SELECT id, account_id, display_name, role, must_change_password, active, created_at
    FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC
  `);
  res.json(rows.map(publicUser));
}));

authRouter.post("/users", requireAdmin, asyncHandler(async (req, res) => {
  const { accountId, displayName, password, role } = req.body as {
    accountId?: string; displayName?: string; password?: string; role?: "admin" | "user";
  };
  if (typeof accountId !== "string" || !/^[A-Za-z0-9@._+-]{3,64}$/.test(accountId) ||
      typeof displayName !== "string" || !displayName.trim() || displayName.length > 100 ||
      typeof password !== "string") {
    res.status(400).json({ error: "账号、名称或密码格式无效" });
    return;
  }
  const invalid = validatePassword(password);
  if (invalid) {
    res.status(400).json({ error: invalid });
    return;
  }
  const now = new Date().toISOString();
  const id = nanoid(12);
  try {
    await query(`
      INSERT INTO users (id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, 1, 1, $6, $6)
    `, [id, accountId, displayName.trim(), role === "admin" ? "admin" : "user", hashPassword(password), now]);
    res.status(201).json({ id });
  } catch (error) {
    const duplicate = typeof error === "object" && error !== null && "code" in error && error.code === "23505";
    res.status(duplicate ? 409 : 500).json({ error: duplicate ? "账号已存在" : String(error) });
  }
}));

authRouter.patch("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const actor = requestUser(req);
  const { active, displayName } = req.body as { active?: boolean; displayName?: string };
  if (req.params.id === actor.id && active === false) {
    res.status(400).json({ error: "不能停用当前管理员账号" });
    return;
  }
  const row = await queryOne<{ id: string }>("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!row) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  const now = new Date().toISOString();
  if (typeof displayName === "string" && displayName.trim() && displayName.length <= 100) {
    await query("UPDATE users SET display_name = $1, updated_at = $2 WHERE id = $3", [displayName.trim(), now, req.params.id]);
  }
  if (typeof active === "boolean") {
    await query("UPDATE users SET active = $1, updated_at = $2 WHERE id = $3", [active ? 1 : 0, now, req.params.id]);
    if (!active) await revokeUserSessions(req.params.id);
  }
  res.json({ ok: true });
}));

authRouter.post("/users/:id/reset-password", requireAdmin, asyncHandler(async (req, res) => {
  const { password } = req.body as { password?: string };
  if (typeof password !== "string") {
    res.status(400).json({ error: "新密码不能为空" });
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
  `, [hashPassword(password), new Date().toISOString(), req.params.id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  await revokeUserSessions(req.params.id);
  res.json({ ok: true });
}));

authRouter.delete("/users/:id", requireAdmin, asyncHandler(async (req, res) => {
  const actor = requestUser(req);
  if (req.params.id === actor.id) {
    res.status(400).json({ error: "不能删除当前管理员账号" });
    return;
  }
  const { transferToUserId, deleteData } = req.body as { transferToUserId?: string; deleteData?: boolean };
  if (!transferToUserId && deleteData !== true) {
    res.status(400).json({ error: "必须选择数据接收用户，或明确将数据放入 15 天回收站" });
    return;
  }
  const source = await queryOne<{ id: string }>("SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL", [req.params.id]);
  if (!source) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  if (transferToUserId) {
    const target = await queryOne<{ id: string }>(
      "SELECT id FROM users WHERE id = $1 AND active = 1 AND deleted_at IS NULL",
      [transferToUserId],
    );
    if (!target) {
      res.status(400).json({ error: "数据接收用户不存在或已停用" });
      return;
    }
  }
  const now = new Date();
  const nowIso = now.toISOString();
  const purgeAfter = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString();
  await transaction(async (client) => {
    if (transferToUserId) {
      for (const table of ["projects", "assets", "files", "generation_runs", "usage_events"] as const) {
        await client.query(`UPDATE ${table} SET owner_id = $1 WHERE owner_id = $2`, [transferToUserId, req.params.id]);
      }
    } else {
      await client.query(
        "UPDATE projects SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL",
        [nowIso, purgeAfter, req.params.id],
      );
      await client.query(
        "UPDATE assets SET deleted_at = $1, purge_after = $2 WHERE owner_id = $3 AND deleted_at IS NULL",
        [nowIso, purgeAfter, req.params.id],
      );
    }
    await client.query("DELETE FROM sessions WHERE user_id = $1", [req.params.id]);
    await client.query("UPDATE users SET active = 0, deleted_at = $1, updated_at = $1 WHERE id = $2", [nowIso, req.params.id]);
  });
  res.json({ ok: true, purgeAfter: transferToUserId ? null : purgeAfter });
}));
