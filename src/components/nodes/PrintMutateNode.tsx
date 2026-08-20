import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import { isNodeRunActive, type PrintMutateNodeData } from "@/types/workflow";
import { NodeFrame, RunButton, Developing, inputClass } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { ModelControls } from "./ModelControls";

const COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];

export function PrintMutateNode({ id, data, selected }: NodeProps<Node<PrintMutateNodeData>>) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const cancelNodeRun = useFlowStore((s) => s.cancelNodeRun);
  const running = isNodeRunActive(data.status);

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">裂变数量</span>
          <select
            value={data.count}
            onChange={(e) => updateNodeData(id, { count: Number(e.target.value) })}
            className={inputClass}
          >
            {COUNT_OPTIONS.map((n) => (
              <option key={n} value={n}>
                {n} 张
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">补充说明</span>
          <textarea
            value={data.prompt}
            onChange={(e) => updateNodeData(id, { prompt: e.target.value })}
            rows={3}
            placeholder="可选：如「保持花卉元素，换一种排列」"
            className={`${inputClass} resize-none`}
          />
          <span className="text-[9px] text-neutral-600">可连接 1–8 张参考图，按连线顺序传入</span>
        </label>
        <ModelControls nodeId={id} modelId={data.modelId} modelOptions={data.modelOptions} disabled={running} />
        <RunButton status={data.status} onClick={() => void runNode(id)} onCancel={() => void cancelNodeRun(id)} label="印花裂变" />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
