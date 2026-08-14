import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

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
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const response = await fetch("/api/auth/me");
      if (!response.ok) {
        setUser(null);
        return;
      }
      const body = (await response.json()) as { user: CurrentUser };
      setUser(body.user);
    } catch {
      // 瞬时断网不主动注销已登录用户；首次加载则自然停留在登录页。
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.sessionStorage.removeItem("garment-canvas-project-tabs");
    window.localStorage.removeItem("garment-canvas-recent-results");
    window.location.reload();
  };

  const value = useMemo(() => ({ user, loading, refresh, logout }), [user, loading]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
