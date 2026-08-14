import { useState, type FormEvent } from "react";
import { useAuth } from "./AuthContext";

export function LoginPage() {
  const [accountId, setAccountId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, password }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `登录失败（HTTP ${response.status}）`);
      // 避免同一浏览器先前用户的画布会话泄露给新登录账号。
      window.sessionStorage.removeItem("garment-canvas-project-tabs");
      window.localStorage.removeItem("garment-canvas-recent-results");
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center bg-[#101214] px-4 text-neutral-200">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-[#2b2d30] bg-[#17191c] p-7 shadow-2xl">
        <div className="mb-7">
          <p className="text-[10px] font-medium uppercase tracking-[0.35em] text-[#9A7333]">GARMENT CANVAS</p>
          <h1 className="mt-2 text-xl font-semibold">登录服装设计工作台</h1>
          <p className="mt-1 text-xs text-neutral-500">账号由管理员创建，同一账号仅允许一个设备在线。</p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-xs text-neutral-400">账号</span>
          <input autoFocus value={accountId} onChange={(e) => setAccountId(e.target.value)}
            autoComplete="username" className="w-full rounded-lg border border-[#34363a] bg-[#0f1113] px-3 py-2.5 text-sm outline-none focus:border-[#9A7333]" />
        </label>
        <label className="mt-4 block space-y-1.5">
          <span className="text-xs text-neutral-400">密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password" className="w-full rounded-lg border border-[#34363a] bg-[#0f1113] px-3 py-2.5 text-sm outline-none focus:border-[#9A7333]" />
        </label>
        {error && <p className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</p>}
        <button type="submit" disabled={submitting || !accountId || !password}
          className="mt-5 w-full rounded-lg bg-[#9A7333] py-2.5 text-sm font-medium text-white hover:bg-[#ae8440] disabled:opacity-50">
          {submitting ? "登录中…" : "登录"}
        </button>
      </form>
    </main>
  );
}

export function ChangePasswordPage() {
  const { refresh } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setError("两次输入的新密码不一致");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "修改密码失败");
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex h-full items-center justify-center bg-[#101214] px-4 text-neutral-200">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-[#2b2d30] bg-[#17191c] p-7 shadow-2xl">
        <h1 className="text-xl font-semibold">首次登录，请修改密码</h1>
        <p className="mt-1 text-xs text-neutral-500">新密码至少 10 位，并同时包含字母和数字。</p>
        {[
          ["当前临时密码", currentPassword, setCurrentPassword, "current-password"],
          ["新密码", newPassword, setNewPassword, "new-password"],
          ["再次输入新密码", confirm, setConfirm, "new-password"],
        ].map(([label, value, setter, auto]) => (
          <label key={label as string} className="mt-4 block space-y-1.5">
            <span className="text-xs text-neutral-400">{label as string}</span>
            <input type="password" value={value as string} onChange={(e) => (setter as (v: string) => void)(e.target.value)}
              autoComplete={auto as string} className="w-full rounded-lg border border-[#34363a] bg-[#0f1113] px-3 py-2.5 text-sm outline-none focus:border-[#9A7333]" />
          </label>
        ))}
        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}
        <button type="submit" disabled={submitting || !currentPassword || !newPassword || !confirm}
          className="mt-5 w-full rounded-lg bg-[#9A7333] py-2.5 text-sm font-medium text-white disabled:opacity-50">
          {submitting ? "保存中…" : "修改密码并继续"}
        </button>
      </form>
    </main>
  );
}
