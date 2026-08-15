import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import type { UpscaleNodeData } from "@/types/workflow";
import { NodeFrame, RunButton, Developing } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";

const IMAGE_SIZES = [
  { value: "2K", label: "2K · 长边 2048" },
  { value: "4K", label: "4K · 长边 4096" },
] as const;

export function UpscaleNode({ id, data, selected }: NodeProps<Node<UpscaleNodeData>>) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const running = data.status === "running";

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <div className="space-y-1">
          <span className="text-[10px] text-neutral-500">放大档位</span>
          <div className="grid grid-cols-2 gap-2">
            {IMAGE_SIZES.map(({ value, label }) => {
              const active = data.imageSize === value;
              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => updateNodeData(id, { imageSize: value })}
                  className={`nodrag rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "border-gold bg-gold/10 text-gold"
                      : "border-[#262626] bg-[#0f0f0f] text-neutral-400 hover:border-gold/50"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
        <RunButton running={running} onClick={() => void runNode(id)} label="高清放大" />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
