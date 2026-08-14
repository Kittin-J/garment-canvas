import { Router } from "express";
import { nanoid } from "nanoid";
import {
  clearSessionCookie,
  createSession,
  requireAuth,
  requireAdmin,
  requestUser,
  revokeRequestSession,
  revokeUserSessions,
  setSessionCookie,
} from "../lib/auth";
import { db } from "../lib/database";
import { hashPassword, validatePassword, verifyPassword } from "../lib/password";

export const authRouter = Router();

function publicUser(row: {
  id: string; account_id: string; display_name: string; role: "admin" | "user";
  must_change_password: number; active?: number; created_at?: string;
}) {
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

authRouter.post("/login", (req, res) => {
  const { accountId, password } = req.body as { accountId?: string; password?: string };
  if (typeof accountId !== "string" || typeof password !== "string" || !accountId.trim() || !password) {
    res.status(400).json({ error: "账号和密码不能为空" });
    return;
  }
  const row = db().prepare(`
    SELECT id, account_id, display_name, role, password_hash, must_change_password, active
    FROM users WHERE account_id = ? AND deleted_at IS NULL
  `).get(accountId.trim()) as {
    id: string; account_id: string; display_name: string; role: "admin" | "user";
    password_hash: string; must_change_password: number; active: number;
  } | undefined;
  if (!row || row.active !== 1 || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({ error: "账号或密码错误" });
    return;
  }
  const session = createSession(row.id);
  setSessionCookie(res, session.token);
  res.json({ user: publicUser(row), expiresAt: session.expiresAt });
});

authRouter.use(requireAuth);

authRouter.get("/me", (req, res) => {
  res.json({ user: requestUser(req) });
});

authRouter.post("/logout", (req, res) => {
  revokeRequestSession(req);
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.post("/change-password", (req, res) => {
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
  const row = db().prepare("SELECT password_hash FROM users WHERE id = ?").get(user.id) as { password_hash: string };
  if (!verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({ error: "当前密码错误" });
    return;
  }
  const now = new Date().toISOString();
  db().prepare("UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?")
    .run(hashPassword(newPassword), now, user.id);
  // 密码变化使其他会话失效，并为当前设备签发新的唯一会话。
  const session = createSession(user.id);
  setSessionCookie(res, session.token);
  res.json({ ok: true, user: { ...user, mustChangePassword: false }, expiresAt: session.expiresAt });
});

authRouter.get("/users", requireAdmin, (_req, res) => {
  const rows = db().prepare(`
    SELECT id, account_id, display_name, role, must_change_password, active, created_at
    FROM users WHERE deleted_at IS NULL ORDER BY created_at ASC
  `).all() as Array<{
    id: string; account_id: string; display_name: string; role: "admin" | "user";
    must_change_password: number; active: number; created_at: string;
  }>;
  res.json(rows.map(publicUser));
});

authRouter.post("/users", requireAdmin, (req, res) => {
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
    db().prepare(`
      INSERT INTO users (id, account_id, display_name, role, password_hash, must_change_password, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)
    `).run(id, accountId, displayName.trim(), role === "admin" ? "admin" : "user", hashPassword(password), now, now);
    res.status(201).json({ id });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error && /UNIQUE/.test(error.message) ? "账号已存在" : String(error) });
  }
});

authRouter.patch("/users/:id", requireAdmin, (req, res) => {
  const actor = requestUser(req);
  const { active, displayName } = req.body as { active?: boolean; displayName?: string };
  if (req.params.id === actor.id && active === false) {
    res.status(400).json({ error: "不能停用当前管理员账号" });
    return;
  }
  const row = db().prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
  if (!row) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  const now = new Date().toISOString();
  if (typeof displayName === "string" && displayName.trim() && displayName.length <= 100) {
    db().prepare("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?")
      .run(displayName.trim(), now, req.params.id);
  }
  if (typeof active === "boolean") {
    db().prepare("UPDATE users SET active = ?, updated_at = ? WHERE id = ?")
      .run(active ? 1 : 0, now, req.params.id);
    if (!active) revokeUserSessions(req.params.id);
  }
  res.json({ ok: true });
});

authRouter.post("/users/:id/reset-password", requireAdmin, (req, res) => {
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
  const result = db().prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 1, updated_at = ?
    WHERE id = ? AND deleted_at IS NULL
  `).run(hashPassword(password), new Date().toISOString(), req.params.id);
  if (result.changes === 0) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  revokeUserSessions(req.params.id);
  res.json({ ok: true });
});

authRouter.delete("/users/:id", requireAdmin, (req, res) => {
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
  const database = db();
  const source = database.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL").get(req.params.id);
  if (!source) {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  if (transferToUserId) {
    const target = database.prepare("SELECT id FROM users WHERE id = ? AND active = 1 AND deleted_at IS NULL").get(transferToUserId);
    if (!target) {
      res.status(400).json({ error: "数据接收用户不存在或已停用" });
      return;
    }
  }
  const now = new Date();
  const purgeAfter = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000).toISOString();
  database.transaction(() => {
    if (transferToUserId) {
      for (const table of ["projects", "assets", "files", "generation_runs", "usage_events"]) {
        database.prepare(`UPDATE ${table} SET owner_id = ? WHERE owner_id = ?`).run(transferToUserId, req.params.id);
      }
    } else {
      database.prepare("UPDATE projects SET deleted_at = ?, purge_after = ? WHERE owner_id = ?")
        .run(now.toISOString(), purgeAfter, req.params.id);
      database.prepare("UPDATE assets SET deleted_at = ?, purge_after = ? WHERE owner_id = ? AND deleted_at IS NULL")
        .run(now.toISOString(), purgeAfter, req.params.id);
    }
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(req.params.id);
    database.prepare("UPDATE users SET active = 0, deleted_at = ?, updated_at = ? WHERE id = ?")
      .run(now.toISOString(), now.toISOString(), req.params.id);
  })();
  res.json({ ok: true, purgeAfter: transferToUserId ? null : purgeAfter });
});
