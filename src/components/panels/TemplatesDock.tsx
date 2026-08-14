import { useCallback, useEffect, useRef, useState } from "react";
import type { Edge } from "@xyflow/react";
import { nanoid } from "nanoid";
import { useFlowStore, type FlowNode } from "@/store/flowStore";
import { WORKFLOW_SCHEMA_VERSION, type WorkflowTemplate } from "@/types/workflow";
import { WorkflowMini } from "./WorkflowMini";

/**
 * 画布顶部中央的模板悬浮入口：
 * 默认只显示一枚「模板库」胶囊按钮；点击后向下展开完整浮窗，
 * 内部是卡片式模板（微缩图 + 名称 + 文字介绍）。
 */
export function TemplatesDock() {
  const [open, setOpen] = useState(false);
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/templates");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTemplates((await res.json()) as WorkflowTemplate[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // 打开时拉取最新模板
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 点击浮窗外部 / Esc 关闭
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

  const applyTemplate = (tpl: WorkflowTemplate) => {
    // 从模板新建独立项目页签，当前画布及其后台生成状态保持不变。
    useFlowStore.getState().openFlowTab({
      projectId: nanoid(10),
      projectName: `${tpl.name} - 副本`,
      nodes: tpl.flow.nodes as FlowNode[],
      edges: tpl.flow.edges as Edge[],
      markDirty: true,
    });
    setOpen(false);
  };

  const removeTemplate = async (tpl: WorkflowTemplate) => {
    try {
      const res = await fetch(`/api/templates/${tpl.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setTemplates((list) => list.filter((t) => t.id !== tpl.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-x-0 top-3 z-30">
      {/* 悬浮入口胶囊（独立居中，不随浮窗开合移动） */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`pointer-events-auto flex items-center gap-1.5 rounded-full border px-4 py-1.5 text-[11px] font-medium shadow-lg shadow-black/40 backdrop-blur transition-colors ${
            open
              ? "border-gold bg-[#1a1a1a] text-gold"
              : "border-[#333] bg-[#141414]/90 text-neutral-300 hover:border-gold/60 hover:text-gold"
          }`}
        >
          <span className="text-[13px] leading-none">▦</span>
          模板库
          <span className="text-[9px] text-neutral-500">{open ? "▲" : "▼"}</span>
        </button>
      </div>

      {/* 点击展开的完整浮窗（相对画布独立居中，不影响按钮位置） */}
      {open && (
        <div className="pointer-events-auto mx-auto mt-2 w-[660px] max-w-[80vw] rounded-xl border border-[#333] bg-[#141414] shadow-2xl shadow-black/60">
          <div className="flex items-center justify-between border-b border-[#262626] px-4 py-2.5">
            <span className="text-xs font-medium text-neutral-200">工作流模板</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setSaving(true)}
                className="rounded-md border border-gold/50 bg-gold/10 px-2.5 py-1 text-[10px] font-medium text-gold transition-colors hover:bg-gold/20"
              >
                当前画布存为模板
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md border border-[#333] px-2 py-1 text-[10px] text-neutral-400 hover:text-neutral-200"
              >
                关闭 Esc
              </button>
            </div>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-4">
            {error ? (
              <div className="py-6 text-center">
                <p className="text-[11px] text-neutral-600">模板服务暂不可用（{error}）</p>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="mt-2 rounded border border-[#262626] px-2 py-1 text-[10px] text-neutral-400 hover:border-gold/50 hover:text-gold"
                >
                  重试
                </button>
              </div>
            ) : templates.length === 0 ? (
              <p className="py-6 text-center text-[11px] text-neutral-600">暂无模板</p>
            ) : (
              <div className="grid grid-cols-3 gap-3">
                {templates.map((tpl) => (
                  <div
                    key={tpl.id}
                    className="group flex flex-col overflow-hidden rounded-lg border border-[#262626] bg-[#1a1a1a] transition-colors hover:border-gold/50"
                  >
                    <button
                      type="button"
                      title="从模板新建"
                      onClick={() => applyTemplate(tpl)}
                      className="block w-full"
                    >
                      {tpl.thumbnail ? (
                        <img
                          src={tpl.thumbnail}
                          alt={tpl.name}
                          className="aspect-[16/9] w-full object-cover"
                        />
                      ) : (
                        <WorkflowMini flow={tpl.flow} className="aspect-[16/9] w-full" />
                      )}
                    </button>
                    <div className="flex flex-1 flex-col gap-1 p-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[11px] font-medium text-neutral-200">
                          {tpl.name}
                        </span>
                        {tpl.builtIn && (
                          <span className="shrink-0 rounded border border-gold/40 px-1 py-px text-[8px] text-gold">
                            内置
                          </span>
                        )}
                      </div>
                      {tpl.description && (
                        <p className="line-clamp-2 text-[10px] leading-relaxed text-neutral-500">
                          {tpl.description}
                        </p>
                      )}
                      <div className="mt-auto flex gap-1.5 pt-1.5">
                        <button
                          type="button"
                          onClick={() => applyTemplate(tpl)}
                          className="flex-1 rounded border border-[#262626] px-1.5 py-1 text-[10px] text-neutral-300 transition-colors hover:border-gold/60 hover:text-gold"
                        >
                          从模板新建
                        </button>
                        {!tpl.builtIn && (
                          <button
                            type="button"
                            onClick={() => void removeTemplate(tpl)}
                            className="rounded border border-[#262626] px-1.5 py-1 text-[10px] text-neutral-500 transition-colors hover:border-red-900 hover:text-red-400"
                          >
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {saving && <SaveTemplateForm onClose={() => setSaving(false)} onSaved={load} />}
    </div>
  );
}

function SaveTemplateForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError("请填写模板名称");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { nodes, edges } = useFlowStore.getState();
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim(),
          flow: { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-72 space-y-3 rounded-xl border border-[#262626] bg-[#141414] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-medium text-neutral-200">存为模板</div>
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：草图→改款→放大 标准流"
            autoFocus
            className="w-full rounded-md border border-[#262626] bg-[#0f0f0f] px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-gold focus:outline-none"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">描述</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="这个模板适用于什么场景"
            className="w-full resize-none rounded-md border border-[#262626] bg-[#0f0f0f] px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-gold focus:outline-none"
          />
        </label>
        {error && <p className="text-[10px] text-red-400">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md border border-[#262626] px-2 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting}
            className="flex-1 rounded-md bg-gold px-2 py-1.5 text-xs font-medium text-ink hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
