import { useCallback, useEffect, useRef, useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import type { ImageInputNodeData } from "@/types/workflow";
import { thumbnailImageUrl } from "@/lib/images";
import { OPEN_ASSET_PICKER_EVENT, type AssetPickerRequest } from "@/components/AssetPickerOverlay";
import { NodeFrame, inputClass } from "./NodeFrame";

interface NormalizedUploadResponse {
  id: string;
  url: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  byteLength: number;
  normalized: true;
}

async function uploadFile(file: File): Promise<NormalizedUploadResponse> {
  const dataUrl = await readAsDataURL(file);
  const res = await fetch("/api/files", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dataUrl }),
  });
  const data = await res.json().catch(() => ({})) as Partial<NormalizedUploadResponse> & { error?: string };
  if (!res.ok) throw new Error(data.error || `上传失败 HTTP ${res.status}`);
  if (
    data.normalized !== true || typeof data.url !== "string" || !data.url ||
    (data.mimeType !== "image/png" && data.mimeType !== "image/jpeg") ||
    !Number.isInteger(data.width) || !Number.isInteger(data.height) || !Number.isInteger(data.byteLength)
  ) {
    throw new Error("服务端未完成素材标准化，请重试");
  }
  return data as NormalizedUploadResponse;
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
  const updateNodeDataInTab = useFlowStore((s) => s.updateNodeDataInTab);
  const openViewer = useFlowStore((s) => s.openViewer);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadRequestRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const openAssetPicker = useCallback(() => {
    const detail: AssetPickerRequest = { tabId: useFlowStore.getState().activeTabId, nodeId: id };
    window.dispatchEvent(new CustomEvent(OPEN_ASSET_PICKER_EVENT, { detail }));
  }, [id]);

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file || !file.type.startsWith("image/")) return;
      const requestId = ++uploadRequestRef.current;
      const tabId = useFlowStore.getState().activeTabId;
      setUploading(true);
      try {
        const upload = await uploadFile(file);
        if (
          requestId !== uploadRequestRef.current ||
          !useFlowStore.getState().tabs.some((tab) =>
            tab.id === tabId && tab.nodes.some((node) => node.id === id),
          )
        ) return;
        updateNodeDataInTab(tabId, id, { imageUrl: upload.url, status: "success", error: undefined });
      } catch (err) {
        if (requestId !== uploadRequestRef.current) return;
        const message = err instanceof Error ? err.message : String(err);
        updateNodeDataInTab(tabId, id, {
          status: "error",
          error: message || "上传失败，请重试",
        });
      } finally {
        if (requestId === uploadRequestRef.current) setUploading(false);
      }
    },
    [id, updateNodeDataInTab],
  );

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
                src={thumbnailImageUrl(data.imageUrl)}
                loading="lazy"
                decoding="async"
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
            className={`nodrag cursor-pointer rounded-md border border-dashed bg-[#0f0f0f] py-6 text-center text-[10px] leading-relaxed transition-colors ${
              dragOver
                ? "border-gold bg-gold/5 text-gold"
                : "border-[#2a2a2a] text-neutral-500 hover:border-neutral-500"
            }`}
          >
            {uploading ? "素材处理中…" : "每个上传节点仅支持 1 张图\n点击 / 拖拽 / 选中后 Ctrl+V"}
          </div>
        )}
        {!data.imageUrl && (
          <button
            type="button"
            onClick={openAssetPicker}
            className="nodrag w-full rounded-md border border-[#262626] py-1 text-[10px] text-neutral-400 hover:border-gold/60 hover:text-gold"
          >
            从素材库选择
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple={false}
          className="hidden"
          onChange={(e) => {
            void handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        {data.imageUrl && (
          <div className="nodrag flex gap-1.5">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex-1 rounded-md border border-[#262626] py-1 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
            >
              重新上传
            </button>
            <button
              type="button"
              onClick={openAssetPicker}
              className="flex-1 rounded-md border border-[#262626] py-1 text-[10px] text-neutral-400 hover:border-gold/60 hover:text-gold"
            >
              素材库
            </button>
          </div>
        )}
      </NodeFrame>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
