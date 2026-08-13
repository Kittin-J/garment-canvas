import type { NodeKind } from "@/types/workflow";

/** 节点类型 → 微缩图配色（与画布气质一致的低饱和色） */
const KIND_COLOR: Record<NodeKind, string> = {
  "image-input": "#4A90D9",
  "sketch-to-render": "#C9A66B",
  "ai-modify": "#9B72CF",
  "fabric-recolor": "#D9707E",
  upscale: "#4FA37C",
  "print-extract": "#E8935A",
  "print-mutate": "#5AA8E8",
  result: "#6E6E6E",
};

interface MiniNode {
  id: string;
  type?: string;
  position: { x: number; y: number };
}
interface MiniEdge {
  source: string;
  target: string;
}

/**
 * 工作流微缩图：直接从模板的 nodes/edges 生成 SVG 缩略 DAG，
 * 彩色节点块 + 连线，不看文字也能读出流程结构。
 */
export function WorkflowMini({
  flow,
  className,
}: {
  flow: { nodes: unknown[]; edges: unknown[] };
  className?: string;
}) {
  const nodes = flow.nodes as MiniNode[];
  const edges = flow.edges as MiniEdge[];
  if (nodes.length === 0) {
    return <div className={className} style={{ background: "#0f0f0f" }} />;
  }

  // 节点在原画布上的包围盒
  const NODE_W = 280;
  const NODE_H = 120;
  const xs = nodes.map((n) => n.position.x);
  const ys = nodes.map((n) => n.position.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs) + NODE_W;
  const maxY = Math.max(...ys) + NODE_H;
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);

  // 统一缩放到 100×60 视野内，留 10% 边距
  const VW = 100;
  const VH = 60;
  const scale = Math.min((VW * 0.84) / spanX, (VH * 0.8) / spanY);
  const offX = (VW - spanX * scale) / 2;
  const offY = (VH - spanY * scale) / 2;

  const px = (x: number) => offX + (x - minX) * scale;
  const py = (y: number) => offY + (y - minY) * scale;

  const center = new Map(
    nodes.map((n) => [
      n.id,
      { x: px(n.position.x + NODE_W / 2), y: py(n.position.y + NODE_H / 2) },
    ]),
  );

  const blockW = Math.max(NODE_W * scale * 0.85, 7);
  const blockH = Math.max(NODE_H * scale * 0.6, 5);

  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} className={className} style={{ background: "#0f0f0f" }}>
      {edges.map((e, i) => {
        const s = center.get(e.source);
        const t = center.get(e.target);
        if (!s || !t) return null;
        const midX = (s.x + t.x) / 2;
        return (
          <path
            key={i}
            d={`M ${s.x} ${s.y} C ${midX} ${s.y}, ${midX} ${t.y}, ${t.x} ${t.y}`}
            fill="none"
            stroke="#4b4b4b"
            strokeWidth={0.9}
          />
        );
      })}
      {nodes.map((n) => {
        const kind = (n.type ?? "image-input") as NodeKind;
        const c = center.get(n.id)!;
        return (
          <rect
            key={n.id}
            x={c.x - blockW / 2}
            y={c.y - blockH / 2}
            width={blockW}
            height={blockH}
            rx={1.6}
            fill={KIND_COLOR[kind] ?? "#6E6E6E"}
            opacity={0.9}
          />
        );
      })}
    </svg>
  );
}
