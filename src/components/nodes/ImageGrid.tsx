import type { ReactNode } from "react";
import { useFlowStore } from "@/store/flowStore";

interface ImageGridProps {
  images: string[];
  empty?: string;
  /** 每张图下方渲染的操作区（如「存为素材」按钮） */
  renderAction?: (url: string, index: number) => ReactNode;
}

/** 生成结果缩略图网格（单击弹出全局查看器，滚轮缩放） */
export function ImageGrid({ images, empty = "暂无生成结果", renderAction }: ImageGridProps) {
  const openViewer = useFlowStore((s) => s.openViewer);

  if (images.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[#2a2a2a] py-4 text-center text-[10px] text-neutral-600">
        {empty}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-1.5">
      {images.map((url, i) => (
        <div
          key={`${url}-${i}`}
          className="nodrag group overflow-hidden rounded-md border border-[#262626] bg-[#0f0f0f]"
        >
          <button
            type="button"
            onClick={() => openViewer({ url, title: `生成结果 ${i + 1}` })}
            className="block w-full"
          >
            <img
              src={url}
              alt={`生成结果 ${i + 1}`}
              className="aspect-square w-full object-cover transition-transform group-hover:scale-105"
            />
          </button>
          {renderAction?.(url, i)}
        </div>
      ))}
    </div>
  );
}
