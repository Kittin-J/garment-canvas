import { useEffect, useState } from "react";
import { useFlowStore } from "@/store/flowStore";

/** ResultsPanel「对比 N 张」按钮派发此事件来打开对比浮层 */
export const OPEN_COMPARE_EVENT = "garment:open-compare";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** 多变体并排对比浮层：compareIds >= 2 时可打开，横向并排 2~4 张大图 */
export function CompareOverlay() {
  const compareIds = useFlowStore((s) => s.compareIds);
  const recentResults = useFlowStore((s) => s.recentResults);
  const clearCompare = useFlowStore((s) => s.clearCompare);
  const [open, setOpen] = useState(false);

  const items = compareIds
    .map((id) => recentResults.find((r) => r.id === id))
    .filter((r): r is NonNullable<typeof r> => Boolean(r && r.status === "success" && r.image));

  // 监听「对比 N 张」按钮事件打开浮层；对比项不足时自动关闭
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_COMPARE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMPARE_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (items.length < 2) setOpen(false);
  }, [items.length]);

  // Esc 退出对比
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        clearCompare();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, clearCompare]);

  if (!open || items.length < 2) return null;

  const close = () => {
    setOpen(false);
    clearCompare();
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm">
      <div className="flex items-center justify-between px-6 py-4">
        <span className="text-xs font-medium tracking-widest text-neutral-400">
          对比 {items.length} 张
        </span>
        <button
          type="button"
          onClick={close}
          className="flex h-8 w-8 items-center justify-center rounded-full border border-[#3a3a3a] text-sm text-neutral-400 transition-colors hover:border-gold hover:text-gold"
          title="关闭（Esc）"
        >
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-stretch justify-center gap-4 px-6 pb-6">
        {items.map((r) => (
          <div
            key={r.id}
            className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[#262626] bg-[#141414]"
          >
            <div className="flex min-h-0 flex-1 items-center justify-center bg-[#0f0f0f] p-2">
              <img
                src={r.image}
                alt={r.nodeLabel}
                className="max-h-full max-w-full object-contain"
              />
            </div>
            <div className="shrink-0 space-y-1 border-t border-[#262626] px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-neutral-200">
                  {r.nodeLabel}
                </span>
                <span className="shrink-0 text-[10px] text-neutral-500">
                  {formatTime(r.finishedAt ?? r.startedAt)}
                </span>
              </div>
              {r.prompt && (
                <p className="line-clamp-2 text-[10px] leading-relaxed text-neutral-500">
                  {r.prompt}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
