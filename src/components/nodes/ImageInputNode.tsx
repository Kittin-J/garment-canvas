import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import type { ImageInputNodeData } from "@/types/workflow";
import { NodeFrame, inputClass } from "./NodeFrame";

async function uploadFile(file: File): Promise<string> {
  const dataUrl = await readAsDataURL(file);
  const res = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  const data = (await res.json()) as { url: string };
  return data.url;
}

function readAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ImageInputNode({ id, data, selected }: NodeProps<Node<ImageInputNodeData>>) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const setNodeStatus = useFlowStore((s) => s.setNodeStatus);
  const openViewer = useFlowStore((s) => s.openViewer);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRequestRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file || !file.type.startsWith("image/")) return;
      const requestId = ++uploadRequestRef.current;
      const documentEpoch = useFlowStore.getState().documentEpoch;
      setUploading(true);
      try {
        const url = await uploadFile(file);
        if (
          requestId !== uploadRequestRef.current ||
          useFlowStore.getState().documentEpoch !== documentEpoch ||
          !useFlowStore.getState().nodes.some((node) => node.id === id)
        ) return;
        updateNodeData(id, { imageUrl: url, status: "success", error: undefined });
      } catch (err) {
        if (
          requestId !== uploadRequestRef.current ||
          useFlowStore.getState().documentEpoch !== documentEpoch
        ) return;
        const message = err instanceof Error ? err.message : String(err);
        setNodeStatus(id, "error", message || "上传失败，请重试");
      } finally {
        if (requestId === uploadRequestRef.current) setUploading(false);
      }
    },
    [id, setNodeStatus, updateNodeData],
  );

  useEffect(() => () => {
    uploadRequestRef.current += 1;
  }, []);

  // Ctrl+V 粘贴（节点被选中时生效）
  useEffect(() => {
    if (!selected) return;
    const onPaste = (e: ClipboardEvent) => {
      const file = Array.from(e.clipboardData?.files ?? []).find((f) =>
        f.type.startsWith("image/"),
      );
      if (file) {
        e.preventDefault();
        void handleFile(file);
      }
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [selected, handleFile]);

  return (
    <>
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        {data.imageUrl ? (
          <div className="nodrag overflow-hidden rounded-md border border-[#262626]">
            <button
              type="button"
              className="block w-full cursor-zoom-in"
              title="单击查看大图"
              onClick={() => openViewer({ url: data.imageUrl!, title: data.label })}
            >
              <img
                src={data.imageUrl}
                alt="已上传图片"
                className="max-h-40 w-full object-contain bg-[#0f0f0f]"
              />
            </button>
          </div>
        ) : (
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void handleFile(e.dataTransfer.files?.[0]);
            }}
            className={`nodrag cursor-pointer rounded-md border border-dashed py-6 text-center text-[10px] leading-relaxed transition-colors ${
              dragOver
                ? "border-gold bg-gold/5 text-gold"
                : "border-[#2a2a2a] text-neutral-500 hover:border-neutral-500"
            }`}
          >
            {uploading ? "上传中…" : "点击上传 / 拖拽图片到此处\n选中节点后 Ctrl+V 粘贴"}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {data.imageUrl && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="nodrag w-full rounded-md border border-[#262626] py-1 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
          >
            重新上传
          </button>
        )}
      </NodeFrame>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
