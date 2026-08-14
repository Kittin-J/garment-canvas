import { createHash, randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db } from "./database";

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

export function createSession(userId: string): { token: string; expiresAt: string } {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const database = db();
  database.transaction(() => {
    // 单账号单设备：新登录成功后，旧设备会话立即失效。
    database.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    database.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(sessionHash(token), userId, now.toISOString(), expiresAt);
  })();
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

export function revokeRequestSession(req: Request): void {
  const token = cookieValue(req, SESSION_COOKIE);
  if (token) db().prepare("DELETE FROM sessions WHERE token_hash = ?").run(sessionHash(token));
}

export function revokeUserSessions(userId: string): void {
  db().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export function authenticatedUser(req: Request): AuthUser | undefined {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return undefined;
  const now = new Date().toISOString();
  const row = db().prepare(`
    SELECT u.id, u.account_id, u.display_name, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1 AND u.deleted_at IS NULL
  `).get(sessionHash(token), now) as {
    id: string; account_id: string; display_name: string; role: "admin" | "user"; must_change_password: number;
  } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    accountId: row.account_id,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: row.must_change_password === 1,
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = authenticatedUser(req);
  if (!user) {
    clearSessionCookie(res);
    res.status(401).json({ error: "请先登录", code: "UNAUTHENTICATED" });
    return;
  }
  (req as AuthenticatedRequest).authUser = user;
  next();
}

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

export function pruneExpiredSessions(): void {
  db().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
}
