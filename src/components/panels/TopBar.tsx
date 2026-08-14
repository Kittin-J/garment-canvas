import { useEffect, useRef, useState } from "react";
import { useFlowStore } from "@/store/flowStore";
import { THEMES, useTheme } from "@/lib/theme";
import { AccountMenu } from "./AccountMenu";

const SAVE_TEXT = {
  idle: "保存",
  saving: "保存中…",
  saved: "已保存",
  error: "保存失败，重试",
} as const;

/** 打开项目：下拉列出已保存项目，加载恢复画布 */
function ProjectPicker() {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<{ id: string; name: string; ownerName?: string; readOnly?: boolean; updatedAt: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const openRequestIdRef = useRef(0);
  const currentId = useFlowStore((s) => s.projectId);
  const openFlowTab = useFlowStore((s) => s.openFlowTab);

  useEffect(() => {
    if (!open) return;
    setError(null);
    fetch("/api/projects")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => setList(data as typeof list))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const openProject = async (id: string) => {
    const alreadyOpen = useFlowStore.getState().tabs.find((tab) => tab.projectId === id);
    if (alreadyOpen) {
      useFlowStore.getState().switchTab(alreadyOpen.id);
      setOpen(false);
      return;
    }
    const requestId = ++openRequestIdRef.current;
    try {
      const res = await fetch(`/api/projects/${id}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = (await res.json()) as {
        id: string;
        name: string;
        ownerName?: string;
        readOnly?: boolean;
        flow?: { nodes?: unknown; edges?: unknown };
      };
      if (!Array.isArray(p.flow?.nodes) || !Array.isArray(p.flow?.edges)) {
        throw new Error("项目数据损坏或不兼容");
      }
      if (requestId !== openRequestIdRef.current) return;
      openFlowTab({
        projectId: p.id,
        projectName: p.name,
        nodes: p.flow.nodes as never,
        edges: p.flow.edges as never,
        readOnly: p.readOnly ?? false,
      });
      setOpen(false);
    } catch (err) {
      // 加载失败只提示，绝不清空当前画布
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded-md border px-2.5 py-1 text-[10px] transition-colors ${
          open
            ? "border-gold text-gold"
            : "border-[#262626] text-neutral-400 hover:border-gold/50 hover:text-neutral-200"
        }`}
      >
        打开
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1.5 w-64 rounded-lg border border-[#333] bg-[#161616] p-1.5 shadow-xl shadow-black/60">
          <div className="px-2.5 pb-1.5 pt-1 text-[10px] uppercase tracking-widest text-neutral-600">
            已保存的项目
          </div>
          {error ? (
            <p className="px-2.5 py-2 text-[10px] text-red-400">加载失败：{error}</p>
          ) : list.length === 0 ? (
            <p className="px-2.5 py-2 text-[10px] text-neutral-600">暂无项目，Ctrl+S 保存当前画布</p>
          ) : (
            <div className="max-h-56 overflow-y-auto">
              {list.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => void openProject(p.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left hover:bg-[#222]"
                >
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[11px] ${p.id === currentId ? "text-gold" : "text-neutral-200"}`}
                    >
                      {p.name}
                    </span>
                    <span className="block text-[9px] text-neutral-600">
                      {p.readOnly && p.ownerName ? `${p.ownerName} · 只读 · ` : ""}
                      {new Date(p.updatedAt).toLocaleString("zh-CN", {
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </span>
                  {p.id === currentId && (
                    <span className="shrink-0 text-[9px] text-gold">当前</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 主题切换：胶囊触发 + 悬浮下拉窗口 */
function ThemeSwitcher() {
  const [theme, switchTheme] = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as globalThis.Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] transition-colors ${
          open
            ? "border-gold text-gold"
            : "border-[#262626] text-neutral-400 hover:border-gold/50 hover:text-neutral-200"
        }`}
      >
        <span
          className="h-2.5 w-2.5 rounded-full border border-white/20"
          style={{ backgroundColor: current.swatch }}
        />
        {current.label}
        <span className="text-[8px] text-neutral-600">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-44 rounded-lg border border-[#333] bg-[#161616] p-1.5 shadow-xl shadow-black/60">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                switchTheme(t.id);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors ${
                theme === t.id ? "bg-gold/10" : "hover:bg-[#222]"
              }`}
            >
              <span
                className="h-4 w-4 shrink-0 rounded-full border border-white/20"
                style={{ backgroundColor: t.swatch }}
              />
              <span className="min-w-0">
                <span
                  className={`block text-[11px] ${theme === t.id ? "text-gold" : "text-neutral-200"}`}
                >
                  {t.label}
                </span>
                <span className="block truncate text-[9px] text-neutral-500">{t.desc}</span>
              </span>
              {theme === t.id && <span className="ml-auto text-[10px] text-gold">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  const projectName = useFlowStore((s) => s.projectName);
  const setProjectName = useFlowStore((s) => s.setProjectName);
  const saveState = useFlowStore((s) => s.saveState);
  const dirty = useFlowStore((s) => s.dirty);
  const readOnly = useFlowStore((s) => s.readOnly);
  const saveProject = useFlowStore((s) => s.saveProject);

  return (
    <header className="gc-panel relative flex h-11 shrink-0 items-center gap-3 border-b border-[#262626] bg-[#141414] px-4">
      {/* 左：品牌 + 项目名 */}
      <span className="text-xs font-semibold tracking-widest text-gold">GARMENT CANVAS</span>
      <span className="h-4 w-px bg-[#262626]" />
      <input
        value={projectName}
        onChange={(e) => setProjectName(e.target.value)}
        className="w-56 rounded-md border border-transparent bg-transparent px-2 py-1 text-xs text-neutral-200 hover:border-[#262626] focus:border-gold focus:outline-none"
        placeholder="项目名称"
      />
      {dirty && <span className="-ml-2 text-[10px] text-gold" title="有未保存修改">●</span>}
      {readOnly && <span className="rounded border border-blue-400/40 px-2 py-0.5 text-[9px] text-blue-400">管理员只读</span>}
      <button
        type="button"
        onClick={() => void saveProject()}
        disabled={readOnly || saveState === "saving" || (!dirty && saveState === "saved")}
        className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
          saveState === "error"
            ? "bg-red-900/60 text-red-300 hover:bg-red-900"
            : "bg-gold text-ink hover:opacity-90"
        } disabled:opacity-50`}
      >
        {SAVE_TEXT[saveState]}
      </button>

      {/* 中：快捷键提示 + 打开（绝对居中） */}
      <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-3">
        <span className="hidden text-[10px] text-neutral-600 sm:inline">
          Ctrl+S 保存 · Ctrl+Z 撤销 · Ctrl+C/V 复制粘贴节点
        </span>
        <ProjectPicker />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <ThemeSwitcher />
        <AccountMenu />
      </div>
    </header>
  );
}
