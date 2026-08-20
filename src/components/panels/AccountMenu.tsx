import { useEffect, useRef, useState } from "react";
import { useAuth, type CurrentUser } from "@/auth/AuthContext";
import type { ImageModelId } from "@/types/imageModels";

interface ManagedUser extends CurrentUser {
  active: boolean;
  createdAt: string;
}

interface UsageItem {
  id: string; userId: string; accountId: string; displayName: string; model?: string;
  successfulCount: number; providerRequests: number; durationMs: number; createdAt: string;
}

interface AiDiagnosticProvider {
  providerId: ImageModelId;
  model: string;
  label: string;
  channel: string;
  probes: Array<"generate" | "edit">;
  configured: boolean;
  error?: string;
  capabilities?: {
    supportsGeneration: boolean;
    supportsEdit: boolean;
    maxReferenceImages: number;
    maxImagesPerRequest: number;
    timeoutMs: number;
  };
}

interface AiDiagnostics {
  gateway: string;
  providers: AiDiagnosticProvider[];
}

type AccountPanelTab = "usage" | "users" | "diagnostics";

export function AccountMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<AccountPanelTab | null>(null);
  const root = useRef<HTMLDivElement>(null);
  if (!user) return null;

  return (
    <div ref={root} className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)}
        aria-label={`账户菜单：${user.displayName}`}
        title={`账户菜单：${user.displayName}`}
        className="flex h-8 w-8 items-center justify-center gap-2 rounded-full border border-[var(--gc-border)] px-0 text-[10px] text-[var(--gc-text-muted)] hover:border-[var(--gc-accent)] sm:h-auto sm:w-auto sm:px-3 sm:py-1.5">
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[var(--gc-accent)] text-[9px] font-semibold text-white">
          {user.displayName.slice(0, 1)}
        </span>
        <span className="hidden sm:inline">{user.displayName}</span>
      </button>
      {open && (
        <div className="fixed right-2 top-12 z-50 w-44 rounded-lg border border-[var(--gc-border)] bg-[var(--gc-panel)] p-1.5 shadow-xl sm:absolute sm:right-0 sm:top-full sm:mt-1.5">
          <button className="w-full rounded px-2.5 py-2 text-left text-[11px] hover:bg-[var(--gc-panel-hover)]"
            onClick={() => { setPanel("usage"); setOpen(false); }}>消耗记录</button>
          {user.role === "admin" && (
            <>
              <button className="w-full rounded px-2.5 py-2 text-left text-[11px] hover:bg-[var(--gc-panel-hover)]"
                onClick={() => { setPanel("users"); setOpen(false); }}>用户管理</button>
              <button className="w-full rounded px-2.5 py-2 text-left text-[11px] hover:bg-[var(--gc-panel-hover)]"
                onClick={() => { setPanel("diagnostics"); setOpen(false); }}>AI 服务诊断</button>
            </>
          )}
          <button className="w-full rounded px-2.5 py-2 text-left text-[11px] text-red-400 hover:bg-red-950/20"
            onClick={() => void logout()}>退出登录</button>
        </div>
      )}
      {panel && <AccountPanel initialTab={panel} onClose={() => setPanel(null)} />}
    </div>
  );
}

