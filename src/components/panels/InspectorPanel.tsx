import { useFlowStore, type RecentResult } from "@/store/flowStore";
import { NODE_SPECS, isNodeRunActive, type ImageInputNodeData } from "@/types/workflow";
import { inputClass, RunButton, STATUS_TEXT } from "../nodes/NodeFrame";
import { ModelControls } from "../nodes/ModelControls";
import { thumbnailImageUrl } from "@/lib/images";
import { isImageModelId, type GenerationImageModelId, type ImageModelOptions } from "@/types/imageModels";

function PropertyEditor({ nodeId }: { nodeId: string }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId));
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const cancelNodeRun = useFlowStore((s) => s.cancelNodeRun);
  if (!node) return null;
  const d = node.data;
  const spec = NODE_SPECS[d.kind];
  const selectedModelId: GenerationImageModelId | undefined =
    "modelId" in d && isImageModelId(d.modelId) && d.modelId !== "gpt-image-2" ? d.modelId : undefined;
  const selectedModelOptions = "modelOptions" in d && typeof d.modelOptions === "object" && d.modelOptions !== null
    ? d.modelOptions as ImageModelOptions
    : undefined;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-200">{spec.title}</span>
        <span className="text-[10px] text-neutral-500">{STATUS_TEXT[d.status]}</span>
      </div>

      <label className="block space-y-1">
        <span className="text-[10px] text-neutral-500">节点名称</span>
        <input
          value={d.label}
          onChange={(e) => updateNodeData(nodeId, { label: e.target.value })}
          className={inputClass}
        />
      </label>

      {(d.kind === "sketch-to-render" || d.kind === "ai-modify" || d.kind === "fabric-recolor") && (
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">提示词</span>
          <textarea
            value={d.prompt}
            onChange={(e) => updateNodeData(nodeId, { prompt: e.target.value })}
            rows={12}
            className={`${inputClass} resize-none`}
          />
          <span className="text-[9px] text-neutral-600">可连接最多 8 张参考图，按连线顺序传入</span>
        </label>
      )}

      {d.kind === "sketch-to-render" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-[10px] text-neutral-500">画幅比例</span>
            <select
              value={d.aspectRatio}
              onChange={(e) => updateNodeData(nodeId, { aspectRatio: e.target.value })}
              className={inputClass}
            >
              {["1:1", "3:4", "4:3", "9:16", "16:9"].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className="text-[10px] text-neutral-500">生成数量</span>
            <select
              value={d.batchSize}
              onChange={(e) =>
                updateNodeData(nodeId, { batchSize: Number(e.target.value) as 1 | 2 | 4 | 8 })
              }
              className={inputClass}
            >
              {[1, 2, 4, 8].map((n) => (
                <option key={n} value={n}>
                  {n} 张
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {d.kind === "result" && (
        <label className="block space-y-1">
          <span className="text-[10px] text-neutral-500">备注</span>
          <textarea
            value={d.note ?? ""}
            onChange={(e) => updateNodeData(nodeId, { note: e.target.value })}
            rows={3}
            className={`${inputClass} resize-none`}
          />
        </label>
      )}

      {spec.providerId && d.kind !== "mask-redraw" && selectedModelId && (
        <ModelControls
          nodeId={nodeId}
          modelId={selectedModelId}
          modelOptions={selectedModelOptions}
          preferredAspectRatio={"aspectRatio" in d && typeof d.aspectRatio === "string" ? d.aspectRatio : undefined}
          disabled={isNodeRunActive(d.status)}
        />
      )}

      {spec.providerId && (
        <RunButton
          status={d.status}
          onClick={() => void runNode(nodeId)}
          onCancel={() => void cancelNodeRun(nodeId)}
          label="运行此节点"
        />
      )}
    </div>
  );
}

/** 「最近生成」条目对应的运行记录详情 */
function ResultRecordDetail({ resultId }: { resultId: string }) {
  const record = useFlowStore((s) => s.recentResults.find((r) => r.id === resultId));
  if (!record) return null;
  const time = new Date(record.startedAt).toLocaleTimeString("zh-CN", { hour12: false });
  const duration = (((record.finishedAt ?? Date.now()) - record.startedAt) / 1000).toFixed(1);
  const statusText: Record<RecentResult["status"], string> = {
    queued: "排队中",
    running: "生成中",
    retry_wait: "等待重试",
    cancel_requested: "取消请求中",
    success: "成功",
    error: "失败",
    outcome_unknown: "结果未知",
    cancelled: "已取消",
  };
  const statusColor: Record<RecentResult["status"], string> = {
    queued: "text-yellow-400",
    running: "text-blue-400",
    retry_wait: "text-amber-400",
    cancel_requested: "text-orange-400",
    success: "text-emerald-400",
    error: "text-red-400",
    outcome_unknown: "text-orange-500",
    cancelled: "text-neutral-500",
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-200">{record.nodeLabel}</span>
        <span
          className={`text-[10px] ${statusColor[record.status]}`}
        >
          {statusText[record.status]}
        </span>
      </div>

      {record.image && (
        <img
          src={record.thumbnail ?? thumbnailImageUrl(record.image)}
          loading="lazy"
          decoding="async"
          alt={record.nodeLabel}
          className="w-full rounded-md border border-[#262626] object-cover"
        />
      )}

      <dl className="space-y-1.5 text-[10px]">
        <div className="flex justify-between">
          <dt className="text-neutral-500">节点类型</dt>
          <dd className="text-neutral-300">{NODE_SPECS[record.kind].title}</dd>
        </div>
        {record.projectName && (
          <div className="flex justify-between gap-3">
            <dt className="text-neutral-500">项目</dt>
            <dd className="truncate text-neutral-300" title={record.projectName}>
              {record.projectName}
            </dd>
          </div>
        )}
        {record.model && (
          <div className="flex justify-between">
            <dt className="text-neutral-500">模型</dt>
            <dd className="font-mono text-neutral-300">{record.model}</dd>
          </div>
        )}
        {record.providerOutputSize && (
          <div className="flex justify-between">
            <dt className="text-neutral-500">上游实际尺寸</dt>
            <dd className="font-mono text-neutral-300">{record.providerOutputSize}</dd>
          </div>
        )}
        <div className="flex justify-between">
          <dt className="text-neutral-500">时间</dt>
          <dd className="text-neutral-300">
            {time} · {record.finishedAt ? "耗时" : "已等待"} {duration}s
          </dd>
        </div>
      </dl>

      {record.prompt && (
        <div className="space-y-1">
          <span className="text-[10px] text-neutral-500">提示词</span>
          <p className="rounded-md border border-[#262626] bg-[#0f0f0f] px-2 py-1.5 text-[10px] leading-relaxed text-neutral-400">
            {record.prompt}
          </p>
        </div>
      )}

      {record.error && (
        <div className="space-y-1">
          <span className="text-[10px] text-red-400/80">错误信息</span>
          <p className="rounded-md border border-red-900/50 bg-red-950/20 px-2 py-1.5 text-[10px] leading-relaxed text-red-300/90">
            {record.error}
          </p>
        </div>
      )}
    </div>
  );
}

export function InspectorPanel() {
  const selectedNodeId = useFlowStore((s) => s.selectedNodeId);
  const selectedResultId = useFlowStore((s) => s.selectedResultId);

  return (
    <aside className="gc-panel flex w-64 shrink-0 flex-col border-l border-[#262626] bg-[#141414]">
      <div className="border-b border-[#262626] px-3 py-2.5 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {selectedResultId ? "生成记录" : "属性"}
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {selectedResultId ? (
          <ResultRecordDetail resultId={selectedResultId} />
        ) : selectedNodeId ? (
          <PropertyEditor nodeId={selectedNodeId} />
        ) : (
          <p className="py-4 text-center text-[10px] text-neutral-600">
            点击画布节点查看属性，或点击底部「最近生成」查看运行记录
          </p>
        )}
      </div>
    </aside>
  );
}
