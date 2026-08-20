import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import { isNodeRunActive } from "@/types/workflow";

/**
 * 脉冲光点连线：金色光珠沿贝塞尔路径奔跑，指示数据流向。
 * 源头节点运行中 → 光珠更亮更快；常态 → 低调慢速。
 */
export function PulseEdge({
  id,
  source,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const running = useFlowStore(
    (s) => {
      const status = s.nodes.find((n) => n.id === source)?.data.status;
      return status ? isNodeRunActive(status) : false;
    },
  );

  const baseStroke = selected
    ? "#C9A66B"
    : running
      ? "rgba(201,166,107,0.45)"
      : "#3a3a3a";
  const dur = running ? "1.2s" : "2.8s";

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: baseStroke, strokeWidth: selected ? 2.2 : 1.8 }}
      />
      {/* 三颗追尾光珠（SMIL 沿路径运动，零 JS 开销） */}
      <circle
        r={4}
        fill="#C9A66B"
        opacity={running ? 1 : 0.5}
        style={
          running
            ? { filter: "drop-shadow(0 0 4px #C9A66B) drop-shadow(0 0 8px rgba(201,166,107,.6))" }
            : undefined
        }
      >
        <animateMotion dur={dur} repeatCount="indefinite" path={path} />
      </circle>
      <circle r={3} fill="#C9A66B" opacity={running ? 0.7 : 0.35}>
        <animateMotion dur={dur} begin="0.4s" repeatCount="indefinite" path={path} />
      </circle>
      <circle r={2.4} fill="#C9A66B" opacity={running ? 0.5 : 0.25}>
        <animateMotion dur={dur} begin="0.8s" repeatCount="indefinite" path={path} />
      </circle>
    </>
  );
}
