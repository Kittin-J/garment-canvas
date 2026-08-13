import { useCallback, useEffect, useState } from "react";
import { NODE_SPECS, type Asset, type NodeKind } from "@/types/workflow";
import { useFlowStore } from "@/store/flowStore";
import { DND_MIME } from "../CanvasFlow";

const KIND_ORDER: NodeKind[] = [
  "image-input",
  "sketch-to-render",
  "ai-modify",
  "fabric-recolor",
  "upscale",
  "print-extract",
  "print-mutate",
  "result",
];

type Tab = "nodes" | "assets";

export function NodeLibraryPanel() {
  const [tab, setTab] = useState<Tab>("nodes");

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-[#262626] bg-[#141414]">
      <div className="flex border-b border-[#262626]">
        {(
          [
            ["nodes", "节点库"],
            ["assets", "素材库"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`flex-1 px-3 py-2.5 text-[10px] font-medium uppercase tracking-widest transition-colors ${
              tab === key
                ? "border-b border-gold text-gold"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "nodes" && <NodeList />}
      {tab === "assets" && <AssetList />}
      {tab === "nodes" && (
        <div className="border-t border-[#262626] px-3 py-2 text-[10px] leading-relaxed text-neutral-600">
          拖拽节点到画布
          <br />
          左键框选 · 中/右键平移 · Delete 删除
        </div>
      )}
    </aside>
  );
}

function NodeList() {
  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-3">
      {KIND_ORDER.map((kind) => {
        const spec = NODE_SPECS[kind];
        return (
          <div
            key={kind}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_MIME, kind);
              e.dataTransfer.effectAllowed = "move";
            }}
            className="cursor-grab select-none rounded-lg border border-[#262626] bg-[#1a1a1a] p-2.5 transition-colors hover:border-gold/60 active:cursor-grabbing"
          >
            <div className="text-xs font-medium text-neutral-200">{spec.title}</div>
            <div className="mt-1 text-[10px] leading-relaxed text-neutral-500">
              {spec.description}
            </div>
          </div>
        );
      })}
    </div>
  );
}

const CATEGORY_STYLE: Record<Asset["category"], { label: string; className: string }> = {
  print: { label: "印花", className: "border-gold/40 text-gold" },
  fabric: { label: "面料", className: "border-blue-400/40 text-blue-400" },
  reference: { label: "参考", className: "border-neutral-600 text-neutral-400" },
};

function AssetList() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/assets");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAssets((await res.json()) as Asset[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 点击素材：在最左侧节点左边新增一个 image-input 节点并灌入图片 */
  const addToCanvas = (asset: Asset) => {
    const { nodes, addNode, updateNodeData } = useFlowStore.getState();
    const minX = Math.min(0, ...nodes.map((n) => n.position.x));
    addNode("image-input", { x: minX - 320, y: nodes.length * 40 });
    const newId = useFlowStore.getState().selectedNodeId;
    if (newId) {
      updateNodeData(newId, { imageUrl: asset.image, status: "success", label: asset.name });
    }
  };

  const removeAsset = async (asset: Asset) => {
    try {
      const res = await fetch(`/api/assets/${asset.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAssets((list) => list.filter((a) => a.id !== asset.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (loading) {
    return <p className="flex-1 py-4 text-center text-[10px] text-neutral-600">加载中…</p>;
  }
  if (error && assets.length === 0) {
    return (
      <div className="flex-1 py-4 text-center">
        <p className="text-[10px] text-neutral-600">素材服务暂不可用（{error}）</p>
        <button
          type="button"
          onClick={() => void load()}
          className="mt-2 rounded border border-[#262626] px-2 py-1 text-[10px] text-neutral-400 hover:border-gold/50 hover:text-gold"
        >
          重试
        </button>
      </div>
    );
  }
  if (assets.length === 0) {
    return (
      <p className="flex-1 py-4 text-center text-[10px] text-neutral-600">
        暂无素材，可在印花提取节点中「存为素材」
      </p>
    );
  }

  return (
    <div className="flex-1 space-y-2 overflow-y-auto p-3">
      {assets.map((asset) => {
        const cat = CATEGORY_STYLE[asset.category];
        return (
          <div
            key={asset.id}
            className="rounded-lg border border-[#262626] bg-[#1a1a1a] p-2.5"
          >
            <button
              type="button"
              onClick={() => addToCanvas(asset)}
              title="点击添加到画布"
              className="block w-full overflow-hidden rounded-md border border-[#262626] bg-[#0f0f0f] transition-colors hover:border-gold/60"
            >
              <img
                src={asset.image}
                alt={asset.name}
                className="aspect-square w-full object-cover"
              />
            </button>
            <div className="mt-1.5 flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-neutral-200">{asset.name}</span>
              <span className={`shrink-0 rounded border px-1 py-px text-[9px] ${cat.className}`}>
                {cat.label}
              </span>
            </div>
            {asset.sourceNote && (
              <div className="mt-1 truncate text-[10px] text-neutral-600">{asset.sourceNote}</div>
            )}
            <div className="mt-2 flex gap-1.5">
              <button
                type="button"
                onClick={() => addToCanvas(asset)}
                className="flex-1 rounded border border-[#262626] px-1.5 py-1 text-[10px] text-neutral-300 transition-colors hover:border-gold/60 hover:text-gold"
              >
                添加到画布
              </button>
              <button
                type="button"
                onClick={() => void removeAsset(asset)}
                className="rounded border border-[#262626] px-1.5 py-1 text-[10px] text-neutral-500 transition-colors hover:border-red-900 hover:text-red-400"
              >
                删除
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

