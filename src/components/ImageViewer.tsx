import { useEffect, useRef, useState } from "react";
import { useFlowStore } from "@/store/flowStore";

const MIN_SCALE = 1;
const MAX_SCALE = 2;

/**
 * 全局图片查看器：单击任意图片弹出，
 * 滚轮缩放（1x ~ 2x），双击复位，Esc / 点击背景关闭。
 * 附带运行记录信息栏（来自最近生成的条目）。
 */
export function ImageViewer() {
  const viewer = useFlowStore((s) => s.viewer);
  const closeViewer = useFlowStore((s) => s.closeViewer);
  const [scale, setScale] = useState(1);
  const imgRef = useRef<HTMLImageElement>(null);

  // 每次打开新图时复位缩放
  useEffect(() => {
    setScale(1);
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

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-8"
      onClick={closeViewer}
    >
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
      <span className="absolute right-4 top-4 text-[11px] text-neutral-400">
        滚轮缩放 {Math.round(scale * 100)}%（最大 200%）· 双击复位 · Esc 关闭
      </span>

      {/* 运行记录信息栏 */}
      {(viewer.title || viewer.prompt || viewer.meta) && (
        <div
          className="absolute inset-x-0 bottom-0 border-t border-[#333] bg-[#141414]/95 px-6 py-3"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="mx-auto flex max-w-3xl items-center gap-3 text-[11px]">
            {viewer.title && (
              <span className="shrink-0 font-medium text-neutral-200">{viewer.title}</span>
            )}
            {viewer.meta && (
              <span className="shrink-0 text-neutral-500">{viewer.meta}</span>
            )}
            {viewer.prompt && (
              <span className="truncate text-neutral-400" title={viewer.prompt}>
                {viewer.prompt}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