function AccountPanel({ initialTab, onClose }: { initialTab: AccountPanelTab; onClose: () => void }) {
  const { user } = useAuth();
  const [tab, setTab] = useState(initialTab);
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [usage, setUsage] = useState<UsageItem[]>([]);
  const [diagnostics, setDiagnostics] = useState<AiDiagnostics | null>(null);
  const [probing, setProbing] = useState<string | null>(null);
  const [probeResults, setProbeResults] = useState<Record<string, string>>({});
  const [selectedUser, setSelectedUser] = useState(user?.role === "admin" ? "all" : user?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  const loadUsers = async () => {
    if (user?.role !== "admin") return;
    const response = await fetch("/api/auth/users");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setUsers(await response.json() as ManagedUser[]);
  };
  const loadUsage = async () => {
    const query = user?.role === "admin"
      ? selectedUser === "all" ? "?all=true" : `?userId=${encodeURIComponent(selectedUser)}`
      : "";
    const response = await fetch(`/api/usage${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setUsage(await response.json() as UsageItem[]);
  };
  const loadDiagnostics = async () => {
    if (user?.role !== "admin") return;
    const response = await fetch("/api/ai-diagnostics");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    setDiagnostics(await response.json() as AiDiagnostics);
  };

  useEffect(() => {
    setError(null);
    void Promise.all([loadUsers(), loadUsage(), loadDiagnostics()]).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [selectedUser]);

  const runProbe = async (providerId: AiDiagnosticProvider["providerId"], mode: "generate" | "edit") => {
    const key = `${providerId}:${mode}`;
    setProbing(key);
    setError(null);
    try {
      const response = await fetch("/api/ai-diagnostics/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerId, mode }),
      });
      const body = await response.json() as { ok?: boolean; error?: string; durationMs?: number };
      setProbeResults((current) => ({
        ...current,
        [key]: response.ok && body.ok
          ? `正常 · ${((body.durationMs ?? 0) / 1000).toFixed(1)} 秒`
          : body.error ?? "诊断失败",
      }));
    } catch (reason) {
      setProbeResults((current) => ({ ...current, [key]: reason instanceof Error ? reason.message : "诊断失败" }));
    } finally {
      setProbing(null);
    }
  };

  const exportUsage = () => {
    const query = user?.role === "admin"
      ? selectedUser === "all" ? "?all=true&format=csv" : `?userId=${encodeURIComponent(selectedUser)}&format=csv`
      : "?format=csv";
    window.open(`/api/usage${query}`, "_blank", "noopener");
  };

  const createUser = async () => {
    const accountId = window.prompt("新用户账号");
    if (!accountId) return;
    const displayName = window.prompt("显示名称", accountId);
    if (!displayName) return;
    const password = window.prompt("初始密码（至少 10 位，包含字母和数字）");
    if (!password) return;
    const response = await fetch("/api/auth/users", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId, displayName, password, role: "user" }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { setError(body.error ?? "创建失败"); return; }
    await loadUsers();
  };

  const toggleUser = async (target: ManagedUser) => {
    const response = await fetch(`/api/auth/users/${target.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !target.active }),
    });
    if (!response.ok) { setError("更新用户失败"); return; }
    await loadUsers();
  };

  const resetPassword = async (target: ManagedUser) => {
    const password = window.prompt(`为 ${target.displayName} 设置临时密码`);
    if (!password) return;
    const response = await fetch(`/api/auth/users/${target.id}/reset-password`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) setError(body.error ?? "重置失败");
  };

  const deleteUser = async (target: ManagedUser) => {
    const choice = window.prompt("输入接收该用户数据的账号；若要把数据放入 15 天回收站，请输入 DELETE");
    if (!choice) return;
    const receiver = users.find((item) => item.accountId === choice && item.id !== target.id);
    if (choice !== "DELETE" && !receiver) { setError("没有找到数据接收账号"); return; }
    const response = await fetch(`/api/auth/users/${target.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(choice === "DELETE" ? { deleteData: true } : { transferToUserId: receiver!.id }),
    });
    const body = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) { setError(body.error ?? "删除用户失败"); return; }
    await loadUsers();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6" onClick={onClose}>
      <section className="flex h-[70vh] w-full max-w-4xl flex-col rounded-xl border border-[var(--gc-border)] bg-[var(--gc-panel)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center border-b border-[var(--gc-border)] px-5 py-3">
          <button onClick={() => setTab("usage")} className={`px-3 py-1.5 text-xs ${tab === "usage" ? "text-[var(--gc-accent)]" : "text-[var(--gc-text-muted)]"}`}>消耗记录</button>
          {user?.role === "admin" && <button onClick={() => setTab("users")} className={`px-3 py-1.5 text-xs ${tab === "users" ? "text-[var(--gc-accent)]" : "text-[var(--gc-text-muted)]"}`}>用户管理</button>}
          {user?.role === "admin" && <button onClick={() => setTab("diagnostics")} className={`px-3 py-1.5 text-xs ${tab === "diagnostics" ? "text-[var(--gc-accent)]" : "text-[var(--gc-text-muted)]"}`}>AI 服务诊断</button>}
          <button onClick={onClose} className="ml-auto text-sm text-[var(--gc-text-muted)]">✕</button>
        </header>
        {error && <p className="mx-5 mt-3 rounded bg-red-950/20 px-3 py-2 text-xs text-red-400">{error}</p>}
        {tab === "usage" ? (
          <div className="flex min-h-0 flex-1 flex-col p-5">
            <div className="mb-3 flex gap-2">
              {user?.role === "admin" && (
                <select value={selectedUser} onChange={(e) => setSelectedUser(e.target.value)} className="rounded border border-[var(--gc-border)] bg-[var(--gc-control)] px-2 py-1 text-xs">
                  <option value="all">全部用户</option>
                  {users.map((item) => <option key={item.id} value={item.id}>{item.displayName} · {item.accountId}</option>)}
                </select>
              )}
              <button onClick={exportUsage} className="ml-auto rounded bg-[var(--gc-accent)] px-3 py-1.5 text-xs text-white">导出 CSV</button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto rounded border border-[var(--gc-border)]">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-[var(--gc-panel)] text-[var(--gc-text-muted)]"><tr><th className="p-2">时间</th><th>用户</th><th>模型</th><th>成功图片</th><th>请求数</th><th>耗时</th></tr></thead>
                <tbody>{usage.map((item) => <tr key={item.id} className="border-t border-[var(--gc-border)]"><td className="p-2">{new Date(item.createdAt).toLocaleString("zh-CN")}</td><td>{item.displayName}</td><td>{item.model ?? "—"}</td><td>{item.successfulCount}</td><td>{item.providerRequests}</td><td>{(item.durationMs / 1000).toFixed(1)}s</td></tr>)}</tbody>
              </table>
            </div>
          </div>
        ) : tab === "users" ? (
          <div className="min-h-0 flex-1 overflow-auto p-5">
            <button onClick={() => void createUser()} className="mb-3 rounded bg-[var(--gc-accent)] px-3 py-1.5 text-xs text-white">创建用户</button>
            <div className="space-y-2">{users.map((item) => <div key={item.id} className="flex items-center rounded border border-[var(--gc-border)] p-3 text-xs"><span className="min-w-0 flex-1"><strong>{item.displayName}</strong><span className="ml-2 text-[var(--gc-text-muted)]">{item.accountId} · {item.role === "admin" ? "管理员" : "用户"}</span></span><button onClick={() => void resetPassword(item)} className="mr-2 rounded border border-[var(--gc-border)] px-2 py-1">重置密码</button><button disabled={item.id === user?.id} onClick={() => void toggleUser(item)} className={`mr-2 rounded px-2 py-1 ${item.active ? "bg-red-950/30 text-red-400" : "bg-emerald-950/30 text-emerald-400"}`}>{item.active ? "停用" : "启用"}</button>{item.id !== user?.id && <button onClick={() => void deleteUser(item)} className="rounded border border-red-900/50 px-2 py-1 text-red-400">删除</button>}</div>)}</div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto p-5">
            <p className="mb-4 text-xs text-[var(--gc-text-muted)]">
              网关：{diagnostics?.gateway ?? "读取中…"}。配置状态来自本地 API易契约；文生图与改图检查会各发起一次真实 AI 请求，可能产生少量消耗。
            </p>
            <div className="space-y-3">
              {diagnostics?.providers.map((provider) => (
                <section key={provider.providerId} className="rounded-lg border border-[var(--gc-border)] p-4 text-xs">
                  <div className="mb-2 flex items-center gap-2">
                    <strong>{provider.label}</strong>
                    <span className="text-[var(--gc-text-muted)]">
                      {provider.model} · {provider.channel === "official" ? "官转" : "Codex 官逆"}
                    </span>
                    <span className={provider.configured ? "ml-auto text-emerald-400" : "ml-auto text-red-400"}>
                      {provider.configured ? "配置完整" : "配置缺失"}
                    </span>
                  </div>
                  {!provider.configured && provider.error && (
                    <p className="mb-3 text-[11px] text-red-400">{provider.error}</p>
                  )}
                  {provider.capabilities && (
                    <p className="mb-3 text-[11px] text-[var(--gc-text-muted)]">
                      文生图：{provider.capabilities.supportsGeneration ? "支持" : "不支持"}
                      ；参考图编辑：{provider.capabilities.supportsEdit ? `支持，最多 ${provider.capabilities.maxReferenceImages} 张` : "不支持"}
                      ；单次最多 {provider.capabilities.maxImagesPerRequest} 张；超时 {Math.round(provider.capabilities.timeoutMs / 1000)} 秒
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {provider.probes.map((mode) => {
                      const key = `${provider.providerId}:${mode}`;
                      const label = mode === "generate" ? "检查文生图" : "检查改图";
                      return (
                        <button key={mode} disabled={!provider.configured || probing !== null}
                          onClick={() => void runProbe(provider.providerId, mode)}
                          className="rounded border border-[var(--gc-border)] px-2.5 py-1.5 disabled:opacity-40">
                          {probing === key ? "检查中…" : label}
                          {probeResults[key] ? ` · ${probeResults[key]}` : ""}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
