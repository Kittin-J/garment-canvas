export type SessionEndReason = "replaced";
export type AuthChangeType = "login" | "logout" | "auth-changed";

export interface AuthChangeMessage {
  id: string;
  type: AuthChangeType;
  userId?: string;
}

const SESSION_END_NOTICE_KEY = "garment-canvas-session-end-reason";
const WORKSPACE_OWNER_KEY = "garment-canvas-workspace-owner-id";
const PROJECT_TABS_KEY = "garment-canvas-project-tabs";
const RECENT_RESULTS_KEY = "garment-canvas-recent-results";
export const AUTH_CHANGE_STORAGE_KEY = "garment-canvas-auth-change";
let authChangeSequence = 0;

export function sessionEndReasonFromCode(code: unknown): SessionEndReason | null {
  return code === "SESSION_REPLACED" ? "replaced" : null;
}

export function sessionRefreshFailureAction(
  status: number,
  code: unknown,
): "retain-user" | "clear-user" | "end-replaced" {
  if (status !== 401) return "retain-user";
  return sessionEndReasonFromCode(code) === "replaced" ? "end-replaced" : "clear-user";
}

export function isCurrentSessionRefresh(
  requestId: number,
  latestRequestId: number,
  sessionAlreadyEnded: boolean,
): boolean {
  return requestId === latestRequestId && !sessionAlreadyEnded;
}

export function readSessionEndNotice(storage: Pick<Storage, "getItem">): SessionEndReason | null {
  try {
    return storage.getItem(SESSION_END_NOTICE_KEY) === "replaced" ? "replaced" : null;
  } catch {
    return null;
  }
}

export function rememberSessionEndNotice(
  storage: Pick<Storage, "setItem">,
  reason: SessionEndReason,
): void {
  try {
    storage.setItem(SESSION_END_NOTICE_KEY, reason);
  } catch {
    // 即使浏览器禁用存储，也必须继续执行会话退出和整页重载。
  }
}

export function clearSessionEndNotice(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(SESSION_END_NOTICE_KEY);
  } catch {
    // 存储不可用时页面仍可继续回到登录态。
  }
}

export function broadcastAuthChange(
  storage: Pick<Storage, "setItem">,
  type: AuthChangeType,
  userId?: string,
): void {
  try {
    const message: AuthChangeMessage = {
      id: `${Date.now().toString(36)}-${(++authChangeSequence).toString(36)}-${Math.random().toString(36).slice(2)}`,
      type,
      ...(userId ? { userId } : {}),
    };
    storage.setItem(AUTH_CHANGE_STORAGE_KEY, JSON.stringify(message));
  } catch {
    // localStorage 不可用时保留 /me 轮询作为降级路径。
  }
}

export function authChangeFromStorageEvent(
  key: string | null,
  newValue: string | null,
): AuthChangeMessage | null {
  if (key !== AUTH_CHANGE_STORAGE_KEY || !newValue) return null;
  try {
    const value = JSON.parse(newValue) as Partial<AuthChangeMessage>;
    if (
      typeof value.id !== "string" || !value.id ||
      !["login", "logout", "auth-changed"].includes(String(value.type)) ||
      (value.userId !== undefined && (typeof value.userId !== "string" || !value.userId))
    ) return null;
    return {
      id: value.id,
      type: value.type as AuthChangeType,
      ...(value.userId ? { userId: value.userId } : {}),
    };
  } catch {
    return null;
  }
}

export function readWorkspaceOwner(storage: Pick<Storage, "getItem">): string | null {
  try {
    const value = storage.getItem(WORKSPACE_OWNER_KEY);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function storageValue(
  storage: Pick<Storage, "getItem">,
  key: string,
): { available: boolean; value: string | null } {
  try {
    return { available: true, value: storage.getItem(key) };
  } catch {
    return { available: false, value: null };
  }
}

function writeWorkspaceOwner(storage: Pick<Storage, "setItem">, userId: string): boolean {
  try {
    storage.setItem(WORKSPACE_OWNER_KEY, userId);
    return true;
  } catch {
    // 无法使用会话存储时，画布本身也无法跨刷新恢复。
    return false;
  }
}

export function clearLocalWorkspace(
  sessionStorage: Pick<Storage, "removeItem">,
  localStorage: Pick<Storage, "removeItem">,
): void {
  try {
    sessionStorage.removeItem(PROJECT_TABS_KEY);
  } catch {
    // 浏览器禁用存储时忽略；页面重载仍会终止内存中的工作区任务。
  }
  try {
    localStorage.removeItem(RECENT_RESULTS_KEY);
  } catch {
    // 同上。
  }
}

/**
 * `/me` 已证明当前 cookie 所属用户，但无 owner 的旧缓存无法证明归属；
 * 只有 owner 明确匹配时才保留，否则必须先清除，防止画布跨账号泄露。
 */
export function bindWorkspaceToAuthenticatedUser(
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  localStorage: Pick<Storage, "getItem" | "removeItem">,
  userId: string,
): "preserved" | "cleared" | "unavailable" {
  const owner = readWorkspaceOwner(sessionStorage);
  if (owner === userId) return "preserved";
  const tabCache = storageValue(sessionStorage, PROJECT_TABS_KEY);
  const recentCache = storageValue(localStorage, RECENT_RESULTS_KEY);
  clearLocalWorkspace(sessionStorage, localStorage);
  const ownerBound = writeWorkspaceOwner(sessionStorage, userId);
  // 只有确实加载过旧缓存时才需要重载来丢弃其内存副本；存储整体不可用时
  // flowStore 同样无法恢复旧缓存，不能因无法写 owner 而进入无限重载。
  if (tabCache.value !== null || recentCache.value !== null) return "cleared";
  return ownerBound ? "preserved" : "unavailable";
}

/**
 * 显式登录必须使用响应中的 userId 校验画布归属。
 * 同账号保留未保存草稿；不同账号（或无法证明归属的旧会话）先清理再切换。
 */
export function prepareWorkspaceForLogin(
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  localStorage: Pick<Storage, "removeItem">,
  userId: string,
): "preserved" | "cleared" {
  const owner = readWorkspaceOwner(sessionStorage);
  if (owner === userId) return "preserved";
  clearLocalWorkspace(sessionStorage, localStorage);
  writeWorkspaceOwner(sessionStorage, userId);
  return "cleared";
}
