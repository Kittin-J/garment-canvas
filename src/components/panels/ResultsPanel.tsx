import { useState } from "react";
import { useFlowStore } from "@/store/flowStore";
import { OPEN_COMPARE_EVENT } from "@/components/CompareOverlay";
import { thumbnailImageUrl } from "@/lib/images";

interface ResultsPanelProps {
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

/** 底部结果面板（可折叠）：最近生成 + 运行记录一体，点击条目右侧显示详情 */
export function ResultsPanel({ hasMore = false, loadingMore = false, onLoadMore }: ResultsPanelProps) {
  // 生成历史是跨项目的全局记录；即使项目页签未恢复，也必须能在刷新后找回。
  const recentResults = useFlowStore((s) => s.recentResults);
  const selectedResultId = useFlowStore((s) => s.selectedResultId);
  const setSelectedResultId = useFlowStore((s) => s.setSelectedResultId);
  const compareIds = useFlowStore((s) => s.compareIds);
  const toggleCompareId = useFlowStore((s) => s.toggleCompareId);
  const openViewer = useFlowStore((s) => s.openViewer);
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="gc-panel shrink-0 border-t border-[#262626] bg-[#141414]">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left"
      >
        <span
          className={`inline-block text-[10px] text-neutral-500 transition-transform ${collapsed ? "" : "rotate-90"}`}
        >
          ▶
        </span>
        <span className="text-[10px] font-medium uppercase tracking-widest text-neutral-500">
          最近生成
        </span>
        <span className="text-[10px] text-neutral-600">{recentResults.length} 条</span>
        <span className="ml-auto flex items-center gap-3">
          {compareIds.length >= 2 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(new CustomEvent(OPEN_COMPARE_EVENT));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.stopPropagation();
                  window.dispatchEvent(new CustomEvent(OPEN_COMPARE_EVENT));
                }
              }}
              className="rounded border border-gold/60 bg-gold/10 px-2 py-0.5 text-[10px] font-medium text-gold transition-colors hover:bg-gold/20"
            >
              对比 {compareIds.length} 张
            </span>
          )}
          <span className="text-[9px] text-neutral-700">
            点击状态卡看记录 · 成功图可查看/对比
          </span>
        </span>
      </button>
      {!collapsed && (
        <div className="max-h-40 overflow-y-auto px-4 pb-3">
          {recentResults.length === 0 ? (
            <p className="py-3 text-center text-[10px] text-neutral-600">
              运行 AI 节点后，生成结果与运行记录会汇总在这里
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {recentResults.map((r) =>
                r.status === "queued" || r.status === "running" ? (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedResultId(r.id)}
                    className={`flex h-24 w-24 flex-col items-center justify-center gap-2 rounded-md border bg-[#0f0f0f] px-1 ${
                      selectedResultId === r.id
                        ? "border-gold"
                        : "border-[#3a3226] hover:border-gold/60"
                    }`}
                    title={r.status === "queued" ? "任务排队中" : "图片生成中"}
                  >
                    <span className="h-5 w-5 animate-spin rounded-full border-2 border-gold/30 border-t-gold" />
                    <span className="text-[10px] text-gold">
                      {r.status === "queued" ? "排队中" : "生成中"}
                    </span>
                    <span className="w-full truncate text-center text-[9px] text-neutral-500">
                      {r.nodeLabel}
                    </span>
                  </button>
                ) : r.status === "error" ? (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelectedResultId(r.id)}
                    className={`flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-md border bg-[#0f0f0f] px-1 ${
                      selectedResultId === r.id
                        ? "border-red-400"
                        : "border-red-900/50 hover:border-red-400/60"
                    }`}
                    title={r.error ?? "生成失败"}
                  >
                    <span className="text-[10px] text-red-400">✕ 失败</span>
                    <span className="w-full truncate text-center text-[9px] text-neutral-500">
                      {r.nodeLabel}
                    </span>
                  </button>
                ) : (
                  <button
                    key={r.id}
                    type="button"
                    onClick={(e) => {
                      if (e.ctrlKey || e.metaKey) {
                        toggleCompareId(r.id);
                      } else {
                        setSelectedResultId(r.id);
                        openViewer({
                          url: r.image,
                          title: r.nodeLabel,
                          prompt: r.prompt,
                          meta: `${r.model ?? ""} · ${(((r.finishedAt ?? r.startedAt) - r.startedAt) / 1000).toFixed(1)}s · ${new Date(r.finishedAt ?? r.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
                        });
                      }
                    }}
                    className={`group relative overflow-hidden rounded-md border bg-[#0f0f0f] ${
                      compareIds.includes(r.id)
                        ? "border-gold ring-2 ring-gold/70"
                        : selectedResultId === r.id
                          ? "border-gold ring-1 ring-gold"
                          : "border-[#262626] hover:border-gold/60"
                    }`}
                  >
                    <img
                      src={r.thumbnail ?? thumbnailImageUrl(r.image)}
                      alt={r.nodeLabel}
                      loading="lazy"
                      decoding="async"
                      className="h-24 w-24 object-cover transition-transform group-hover:scale-105"
                    />
                    {compareIds.includes(r.id) && (
                      <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-gold text-[9px] font-bold text-ink">
                        {compareIds.indexOf(r.id) + 1}
                      </span>
                    )}
                  </button>
                ),
              )}
              {hasMore && onLoadMore && (
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loadingMore}
                  className="h-24 w-24 rounded-md border border-dashed border-[var(--gc-border)] text-[10px] text-[var(--gc-text-muted)] hover:border-[var(--gc-accent)] hover:text-[var(--gc-accent)] disabled:opacity-50"
                >
                  {loadingMore ? "加载中…" : "加载更多"}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
