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

export async function createSession(userId: string): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await transaction(async (client) => {
    // 单账号单设备：新登录成功后，旧设备会话立即失效。
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

export async function authenticatedUser(req: Request): Promise<AuthUser | undefined> {
  const token = cookieValue(req, SESSION_COOKIE);
  if (!token) return undefined;
  const now = new Date().toISOString();
  const row = await queryOne<{
    id: string; account_id: string; display_name: string; role: "admin" | "user"; must_change_password: number;
  }>(`
    SELECT u.id, u.account_id, u.display_name, u.role, u.must_change_password
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = 1 AND u.deleted_at IS NULL
  `, [sessionHash(token), now]);
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
  void authenticatedUser(req).then((user) => {
    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ error: "请先登录", code: "UNAUTHENTICATED" });
      return;
    }
    (req as AuthenticatedRequest).authUser = user;
    next();
  }).catch(next);
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

export async function pruneExpiredSessions(): Promise<void> {
  await query("DELETE FROM sessions WHERE expires_at <= $1", [new Date().toISOString()]);
}
