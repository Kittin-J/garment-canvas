import { useCallback } from "react";
import {
  ReactFlow,
  MiniMap,
  Controls,
  useReactFlow,
  type NodeMouseHandler,
} from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import { DotWaveBackground } from "./DotWaveBackground";
import { PulseEdge } from "./edges/PulseEdge";
import { nodeTypes } from "./nodes";
import { useTheme, type ThemeId } from "@/lib/theme";
import type { NodeKind } from "@/types/workflow";

export const DND_MIME = "application/garment-node";

const edgeTypes = { pulse: PulseEdge };

/** 小地图配色随主题 */
const MINIMAP_COLORS: Record<ThemeId, { bg: string; node: string; mask: string }> = {
  current: { bg: "#141414", node: "#2a2a2a", mask: "rgba(10,10,10,0.7)" },
  white: { bg: "#ffffff", node: "#d2d2d7", mask: "rgba(29,29,31,0.08)" },
  eye: { bg: "#ddeccf", node: "#98b884", mask: "rgba(48,69,43,0.15)" },
};

export function CanvasFlow() {
  const nodes = useFlowStore((s) => s.nodes);
  const edges = useFlowStore((s) => s.edges);
  const onNodesChange = useFlowStore((s) => s.onNodesChange);
  const onEdgesChange = useFlowStore((s) => s.onEdgesChange);
  const onConnect = useFlowStore((s) => s.onConnect);
  const isValidConnection = useFlowStore((s) => s.isValidConnection);
  const addNode = useFlowStore((s) => s.addNode);
  const setSelectedNodeId = useFlowStore((s) => s.setSelectedNodeId);
  const { screenToFlowPosition } = useReactFlow();
  const [theme] = useTheme();
  const minimap = MINIMAP_COLORS[theme];

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const kind = e.dataTransfer.getData(DND_MIME) as NodeKind | "";
      if (!kind) return;
      addNode(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [addNode, screenToFlowPosition],
  );

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => setSelectedNodeId(node.id),
    [setSelectedNodeId],
  );

  return (
    <div className="min-h-0 flex-1">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onNodeClick={onNodeClick}
        onPaneClick={() => setSelectedNodeId(null)}
        deleteKeyCode={["Delete", "Backspace"]}
        selectionOnDrag
        panOnDrag={[1, 2]}
        defaultViewport={{ x: 100, y: 200, zoom: 1 }}
        proOptions={{ hideAttribution: true }}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: "pulse" }}
      >
        <DotWaveBackground />
        <MiniMap
          position="bottom-right"
          bgColor={minimap.bg}
          nodeColor={minimap.node}
          maskColor={minimap.mask}
          pannable
          zoomable
        />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
