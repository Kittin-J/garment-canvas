import { useCallback, useEffect, useRef, useState } from "react";
import { ReactFlowProvider } from "@xyflow/react";
import { nanoid } from "nanoid";
import {
  mergeRecentResults, resumeRecentResults, useFlowStore, type FlowNode, type RecentResult,
} from "@/store/flowStore";
import { CanvasFlow } from "@/components/CanvasFlow";
import { TopBar } from "@/components/panels/TopBar";
import { ProjectTabs } from "@/components/panels/ProjectTabs";
import { NodeLibraryPanel } from "@/components/panels/NodeLibraryPanel";
import { InspectorPanel } from "@/components/panels/InspectorPanel";
import { ResultsPanel } from "@/components/panels/ResultsPanel";
import { TemplatesDock } from "@/components/panels/TemplatesDock";
import { CompareOverlay } from "@/components/CompareOverlay";
import { ImageViewer } from "@/components/ImageViewer";
import { AssetPickerOverlay } from "@/components/AssetPickerOverlay";
import { useAuth } from "@/auth/AuthContext";
import { ChangePasswordPage, LoginPage, SessionEndedPage } from "@/auth/LoginPage";

/** 剪贴板里的节点快照（仅内存，跨项目/刷新不保留） */
let nodeClipboard: { data: FlowNode["data"]; type: string } | null = null;

interface HistoryPage {
  records: RecentResult[];
  nextCursor: string | null;
  hasMore: boolean;
}

type MobilePanel = "library" | "inspector" | null;

function parseHistoryPage(value: unknown): HistoryPage {
  if (!value || typeof value !== "object") throw new Error("历史记录格式无效");
  const page = value as Partial<HistoryPage>;
  if (!Array.isArray(page.records) ||
      (page.nextCursor !== null && typeof page.nextCursor !== "string") ||
      typeof page.hasMore !== "boolean") {
    throw new Error("历史记录格式无效");
  }
  return { records: page.records, nextCursor: page.nextCursor ?? null, hasMore: page.hasMore };
}

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
  const { user, loading, sessionEndReason, acknowledgeSessionEnd } = useAuth();
  if (loading) {
    return <div className="flex h-full items-center justify-center bg-[#101214] text-xs text-neutral-500">正在验证登录状态…</div>;
  }
  if (sessionEndReason === "replaced") {
    return <SessionEndedPage onContinue={acknowledgeSessionEnd} />;
  }
  if (!user) return <LoginPage />;
  if (user.mustChangePassword) return <ChangePasswordPage />;
  return <Workspace />;
}

function Workspace() {
  useGlobalShortcuts();
  const activeTabId = useFlowStore((state) => state.activeTabId);
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>(null);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyPageSize = 20;
  const historyBefore = useRef(Date.now()).current;

  useEffect(() => {
    setMobilePanel(null);
  }, [activeTabId]);

  useEffect(() => {
    if (!mobilePanel) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobilePanel(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobilePanel]);

  useEffect(() => {
    let active = true;
    fetch(`/api/history?limit=${historyPageSize}&offset=0&before=${historyBefore}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      })
      .then((value) => {
        if (active) {
          const page = parseHistoryPage(value);
          useFlowStore.setState((state) => ({
            recentResults: mergeRecentResults(state.recentResults, page.records),
          }));
          resumeRecentResults(page.records);
          setHistoryCursor(page.nextCursor);
          setHistoryHasMore(page.hasMore);
        }
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  const loadMoreHistory = useCallback(async () => {
    if (historyLoading || !historyHasMore || !historyCursor) return;
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(historyPageSize), cursor: historyCursor });
      const response = await fetch(`/api/history?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const page = parseHistoryPage(await response.json());
      useFlowStore.setState((state) => {
        const existingIds = new Set(state.recentResults.map((record) => record.id));
        return {
          recentResults: [
            ...state.recentResults,
            ...page.records.filter((record) => !existingIds.has(record.id)),
          ].slice(0, 200) as never,
        };
      });
      resumeRecentResults(page.records);
      setHistoryCursor(page.nextCursor);
      setHistoryHasMore(page.hasMore);
    } catch {
      // 保留“加载更多”入口，瞬时网络错误后用户可以再次重试。
    } finally {
      setHistoryLoading(false);
    }
  }, [historyCursor, historyHasMore, historyLoading]);

  return (
    <div className="gc-app-shell flex h-full min-w-0 flex-col overflow-hidden bg-ink text-neutral-200">
      <TopBar />
      <ProjectTabs />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="gc-panel flex h-10 shrink-0 items-center border-b border-[#262626] bg-[#141414] px-2 md:hidden">
          <button
            type="button"
            aria-controls="mobile-library-panel"
            aria-expanded={mobilePanel === "library"}
            onClick={() => setMobilePanel((current) => current === "library" ? null : "library")}
            className={`rounded-md border px-3 py-1.5 text-[10px] font-medium transition-colors ${
              mobilePanel === "library"
                ? "border-gold bg-gold/10 text-gold"
                : "border-[#333] text-neutral-300"
            }`}
          >
            节点 / 素材
          </button>
          <span className="min-w-0 flex-1 truncate px-3 text-center text-[10px] text-neutral-600">
            画布
          </span>
          <button
            type="button"
            aria-controls="mobile-inspector-panel"
            aria-expanded={mobilePanel === "inspector"}
            onClick={() => setMobilePanel((current) => current === "inspector" ? null : "inspector")}
            className={`rounded-md border px-3 py-1.5 text-[10px] font-medium transition-colors ${
              mobilePanel === "inspector"
                ? "border-gold bg-gold/10 text-gold"
                : "border-[#333] text-neutral-300"
            }`}
          >
            属性
          </button>
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
          {mobilePanel && (
            <button
              type="button"
              aria-label="关闭侧栏"
              onClick={() => setMobilePanel(null)}
              className="absolute inset-0 z-20 bg-black/60 md:hidden"
            />
          )}

          <div
            id="mobile-library-panel"
            className={`absolute inset-y-0 left-0 z-30 flex transition-transform duration-200 md:static md:visible md:translate-x-0 ${
              mobilePanel === "library"
                ? "visible translate-x-0"
                : "invisible -translate-x-full"
            }`}
          >
            <NodeLibraryPanel />
          </div>

          <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
            <TemplatesDock />
            <ReactFlowProvider key={activeTabId}>
              <CanvasFlow />
            </ReactFlowProvider>
            <ResultsPanel
              hasMore={historyHasMore}
              loadingMore={historyLoading}
              onLoadMore={() => void loadMoreHistory()}
            />
          </div>

          <div
            id="mobile-inspector-panel"
            className={`absolute inset-y-0 right-0 z-30 flex transition-transform duration-200 md:static md:visible md:translate-x-0 ${
              mobilePanel === "inspector"
                ? "visible translate-x-0"
                : "invisible translate-x-full"
            }`}
          >
            <InspectorPanel />
          </div>
        </div>
      </div>
      <CompareOverlay />
      <ImageViewer />
      <AssetPickerOverlay />
    </div>
  );
}
