import { useEffect } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { nanoid } from "nanoid";
import { useFlowStore, type FlowNode } from "@/store/flowStore";
import { CanvasFlow } from "@/components/CanvasFlow";
import { TopBar } from "@/components/panels/TopBar";
import { ProjectTabs } from "@/components/panels/ProjectTabs";
import { NodeLibraryPanel } from "@/components/panels/NodeLibraryPanel";
import { InspectorPanel } from "@/components/panels/InspectorPanel";
import { ResultsPanel } from "@/components/panels/ResultsPanel";
import { TemplatesDock } from "@/components/panels/TemplatesDock";
import { CompareOverlay } from "@/components/CompareOverlay";
import { ImageViewer } from "@/components/ImageViewer";

/** 剪贴板里的节点快照（仅内存，跨项目/刷新不保留） */
let nodeClipboard: { data: FlowNode["data"]; type: string } | null = null;

function useGlobalShortcuts() {
  const undo = useFlowStore((s) => s.undo);
  const redo = useFlowStore((s) => s.redo);
  const saveProject = useFlowStore((s) => s.saveProject);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      // 输入框内的组合键留给原生文本编辑
      const target = e.target as HTMLElement | null;
      const inTextField =
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA");
      if (key === "s") {
        e.preventDefault();
        void saveProject();
        return;
      }
      if (inTextField) return;

      if (key === "z" && e.shiftKey) {
        e.preventDefault();
        redo();
      } else if (key === "z") {
        e.preventDefault();
        undo();
      } else if (key === "c") {
        // 复制选中节点（不带连线，避免悬空边）
        const { nodes, selectedNodeId } = useFlowStore.getState();
        const node = nodes.find((n) => n.id === selectedNodeId);
        if (node) {
          nodeClipboard = {
            data: JSON.parse(JSON.stringify(node.data)) as FlowNode["data"],
            type: node.type ?? node.data.kind,
          };
        }
      } else if (key === "v") {
        // 粘贴：在副本右侧偏移落位，状态复位
        if (!nodeClipboard) return;
        e.preventDefault();
        const { nodes } = useFlowStore.getState();
        const data = JSON.parse(JSON.stringify(nodeClipboard.data)) as FlowNode["data"];
        data.status = "idle";
        data.error = undefined;
        const anchor =
          nodes.find((n) => n.id === useFlowStore.getState().selectedNodeId) ??
          nodes[nodes.length - 1];
        const position = anchor
          ? { x: anchor.position.x + 40, y: anchor.position.y + 40 }
          : { x: 0, y: 0 };
        const id = nanoid(8);
        const newNode: FlowNode = {
          id,
          type: nodeClipboard.type,
          position,
          data,
        };
        useFlowStore.getState().addExistingNode(newNode);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [undo, redo, saveProject]);
}

export default function App() {
  useGlobalShortcuts();
  const activeTabId = useFlowStore((state) => state.activeTabId);

  return (
    <div className="flex h-full flex-col bg-ink text-neutral-200">
      <TopBar />
      <ProjectTabs />
      <ReactFlowProvider key={activeTabId}>
        <div className="flex min-h-0 flex-1">
          <NodeLibraryPanel />
          <div className="relative flex min-w-0 flex-1 flex-col">
            <TemplatesDock />
            <CanvasFlow />
            <ResultsPanel />
          </div>
          <InspectorPanel />
        </div>
        <CompareOverlay />
        <ImageViewer />
      </ReactFlowProvider>
    </div>
  );
}
