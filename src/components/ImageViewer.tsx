import { useEffect, useRef, useState } from "react";
import { useFlowStore } from "@/store/flowStore";
import { thumbnailImageUrl } from "@/lib/images";

const MIN_SCALE = 1;
const MAX_SCALE = 2;

/**
 * 全局图片查看器：单击任意图片弹出，
 * 滚轮缩放（1x ~ 2x），双击复位，Esc / 点击背景关闭。
 * 附带运行记录信息栏（来自最近生成的条目）。
 */
export function ImageViewer() {
  const viewer = useFlowStore((s) => s.viewer);
  const selectedResultId = useFlowStore((s) => s.selectedResultId);
  const record = useFlowStore((s) => s.recentResults.find((item) => item.id === selectedResultId));
  const closeViewer = useFlowStore((s) => s.closeViewer);
  const [scale, setScale] = useState(1);
  const [assetState, setAssetState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const imgRef = useRef<HTMLImageElement>(null);

  // 每次打开新图时复位缩放
  useEffect(() => {
    setScale(1);
    setAssetState("idle");
  }, [viewer?.url]);

  // 滚轮缩放（原生监听，preventDefault 阻止页面滚动）
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !viewer) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) =>
        Math.min(MAX_SCALE, Math.max(MIN_SCALE, s - e.deltaY * 0.0015)),
      );
    };
    img.addEventListener("wheel", onWheel, { passive: false });
    return () => img.removeEventListener("wheel", onWheel);
  }, [viewer]);

  useEffect(() => {
    if (!viewer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeViewer();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer, closeViewer]);

  if (!viewer) return null;

  const saveAsAsset = async () => {
    setAssetState("saving");
    try {
      const response = await fetch("/api/assets", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `${record?.nodeLabel ?? viewer.title ?? "生成素材"}-${new Date().toLocaleDateString("zh-CN")}`,
          category: "reference",
          image: viewer.url,
          sourceNote: record?.projectName ? `来自项目「${record.projectName}」` : "来自生成记录",
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAssetState("saved");
    } catch {
      setAssetState("error");
    }
  };

  const runAgain = () => {
    if (!record) return;
    const store = useFlowStore.getState();
    const tab = store.tabs.find((item) => item.projectId === record.projectId);
    if (!tab || !tab.nodes.some((node) => node.id === record.nodeId)) return;
    store.switchTab(tab.id);
    closeViewer();
    window.setTimeout(() => void useFlowStore.getState().runNode(record.nodeId), 0);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch bg-black/85"
      onClick={closeViewer}
    >
      <div className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden p-8">
        <img
          ref={imgRef}
          src={viewer.url}
          alt={viewer.title ?? "图片预览"}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => {
            e.stopPropagation();
            setScale(1);
          }}
          className="max-h-full max-w-full cursor-zoom-in rounded-lg object-contain shadow-2xl transition-transform duration-100"
          style={{ transform: `scale(${scale})` }}
          draggable={false}
        />
      </div>
      <span className="absolute left-4 top-4 text-[11px] text-neutral-400">
        滚轮缩放 {Math.round(scale * 100)}%（最大 200%）· 双击复位 · Esc 关闭
      </span>
      <aside className="w-[400px] shrink-0 overflow-y-auto border-l border-[#333] bg-[#141414]/98 p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium text-neutral-100">{record?.nodeLabel ?? viewer.title ?? "生成结果"}</h2>
            <p className="mt-1 text-[10px] text-neutral-500">{record?.projectName ?? "当前项目"}</p>
          </div>
          <button type="button" onClick={closeViewer} className="text-sm text-neutral-500 hover:text-white">✕</button>
        </div>
        <dl className="mt-5 space-y-2 border-y border-[#2b2b2b] py-4 text-[11px]">
          {[
            ["状态", record?.status === "success" ? "成功" : record?.status === "error" ? "失败" : "生成中"],
            ["模型", record?.model ?? "—"],
            ["数量", record?.requestedCount ? `${record.successfulCount ?? 0}/${record.requestedCount}` : "—"],
            ["服务请求", record?.providerRequests ?? "—"],
            ["开始时间", record?.startedAt ? new Date(record.startedAt).toLocaleString("zh-CN") : "—"],
            ["耗时", record?.finishedAt && record.startedAt ? `${((record.finishedAt - record.startedAt) / 1000).toFixed(1)}s` : "—"],
          ].map(([label, value]) => <div key={String(label)} className="flex justify-between gap-4"><dt className="text-neutral-500">{label}</dt><dd className="text-right text-neutral-300">{value}</dd></div>)}
        </dl>
        {(record?.prompt || viewer.prompt) && <div className="mt-4"><p className="text-[10px] text-neutral-500">提示词</p><p className="mt-1 whitespace-pre-wrap rounded-lg border border-[#2b2b2b] bg-[#0f0f0f] p-3 text-[11px] leading-relaxed text-neutral-300">{record?.prompt ?? viewer.prompt}</p><button type="button" onClick={() => void navigator.clipboard.writeText(record?.prompt ?? viewer.prompt ?? "")} className="mt-2 rounded border border-[#333] px-2 py-1 text-[10px] text-neutral-400 hover:text-white">复制提示词</button></div>}
        {record?.referenceImages && record.referenceImages.length > 0 && <div className="mt-4"><p className="text-[10px] text-neutral-500">参考图 · {record.referenceImages.length} 张</p><div className="mt-2 grid grid-cols-4 gap-2">{record.referenceImages.map((image, index) => <img key={`${image}-${index}`} src={thumbnailImageUrl(image)} alt={`参考图 ${index + 1}`} loading="lazy" decoding="async" className="aspect-square w-full rounded border border-[#333] object-cover" />)}</div></div>}
        {record?.parameters && Object.keys(record.parameters).length > 0 && <details className="mt-4 rounded-lg border border-[#2b2b2b] p-3 text-[10px] text-neutral-400"><summary className="cursor-pointer">生成参数</summary><pre className="mt-2 whitespace-pre-wrap break-all">{JSON.stringify(record.parameters, null, 2)}</pre></details>}
        {record?.error && <div className="mt-4 rounded-lg border border-red-900/50 bg-red-950/20 p-3 text-[11px] text-red-300">{record.error}</div>}
        <div className="mt-5 flex flex-wrap gap-2">
          <a href={viewer.url} download className="rounded bg-gold px-3 py-1.5 text-[11px] font-medium text-ink">下载图片</a>
          <button type="button" onClick={() => void saveAsAsset()} disabled={assetState === "saving" || assetState === "saved"} className="rounded border border-[#444] px-3 py-1.5 text-[11px] text-neutral-300 disabled:opacity-60">{assetState === "saving" ? "收藏中…" : assetState === "saved" ? "已收藏" : assetState === "error" ? "收藏失败，重试" : "收藏为资产"}</button>
          {record && <button type="button" onClick={runAgain} className="rounded border border-[#444] px-3 py-1.5 text-[11px] text-neutral-300">重新生成</button>}
        </div>
      </aside>
    </div>
  );
}
