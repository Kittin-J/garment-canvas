import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useShallow } from "zustand/react/shallow";
import { useFlowStore, selectResultImages } from "@/store/flowStore";
import type { ResultNodeData } from "@/types/workflow";
import { imageExtensionFromReference, type ImageFileExtension } from "@/lib/imageFormat";
import { NodeFrame, inputClass } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";

function downloadImage(url: string, index: number, extension?: ImageFileExtension) {
  const a = document.createElement("a");
  a.href = url;
  a.download = `garment-result-${index + 1}${extension ? `.${extension}` : ""}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function ResultNode({ id, data, selected }: NodeProps<Node<ResultNodeData>>) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const images = useFlowStore(useShallow((s) => selectResultImages(s, id)));

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <ImageGrid images={images} empty="连接上游节点后自动汇总图片" />
        {images.length > 0 && (
          <div className="grid grid-cols-2 gap-1.5">
            {images.map((url, i) => {
              const extension = imageExtensionFromReference(url);
              return (
                <button
                  key={`${url}-${i}`}
                  type="button"
                  onClick={() => downloadImage(url, i, extension)}
                  className="nodrag rounded-md border border-[#262626] py-1 text-[10px] text-neutral-400 hover:border-gold hover:text-gold"
                >
                  {extension ? `下载 ${extension.toUpperCase()} ${i + 1}` : `下载图片 ${i + 1}`}
                </button>
              );
            })}
          </div>
        )}
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">备注</span>
          <textarea
            value={data.note ?? ""}
            onChange={(e) => updateNodeData(id, { note: e.target.value })}
            rows={2}
            placeholder="记录这一版结果的说明…"
            className={`${inputClass} resize-none`}
          />
        </label>
      </NodeFrame>
    </>
  );
}
