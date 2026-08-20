import { useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { selectNodeInputImages, useFlowStore } from "@/store/flowStore";
import { isNodeRunActive, type MaskRedrawNodeData } from "@/types/workflow";
import { Developing, inputClass, NodeFrame, RunButton } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { MaskEditor } from "./MaskEditor";
import { thumbnailImageUrl } from "@/lib/images";

export function MaskRedrawNode({ id, data, selected }: NodeProps<Node<MaskRedrawNodeData>>) {
  const [editing, setEditing] = useState(false);
  const updateNodeData = useFlowStore((state) => state.updateNodeData);
  const runNode = useFlowStore((state) => state.runNode);
  const cancelNodeRun = useFlowStore((state) => state.cancelNodeRun);
  const source = useFlowStore((state) => selectNodeInputImages(state, id)[0]);
  const running = isNodeRunActive(data.status);
  const staleMask = Boolean(data.mask && source && data.maskSourceRef !== source);
  const canRun = Boolean(source && data.mask && !staleMask && data.prompt.trim());

  return (
    <>
      <Handle type="target" position={Position.Left} />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <div className="flex items-center justify-between text-[10px]">
          <span className="text-neutral-500">图片模型</span>
          <span className="font-mono text-neutral-300">gpt-image-2</span>
        </div>
        {source ? (
          <img
            src={thumbnailImageUrl(source)}
            alt="蒙版原图"
            className="aspect-[4/3] w-full rounded-md border border-[#262626] object-contain"
          />
        ) : (
          <div className="flex aspect-[4/3] items-center justify-center rounded-md border border-dashed border-[#333] text-[10px] text-neutral-600">
            连接需要局部修改的图片
          </div>
        )}
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">修改说明</span>
          <textarea
            value={data.prompt}
            onChange={(event) => updateNodeData(id, { prompt: event.target.value })}
            rows={4}
            placeholder="如：将选中区域改成银色金属拉链"
            className={`${inputClass} resize-none`}
          />
        </label>
        <button
          type="button"
          onClick={() => setEditing(true)}
          disabled={!source || running}
          className="nodrag w-full rounded-md border border-[#333] px-3 py-1.5 text-xs text-neutral-300 hover:border-gold/60 hover:text-gold disabled:opacity-40"
        >
          {data.mask && !staleMask ? "编辑蒙版" : "绘制蒙版"}
        </button>
        {staleMask && <p className="text-[10px] text-orange-400">原图已变化，请重新绘制蒙版</p>}
        <RunButton
          status={data.status}
          onClick={() => void runNode(id)}
          onCancel={() => void cancelNodeRun(id)}
          label="局部重绘"
          disabled={!canRun}
        />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle type="source" position={Position.Right} />
      {editing && source && (
        <MaskEditor
          source={source}
          initialMask={data.maskSourceRef === source ? data.mask : undefined}
          onClose={() => setEditing(false)}
          onSave={(mask) => {
            updateNodeData(id, { mask, maskSourceRef: source, error: undefined });
            setEditing(false);
          }}
        />
      )}
    </>
  );
}
