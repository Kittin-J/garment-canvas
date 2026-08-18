import { useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { appendSavedAsset, useFlowStore } from "@/store/flowStore";
import type { PrintExtractNodeData } from "@/types/workflow";
import { NodeFrame, RunButton, Developing, inputClass } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";

export function PrintExtractNode({ id, data, selected }: NodeProps<Node<PrintExtractNodeData>>) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const running = data.status === "running";
  const [savingUrl, setSavingUrl] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const saved = data.savedAsAssets ?? [];

  const saveAsAsset = async (url: string) => {
    setSavingUrl(url);
    setSaveError(null);
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const name = `印花素材-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const res = await fetch("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          category: "print",
          image: url,
          sourceNote: `来自节点「${data.label}」`,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const latest = useFlowStore.getState().nodes.find((node) => node.id === id)?.data;
      const current = latest?.kind === "print-extract" ? latest.savedAsAssets : undefined;
      updateNodeData(id, { savedAsAssets: appendSavedAsset(current, url) });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingUrl(null);
    }
  };

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">补充说明</span>
          <textarea
            value={data.prompt}
            onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
            rows={3}
            placeholder='可选：如"只要胸前那朵花"'
            className={`${inputClass} resize-none`}
          />
          <span className="text-[9px] text-neutral-600">可连接 1–8 张参考图，按连线顺序传入</span>
        </label>
        <RunButton running={running} onClick={() => void runNode(id)} label="提取印花" />
        {running && <Developing />}
        <ImageGrid
          images={data.outputImages}
          renderAction={(url) => {
            const isSaved = saved.includes(url);
            return (
              <button
                type="button"
                disabled={isSaved || savingUrl === url}
                onClick={() => void saveAsAsset(url)}
                className={`w-full px-1.5 py-1 text-[10px] transition-colors ${
                  isSaved
                    ? "cursor-not-allowed text-gold/70"
                    : "text-neutral-400 hover:text-gold disabled:opacity-50"
                }`}
              >
                {isSaved ? "已存素材✓" : savingUrl === url ? "保存中…" : "存为素材"}
              </button>
            );
          }}
        />
        {saveError && (
          <p className="text-[10px] text-red-400">存素材失败：{saveError}</p>
        )}
      </NodeFrame>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
