import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { query, queryOne, transaction } from "./database";

export interface AuthUser {
  id: string;
  accountId: string;
  displayName: string;
  role: "admin" | "user";
  mustChangePassword: boolean;
}

export interface AuthenticatedRequest extends Request {
  authUser: AuthUser;
}

export const SESSION_COOKIE = "gc_session";
export const SESSION_DAYS = 30;

export type AuthenticationResult =
  | { status: "authenticated"; user: AuthUser }
  | { status: "replaced" }
  | { status: "unauthenticated" };

function sessionHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

export async function createSession(
  userId: string,
  options: { markExistingAsReplaced?: boolean } = {},
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await transaction(async (client) => {
    // 串行化同一账号的并发登录，避免 sessions.user_id 唯一约束竞争。
    const lockedUser = await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (lockedUser.rowCount !== 1) throw new Error("用户不存在");
    // 单账号单设备：新登录成功后，旧设备会话立即失效。
    if (options.markExistingAsReplaced !== false) {
      await client.query(`
        INSERT INTO revoked_sessions (token_hash, reason, revoked_at, expires_at)
        SELECT token_hash, 'replaced', $2, expires_at FROM sessions WHERE user_id = $1
        ON CONFLICT (token_hash) DO UPDATE
          SET reason = excluded.reason, revoked_at = excluded.revoked_at, expires_at = excluded.expires_at
      `, [userId, now.toISOString()]);
    }
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await client.query(
      "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      [sessionHash(token), userId, now.toISOString(), expiresAt],
    );
  });
  return { token, expiresAt };
}

export function setSessionCookie(res: Response, token: string): void {
  const secure = process.env.COOKIE_SECURE === "true";
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
}

export async function revokeRequestSession(req: Request): Promise<void> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) await query("DELETE FROM sessions WHERE token_hash = $1", [sessionHash(token)]);
}

export async function revokeUserSessions(userId: string): Promise<void> {
  await query("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

export async function authenticateRequest(req: Request): Promise<AuthenticationResult> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return { status: "unauthenticated" };
  const tokenHash = sessionHash(token);
  const now = new Date().toISOString();
  const row = await queryOne<{
    id: string; account_id: string; display_name: string; role: "admin" | "user"; must_change_password: number;
  }>(`
    SELECT u.id, u.account_id, u.display_name, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = 1 AND u.deleted_at IS NULL
  `, [tokenHash, now]);
  if (row) {
    return {
      status: "authenticated",
      user: {
        id: row.id,
        accountId: row.account_id,
        displayName: row.display_name,
        role: row.role,
        mustChangePassword: row.must_change_password === 1,
      },
    };
  }
  const revoked = await queryOne<{ reason: "replaced" }>(`
    SELECT reason FROM revoked_sessions WHERE token_hash = $1 AND expires_at > $2
  `, [tokenHash, now]);
  return revoked?.reason === "replaced" ? { status: "replaced" } : { status: "unauthenticated" };
}

export async function authenticatedUser(req: Request): Promise<AuthUser | undefined> {
  const result = await authenticateRequest(req);
  return result.status === "authenticated" ? result.user : undefined;
}

function authenticateMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    void authenticateRequest(req).then((result) => {
      if (result.status !== "authenticated") {
        const replaced = result.status === "replaced";
        // 401 响应不触碰 Cookie：旧请求可能晚于另一页签的新登录响应到达。
        // 成功登录会覆盖旧 token，显式 logout 仍负责清除 Cookie。
        res.status(401).json({
          error: replaced ? "账号已在其他设备登录" : "请先登录",
          code: replaced ? "SESSION_REPLACED" : "UNAUTHENTICATED",
        });
        return;
      }
      (req as AuthenticatedRequest).authUser = result.user;
      next();
    }).catch(next);
  };
}

export const requireAuth = authenticateMiddleware();
export const requireAuthForSessionCheck = authenticateMiddleware();

export function requirePasswordChanged(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).authUser;
  if (user.mustChangePassword) {
    res.status(403).json({ error: "首次登录必须修改密码", code: "PASSWORD_CHANGE_REQUIRED" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).authUser;
  if (user.role !== "admin") {
    res.status(403).json({ error: "需要管理员权限", code: "FORBIDDEN" });
    return;
  }
  next();
}

export function requestUser(req: Request): AuthUser {
  return (req as AuthenticatedRequest).authUser;
}

export async function pruneExpiredSessions(): Promise<void> {
  const now = new Date().toISOString();
  await transaction(async (client) => {
    await client.query("DELETE FROM sessions WHERE expires_at <= $1", [now]);
    await client.query("DELETE FROM revoked_sessions WHERE expires_at <= $1", [now]);
  });
}
