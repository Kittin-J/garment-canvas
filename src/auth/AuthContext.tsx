import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  authChangeFromStorageEvent,
  bindWorkspaceToAuthenticatedUser,
  broadcastAuthChange,
  clearSessionEndNotice,
  isCurrentSessionRefresh,
  readSessionEndNotice,
  rememberSessionEndNotice,
  sessionRefreshFailureAction,
  type SessionEndReason,
} from "./session";

export interface CurrentUser {
  id: string;
  accountId: string;
  displayName: string;
  role: "admin" | "user";
  mustChangePassword: boolean;
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  sessionEndReason: SessionEndReason | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  acknowledgeSessionEnd: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const restoredSessionEndReason = useRef(readSessionEndNotice(window.sessionStorage)).current;
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(restoredSessionEndReason === null);
  const [sessionEndReason, setSessionEndReason] = useState<SessionEndReason | null>(restoredSessionEndReason);
  const refreshSequence = useRef(0);
  const sessionEnded = useRef(restoredSessionEndReason !== null);

  const refresh = useCallback(async () => {
    const requestId = ++refreshSequence.current;
    try {
      const response = await fetch("/api/auth/me", { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 401) {
          const body = (await response.json().catch(() => ({}))) as { code?: unknown };
          if (!isCurrentSessionRefresh(requestId, refreshSequence.current, sessionEnded.current)) return;
          const action = sessionRefreshFailureAction(response.status, body.code);
          if (action === "end-replaced") {
            sessionEnded.current = true;
            rememberSessionEndNotice(window.sessionStorage, "replaced");
            broadcastAuthChange(window.localStorage, "auth-changed");
            setSessionEndReason("replaced");
            setUser(null);
            // 整页重载会立即终止工作区和运行中的连接；不删除未保存草稿。
            window.location.reload();
          } else if (action === "clear-user") {
            setUser(null);
          }
        }
        return;
      }
      const body = (await response.json()) as { user: CurrentUser };
      if (isCurrentSessionRefresh(requestId, refreshSequence.current, sessionEnded.current)) {
        const workspace = bindWorkspaceToAuthenticatedUser(
          window.sessionStorage,
          window.localStorage,
          body.user.id,
        );
        if (workspace === "cleared") {
          // 共享 cookie 的其他页签可能已切换账号；重载后才能丢弃旧账号的内存画布。
          setUser(null);
          window.location.reload();
          return;
        }
        setUser(body.user);
      }
    } catch {
      // 瞬时断网不主动注销已登录用户；首次加载则自然停留在登录页。
    } finally {
      if (requestId === refreshSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionEndReason || sessionEnded.current) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, sessionEndReason]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!authChangeFromStorageEvent(event.key, event.newValue)) return;
      // Cookie 在同源页签间共享：先使当前工作区进入终态，再立即重载并重新绑定 owner。
      refreshSequence.current += 1;
      sessionEnded.current = true;
      clearSessionEndNotice(window.sessionStorage);
      setUser(null);
      setSessionEndReason(null);
      setLoading(true);
      window.location.reload();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    refreshSequence.current += 1;
    sessionEnded.current = true;
    clearSessionEndNotice(window.sessionStorage);
    broadcastAuthChange(window.localStorage, "logout");
    // 保留按账号绑定的本机草稿；下次登录不同账号时再安全清理。
    window.location.reload();
  }, []);

  const acknowledgeSessionEnd = useCallback(() => {
    clearSessionEndNotice(window.sessionStorage);
    // replaced cookie 留待下次成功登录自然覆盖，避免旧 /me 响应误删其他页签的新 cookie。
    setSessionEndReason(null);
    setUser(null);
    setLoading(false);
  }, []);

  const value = useMemo(
    () => ({ user, loading, sessionEndReason, refresh, logout, acknowledgeSessionEnd }),
    [user, loading, sessionEndReason, refresh, logout, acknowledgeSessionEnd],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
