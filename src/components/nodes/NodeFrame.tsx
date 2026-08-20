import { useState, type ReactNode } from "react";
import { isNodeRunActive, type NodeRunStatus } from "@/types/workflow";
import { useFlowStore } from "@/store/flowStore";

const STATUS_STYLE: Record<NodeRunStatus, string> = {
  idle: "bg-neutral-500",
  queued: "bg-yellow-400",
  running: "bg-blue-400 animate-pulse",
  retry_wait: "bg-amber-400 animate-pulse",
  cancel_requested: "bg-orange-400 animate-pulse",
  success: "bg-emerald-400",
  error: "bg-red-500",
  outcome_unknown: "bg-orange-500",
  cancelled: "bg-neutral-600",
};

export const STATUS_TEXT: Record<NodeRunStatus, string> = {
  idle: "空闲",
  queued: "排队中",
  running: "运行中",
  retry_wait: "等待重试",
  cancel_requested: "取消请求中",
  success: "成功",
  error: "失败",
  outcome_unknown: "结果未知",
  cancelled: "已取消",
};

export function StatusDot({ status }: { status: NodeRunStatus }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[status]}`}
      title={STATUS_TEXT[status]}
    />
  );
}

interface NodeFrameProps {
  title: string;
  status: NodeRunStatus;
  error?: string;
  selected?: boolean;
  /** 传入 nodeId 后标题支持双击改名（回车/失焦确认，Esc 取消） */
  nodeId?: string;
  children: ReactNode;
}

/** 节点通用卡片框架：标题栏（双击改名） + 状态点 + 内容区 */
export function NodeFrame({ title, status, error, selected, nodeId, children }: NodeFrameProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const updateNodeData = useFlowStore((s) => s.updateNodeData);

  const commit = () => {
    const v = draft.trim();
    if (v && nodeId && v !== title) updateNodeData(nodeId, { label: v });
    setEditing(false);
  };

  return (
    <div
      className={`gc-node-card w-[280px] rounded-xl border bg-[#141414] shadow-xl shadow-black/40 transition-colors ${
        selected ? "border-gold" : "border-[#262626]"
      }`}
    >
      <div className="gc-node-header flex items-center gap-2 rounded-t-xl border-b border-[#262626] bg-[#1a1a1a] px-3 py-2">
        <StatusDot status={status} />
        {editing ? (
          <input
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") setEditing(false);
            }}
            className="nodrag min-w-0 flex-1 rounded border border-gold bg-[#0f0f0f] px-1.5 py-0.5 text-xs text-neutral-200 focus:outline-none"
          />
        ) : (
          <span
            className={`truncate text-xs font-medium tracking-wide text-neutral-200 ${nodeId ? "cursor-text" : ""}`}
            title={nodeId ? "双击改名" : undefined}
            onDoubleClick={
              nodeId
                ? () => {
                    setDraft(title);
                    setEditing(true);
                  }
                : undefined
            }
          >
            {title}
          </span>
        )}
      </div>
      <div className="gc-node-body space-y-3 p-3">{children}</div>
      {error && (
        <div className="mx-3 mb-3 rounded-md border border-red-900/50 bg-red-950/40 px-2 py-1.5 text-[10px] leading-relaxed text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}

interface RunButtonProps {
  status: NodeRunStatus;
  onClick: () => void;
  onCancel?: () => void;
  label?: string;
  disabled?: boolean;
}

export function RunButton({ status, onClick, onCancel, label = "运行", disabled }: RunButtonProps) {
  const active = isNodeRunActive(status);
  return (
    <div className={active && onCancel ? "grid grid-cols-[1fr_auto] gap-2" : undefined}>
      <button
        type="button"
        onClick={onClick}
        disabled={active || disabled}
        className={`nodrag w-full rounded-md px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90 disabled:cursor-not-allowed ${
          active ? "btn-running-breathe bg-[#3a3226] text-gold" : "bg-gold text-ink disabled:opacity-40"
        }`}
      >
        {active ? STATUS_TEXT[status] : label}
      </button>
      {active && onCancel && status !== "cancel_requested" && (
        <button
          type="button"
          onClick={onCancel}
          className="nodrag rounded-md border border-[#3a3226] px-2.5 text-[10px] text-neutral-400 hover:border-red-500/60 hover:text-red-400"
        >
          取消
        </button>
      )}
    </div>
  );
}

/** 方案 E「暗房显影」占位动画：节点运行期间展示在结果图片区 */
export function Developing() {
  return (
    <div className="develop-overlay nodrag h-28 w-full">
      <div className="develop-gridlines" />
      <div className="develop-scanline" />
      <span className="develop-label">显影中</span>
    </div>
  );
}

export const inputClass =
  "nodrag w-full rounded-md border border-[#262626] bg-[#0f0f0f] px-2 py-1.5 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-gold focus:outline-none";
