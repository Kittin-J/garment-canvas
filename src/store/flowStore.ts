import { create } from "zustand";
import { temporal } from "zundo";
import {
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from "@xyflow/react";
import { nanoid } from "nanoid";
import {
  NODE_SPECS,
  WORKFLOW_SCHEMA_VERSION,
  type NodeKind,
  type WorkflowNodeData,
  type NodeRunStatus,
  type ImageInputNodeData,
} from "@/types/workflow";

export type FlowNode = Node<WorkflowNodeData>;

/** 最近生成条目：生成图片 + 该次运行的完整记录（运行记录已合并到这里） */
export interface RecentResult {
  id: string;
  /** 生成图 URL；失败记录为空字符串 */
  image: string;
  nodeId: string;
  nodeLabel: string;
  kind: NodeKind;
  projectId?: string;
  projectName?: string;
  /** 后端运行 ID，用于页面刷新后恢复仍在执行的任务。 */
  runId?: string;
  prompt?: string;
  model?: string;
  startedAt: number;
  finishedAt?: number;
  status: "queued" | "running" | "success" | "error";
  error?: string;
}

type SaveState = "idle" | "saving" | "saved" | "error";

export interface ProjectTab {
  id: string;
  projectId: string;
  projectName: string;
  nodes: FlowNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  selectedResultId: string | null;
  compareIds: string[];
  saveState: SaveState;
  revision: number;
  savedRevision: number;
  dirty: boolean;
  documentEpoch: number;
}

interface FlowState {
  /** 应用内项目页签；当前页签的实时内容仍映射到下方兼容字段。 */
  tabs: ProjectTab[];
  activeTabId: string;
  projectId: string;
  projectName: string;
  nodes: FlowNode[];
  edges: Edge[];
  selectedNodeId: string | null;
  /** 底部「最近生成」中被点选的条目（右侧面板显示其运行记录） */
  selectedResultId: string | null;
  /** 最近生成（底部结果面板，含运行记录），新条目在前 */
  recentResults: RecentResult[];
  /** 对比模式：Ctrl 多选的最近生成条目 id（2~4 个），非空时显示对比浮层 */
  compareIds: string[];
  /** 全局图片查看器（单击任意图片弹出，滚轮缩放 1x~2x） */
  viewer: { url: string; title?: string; prompt?: string; meta?: string } | null;
  saveState: SaveState;
  /** 当前文档内容的单调版本号；每次可持久化内容变化都会递增。 */
  revision: number;
  /** 最近一次确认已写入服务端的版本号。 */
  savedRevision: number;
  /** 当前画布是否包含尚未确认写入服务端的修改。 */
  dirty: boolean;
  /** 每次整体载入画布递增，用来隔离旧文档的异步响应。 */
  documentEpoch: number;

  switchTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  openFlowTab: (opts: {
    projectId: string;
    projectName: string;
    nodes: FlowNode[];
    edges: Edge[];
    markDirty?: boolean;
  }) => void;
  createBlankTab: () => void;
  setProjectName: (name: string) => void;
  setSelectedNodeId: (id: string | null) => void;
  setSelectedResultId: (id: string | null) => void;
  toggleCompareId: (id: string) => void;
  clearCompare: () => void;
  openViewer: (v: { url: string; title?: string; prompt?: string; meta?: string }) => void;
  closeViewer: () => void;
  onNodesChange: (changes: NodeChange<FlowNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<Edge>[]) => void;
  onConnect: (conn: Connection) => void;
  isValidConnection: (conn: Connection | Edge) => boolean;
  addNode: (kind: NodeKind, position: { x: number; y: number }) => void;
  /** 复制/粘贴等调用方已有完整节点时，仍通过此入口维护 revision/dirty。 */
  addExistingNode: (node: FlowNode) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  updateNodeDataInTab: (tabId: string, id: string, patch: Record<string, unknown>) => void;
  setNodeStatus: (id: string, status: NodeRunStatus, error?: string) => void;
  runNode: (id: string) => Promise<void>;
  saveProject: () => Promise<void>;
  /**
   * 整组载入画布（打开项目 / 从模板新建）：
   * 替换 nodes/edges 并重置选择、对比、查看器与撤销历史。
   * 调用方决定 projectId（打开项目用原 id，模板派生用新 id）。
   */
  loadFlow: (opts: {
    projectId: string;
    projectName: string;
    nodes: FlowNode[];
    edges: Edge[];
    /** 从模板新建时为 true；打开已保存项目时保持 false。 */
    markDirty?: boolean;
  }) => void;
  undo: () => void;
  redo: () => void;
}

interface TabSaveQueue {
  promise: Promise<void>;
  queued: boolean;
}

/** 每个页签独立串行保存；切页不会使旧页签的保存响应失效。 */
const saveQueueByTab = new Map<string, TabSaveQueue>();

/** 仅屏蔽这一小段运行态/UI 写入，不暂停用户在异步任务期间产生的文档历史。 */
function withoutTemporalTracking(run: () => void): void {
  const temporalStore = useFlowStore.temporal.getState();
  const wasTracking = temporalStore.isTracking;
  if (wasTracking) temporalStore.pause();
  try {
    run();
  } finally {
    if (wasTracking) temporalStore.resume();
  }
}

/**
 * 异步运行生命周期令牌。AI 状态本身通过 setNodeStatus 直接写入，不进入 undo；
 * 不暂停整个 temporal store，确保运行期间的提示词、移动和连线仍然可以撤销。
 */
export function beginNonUndoableRun(label = "async-run"): () => void {
  void label;
  let released = false;
  return () => {
    if (released) return;
    released = true;
  };
}

/**
 * 直接执行受控的画布内容变更，并同步 revision/dirty。
 * 用于 App 等既有调用方尚未迁移到 store action 的兼容路径。
 */
export function markFlowDocumentChanged(partial: Pick<FlowState, "nodes"> | Pick<FlowState, "edges">): void {
  useFlowStore.setState((state) => ({
    ...partial,
    revision: state.revision + 1,
    dirty: true,
    saveState: state.saveState === "saving" ? "saving" : "idle",
  }));
}

function markDocumentChanged(
  set: (
    partial:
      | Partial<FlowState>
      | ((state: FlowState) => Partial<FlowState>),
  ) => unknown,
  partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>),
): void {
  set((state) => ({
    ...(typeof partial === "function" ? partial(state) : partial),
    revision: state.revision + 1,
    dirty: true,
    saveState: state.saveState === "saving" ? "saving" : "idle",
  }));
}

function defaultNodeData(kind: NodeKind): WorkflowNodeData {
  const spec = NODE_SPECS[kind];
  const base = { label: spec.title, status: "idle" as NodeRunStatus };
  switch (kind) {
    case "image-input":
      return { ...base, kind, imageRole: "default" };
    case "sketch-to-render":
      return { ...base, kind, prompt: "", aspectRatio: "3:4", batchSize: 1, outputImages: [] };
    case "ai-modify":
      return { ...base, kind, prompt: "", aspectRatio: "1:1", batchSize: 1, outputImages: [] };
    case "fabric-recolor":
      return { ...base, kind, colors: [], prompt: "", outputImages: [] };
    case "upscale":
      return { ...base, kind, imageSize: "2K", outputImages: [] };
    case "print-extract":
      return { ...base, kind, prompt: "", outputImages: [], savedAsAssets: [] };
    case "print-mutate":
      return { ...base, kind, prompt: "", count: 4, outputImages: [] };
    case "result":
      return { ...base, kind, images: [] };
  }
}

/** 从节点 data 中取它对外输出的图片 */
function nodeOutputImages(data: WorkflowNodeData): string[] {
  if (data.kind === "image-input") return data.imageUrl ? [data.imageUrl] : [];
  if (data.kind === "result") return [];
  return data.outputImages ?? [];
}

function makeStarterNode(): FlowNode {
  return {
    id: nanoid(8),
    type: "image-input",
    position: { x: 0, y: 0 },
    data: defaultNodeData("image-input"),
  };
}

type ActiveDocumentState = Pick<
  FlowState,
  | "projectId"
  | "projectName"
  | "nodes"
  | "edges"
  | "selectedNodeId"
  | "selectedResultId"
  | "compareIds"
  | "saveState"
  | "revision"
  | "savedRevision"
  | "dirty"
  | "documentEpoch"
>;

function snapshotActiveTab(state: FlowState): ProjectTab {
  return {
    id: state.activeTabId,
    projectId: state.projectId,
    projectName: state.projectName,
    nodes: state.nodes,
    edges: state.edges,
    selectedNodeId: state.selectedNodeId,
    selectedResultId: state.selectedResultId,
    compareIds: state.compareIds,
    saveState: state.saveState,
    revision: state.revision,
    savedRevision: state.savedRevision,
    dirty: state.dirty,
    documentEpoch: state.documentEpoch,
  };
}

function activeFields(tab: ProjectTab): ActiveDocumentState {
  return {
    projectId: tab.projectId,
    projectName: tab.projectName,
    nodes: tab.nodes,
    edges: tab.edges,
    selectedNodeId: tab.selectedNodeId,
    selectedResultId: tab.selectedResultId,
    compareIds: tab.compareIds,
    saveState: tab.saveState,
    revision: tab.revision,
    savedRevision: tab.savedRevision,
    dirty: tab.dirty,
    documentEpoch: tab.documentEpoch,
  };
}

function replaceTab(tabs: ProjectTab[], tab: ProjectTab): ProjectTab[] {
  return tabs.map((candidate) => (candidate.id === tab.id ? tab : candidate));
}

function documentForTab(state: FlowState, tabId: string): ProjectTab | undefined {
  return tabId === state.activeTabId
    ? snapshotActiveTab(state)
    : state.tabs.find((tab) => tab.id === tabId);
}

function patchTab(
  set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => unknown,
  tabId: string,
  patch: Partial<ProjectTab> | ((tab: ProjectTab) => Partial<ProjectTab>),
): void {
  set((state) => {
    const tab = documentForTab(state, tabId);
    if (!tab) return {};
    const changes = typeof patch === "function" ? patch(tab) : patch;
    const next = { ...tab, ...changes };
    if (state.activeTabId === tabId) return changes;
    return { tabs: replaceTab(state.tabs, next) };
  });
}

function newTab(opts?: {
  projectId?: string;
  projectName?: string;
  nodes?: FlowNode[];
  edges?: Edge[];
  markDirty?: boolean;
}): ProjectTab {
  const markDirty = opts?.markDirty ?? false;
  return {
    id: nanoid(10),
    projectId: opts?.projectId ?? nanoid(10),
    projectName: opts?.projectName ?? "未命名设计项目",
    nodes: opts?.nodes ?? [makeStarterNode()],
    edges: opts?.edges ?? [],
    selectedNodeId: null,
    selectedResultId: null,
    compareIds: [],
    saveState: "idle",
    revision: markDirty ? 1 : 0,
    savedRevision: 0,
    dirty: markDirty,
    documentEpoch: 0,
  };
}

/** 在目标页签内更新节点；目标为当前页签时同步兼容字段。 */
function updateTabNodes(
  set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => unknown,
  tabId: string,
  update: (nodes: FlowNode[]) => FlowNode[],
  opts?: { markDirty?: boolean },
): void {
  patchTab(set, tabId, (tab) => {
    const nodes = update(tab.nodes);
    if (nodes === tab.nodes) return {};
    return {
      nodes,
      revision: opts?.markDirty ? tab.revision + 1 : tab.revision,
      dirty: opts?.markDirty ? true : tab.dirty,
      saveState: opts?.markDirty && tab.saveState !== "saving" ? "idle" : tab.saveState,
    };
  });
}

type FlowTemporalState = Pick<FlowState, "nodes" | "edges">;

/** 最近生成持久化（localStorage）：刷新/重开浏览器不丢 */
const RECENT_STORAGE_KEY = "garment-canvas-recent-results";
const TAB_SESSION_STORAGE_KEY = "garment-canvas-project-tabs";

function loadTabSession(): { tabs: ProjectTab[]; activeTabId: string } | undefined {
  try {
    const raw = window.sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeTabId?: unknown };
    if (!Array.isArray(parsed.tabs) || typeof parsed.activeTabId !== "string") return undefined;
    const tabs = parsed.tabs.flatMap((value): ProjectTab[] => {
      if (!value || typeof value !== "object") return [];
      const tab = value as Partial<ProjectTab>;
      const valid =
        typeof tab.id === "string" &&
        typeof tab.projectId === "string" &&
        typeof tab.projectName === "string" &&
        Array.isArray(tab.nodes) &&
        Array.isArray(tab.edges);
      if (!valid) return [];
      return [{
        ...(tab as ProjectTab),
        // 页面刷新会中断原保存请求，不能恢复一个已不存在的 in-flight 状态。
        saveState:
          tab.saveState === "saved" || tab.saveState === "error"
            ? tab.saveState
            : "idle",
      }];
    });
    if (tabs.length === 0 || !tabs.some((tab) => tab.id === parsed.activeTabId)) return undefined;
    return { tabs, activeTabId: parsed.activeTabId };
  } catch {
    return undefined;
  }
}

function persistTabSession(state: FlowState): void {
  try {
    const current = snapshotActiveTab(state);
    window.sessionStorage.setItem(
      TAB_SESSION_STORAGE_KEY,
      JSON.stringify({ tabs: replaceTab(state.tabs, current), activeTabId: state.activeTabId }),
    );
  } catch {
    // 浏览器会话存储不可用或容量不足时退化为仅本次页面生命周期可用。
  }
}

function loadRecentResults(): RecentResult[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    return (arr as RecentResult[]).map((record) => {
      if ((record.status === "queued" || record.status === "running") && !record.runId) {
        return {
          ...record,
          status: "error" as const,
          finishedAt: now,
          error: "页面刷新发生在任务提交完成前，无法自动恢复此次生成",
        };
      }
      return record;
    });
  } catch {
    return [];
  }
}

function persistRecentResults(list: RecentResult[]): void {
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 存储不可用时静默降级
  }
}

interface RunFailure {
  prompt?: string;
  error: string;
}

export interface RunEvent {
  seq?: number;
  type: "node-status" | "done" | "run-error";
  nodeId?: string;
  status?: NodeRunStatus;
  images?: string[];
  error?: string;
  model?: string;
  prompts?: string[];
  failures?: RunFailure[];
  startedAt?: number;
  finishedAt?: number;
}

function recordPrompt(data: WorkflowNodeData): string | undefined {
  if ("prompt" in data && typeof data.prompt === "string" && data.prompt.trim()) {
    return data.prompt.trim();
  }
  return undefined;
}

/** 用一次后端事件更新点击时创建的主卡片，并为额外图片/部分失败追加卡片。 */
export function applyRunEventToRecentResults(
  records: RecentResult[],
  recordId: string,
  event: RunEvent,
): RecentResult[] {
  const current = records.find((record) => record.id === recordId);
  if (!current) return records;
  if (event.status === "queued" || event.status === "running") {
    const status = event.status;
    return records.map((record) =>
      record.id === recordId
        ? {
            ...record,
            status,
            error: event.error,
            model: event.model ?? record.model,
            startedAt: event.startedAt ?? record.startedAt,
          }
        : record,
    );
  }
  if (event.status !== "success" && event.status !== "error") return records;

  const startedAt = event.startedAt ?? current.startedAt;
  const finishedAt = event.finishedAt ?? Date.now();
  const base = {
    ...current,
    model: event.model ?? current.model,
    startedAt,
    finishedAt,
  };
  const images = event.images ?? [];
  const failures = event.failures ?? [];
  let primary: RecentResult;
  const additions: RecentResult[] = [];

  if (images.length > 0) {
    primary = {
      ...base,
      image: images[0],
      prompt: event.prompts?.[0] ?? current.prompt,
      status: "success",
      error: undefined,
    };
    for (let index = 1; index < images.length; index += 1) {
      additions.push({
        ...base,
        id: nanoid(8),
        image: images[index],
        prompt: event.prompts?.[index] ?? current.prompt,
        status: "success",
        error: undefined,
      });
    }
  } else {
    primary = {
      ...base,
      image: "",
      prompt: failures[0]?.prompt ?? current.prompt,
      status: "error",
      error: event.error || failures[0]?.error || "运行完成但未返回图片",
    };
  }

  for (const failure of failures.slice(images.length > 0 ? 0 : 1)) {
    additions.push({
      ...base,
      id: nanoid(8),
      image: "",
      prompt: failure.prompt ?? current.prompt,
      status: "error",
      error: failure.error,
    });
  }

  const next: RecentResult[] = [];
  for (const record of records) {
    if (record.id === recordId) next.push(primary, ...additions);
    else next.push(record);
  }
  return next.slice(0, 100);
}

function responseErrorMessage(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return `HTTP ${status}`;
}

/** 等待后端 DAG Run 的 SSE 终态；事件自身可重放，因此晚连接不会丢状态。 */
function consumeRunEvents(
  runId: string,
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/run-plan/${encodeURIComponent(runId)}/events`);
    const seenEvents = new Set<string>();
    // 绝对兜底上限覆盖 8 色/多批次串行重试的最坏合法耗时。
    const timeout = window.setTimeout(
      () => finish(new Error("运行状态等待超时，请稍后在项目中确认结果")),
      2 * 60 * 60 * 1000,
    );
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      source.close();
      if (error) reject(error);
      else resolve();
    };
    source.onmessage = (message) => {
      try {
        if (message.lastEventId && seenEvents.has(message.lastEventId)) return;
        if (message.lastEventId) seenEvents.add(message.lastEventId);
        const event = JSON.parse(message.data) as RunEvent;
        onEvent(event);
        if (event.type === "done") finish();
        if (event.type === "run-error") finish(new Error(event.error || "运行失败"));
      } catch {
        finish(new Error("运行事件格式无效"));
      }
    };
    source.onerror = () => {
      // 保留原生 EventSource 重连；服务端按 Last-Event-ID 只重放尚未收到的事件。
      // 超过总等待时限才失败，避免瞬时断网导致用户重复发起付费任务。
    };
  });
}

export const useFlowStore = create<FlowState>()(
  temporal<FlowState, [], [], FlowTemporalState>(
    (set, get) => {
      const restored = typeof window === "undefined" ? undefined : loadTabSession();
      const initialTab =
        restored?.tabs.find((tab) => tab.id === restored.activeTabId) ?? newTab();
      return ({
      tabs: restored?.tabs ?? [initialTab],
      activeTabId: initialTab.id,
      ...activeFields(initialTab),
      recentResults: typeof window === "undefined" ? [] : loadRecentResults(),
      viewer: null,

      switchTab: (tabId) => {
        const state = get();
        if (tabId === state.activeTabId) return;
        const target = state.tabs.find((tab) => tab.id === tabId);
        if (!target) return;
        const current = snapshotActiveTab(state);
        set({
          tabs: replaceTab(state.tabs, current),
          activeTabId: target.id,
          ...activeFields(target),
          viewer: null,
        });
        useFlowStore.temporal.getState().clear();
      },
      closeTab: (tabId) => {
        const state = get();
        const current = snapshotActiveTab(state);
        const syncedTabs = replaceTab(state.tabs, current);
        const closingIndex = syncedTabs.findIndex((tab) => tab.id === tabId);
        if (closingIndex < 0) return;
        const remaining = syncedTabs.filter((tab) => tab.id !== tabId);
        if (remaining.length === 0) remaining.push(newTab());
        if (tabId !== state.activeTabId) {
          set({ tabs: remaining });
          return;
        }
        const target = remaining[Math.min(closingIndex, remaining.length - 1)];
        set({
          tabs: remaining,
          activeTabId: target.id,
          ...activeFields(target),
          viewer: null,
        });
        useFlowStore.temporal.getState().clear();
      },
      openFlowTab: ({ projectId, projectName, nodes, edges, markDirty = false }) => {
        const state = get();
        const current = snapshotActiveTab(state);
        const syncedTabs = replaceTab(state.tabs, current);
        const existing = syncedTabs.find((tab) => tab.projectId === projectId);
        if (existing) {
          set({
            tabs: syncedTabs,
            activeTabId: existing.id,
            ...activeFields(existing),
            viewer: null,
          });
        } else {
          const tab = newTab({ projectId, projectName, nodes, edges, markDirty });
          set({
            tabs: [...syncedTabs, tab],
            activeTabId: tab.id,
            ...activeFields(tab),
            viewer: null,
          });
        }
        useFlowStore.temporal.getState().clear();
      },
      createBlankTab: () => {
        const tab = newTab();
        const state = get();
        set({
          tabs: [...replaceTab(state.tabs, snapshotActiveTab(state)), tab],
          activeTabId: tab.id,
          ...activeFields(tab),
          viewer: null,
        });
        useFlowStore.temporal.getState().clear();
      },

      setProjectName: (name) => {
        if (name === get().projectName) return;
        markDocumentChanged(set, { projectName: name });
      },
      setSelectedNodeId: (id) => set({ selectedNodeId: id, selectedResultId: null }),
      setSelectedResultId: (id) => set({ selectedResultId: id, selectedNodeId: null }),
      toggleCompareId: (id) => {
        const cur = get().compareIds;
        if (cur.includes(id)) {
          set({ compareIds: cur.filter((c) => c !== id) });
        } else if (cur.length < 4) {
          set({ compareIds: [...cur, id], selectedResultId: null, selectedNodeId: null });
        }
      },
      clearCompare: () => set({ compareIds: [] }),
      openViewer: (v) => set({ viewer: v }),
      closeViewer: () => set({ viewer: null }),

      onNodesChange: (changes) => {
        const nodes = applyNodeChanges(changes, get().nodes);
        if (nodes === get().nodes) return;
        const changesDocument = changes.some(
          (change) => change.type !== "select" && change.type !== "dimensions",
        );
        if (changesDocument) markDocumentChanged(set, { nodes });
        else withoutTemporalTracking(() => set({ nodes }));
      },
      onEdgesChange: (changes) => {
        const edges = applyEdgeChanges(changes, get().edges);
        if (edges === get().edges) return;
        const changesDocument = changes.some((change) => change.type !== "select");
        if (changesDocument) markDocumentChanged(set, { edges });
        else withoutTemporalTracking(() => set({ edges }));
      },

      isValidConnection: (conn) => {
        if (!conn.source || !conn.target || conn.source === conn.target) return false;
        const target = get().nodes.find((n) => n.id === conn.target);
        if (!target) return false;
        const spec = NODE_SPECS[target.data.kind];
        const incoming = get().edges.filter((e) => e.target === conn.target);
        if (incoming.length >= spec.inputs) return false;
        // 同一来源+同一输入口不允许重复连线
        return !incoming.some(
          (e) => e.source === conn.source && (e.targetHandle ?? null) === (conn.targetHandle ?? null),
        );
      },

      onConnect: (conn) => {
        if (!get().isValidConnection(conn)) return;
        markDocumentChanged(set, { edges: addEdge(conn, get().edges) });
      },

      addNode: (kind, position) => {
        const node: FlowNode = {
          id: nanoid(8),
          type: kind,
          position,
          data: defaultNodeData(kind),
        };
        markDocumentChanged(set, { nodes: [...get().nodes, node], selectedNodeId: node.id });
      },

      addExistingNode: (node) => {
        markDocumentChanged(set, { nodes: [...get().nodes, node], selectedNodeId: node.id });
      },

      updateNodeData: (id, patch) => {
        if (!get().nodes.some((n) => n.id === id)) return;
        markDocumentChanged(set, {
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } as WorkflowNodeData } : n,
          ),
        });
      },
      updateNodeDataInTab: (tabId, id, patch) => {
        updateTabNodes(
          set,
          tabId,
          (nodes) => {
            if (!nodes.some((node) => node.id === id)) return nodes;
            return nodes.map((node) =>
              node.id === id
                ? { ...node, data: { ...node.data, ...patch } as WorkflowNodeData }
                : node,
            );
          },
          { markDirty: true },
        );
      },

      setNodeStatus: (id, status, error) =>
        (() => {
          withoutTemporalTracking(() => {
            set({
              nodes: get().nodes.map((n) =>
                n.id === id ? { ...n, data: { ...n.data, status, error } } : n,
              ),
            });
          });
        })(),

      runNode: async (id) => {
        const initialState = get();
        const node = initialState.nodes.find((n) => n.id === id);
        if (!node || node.data.status === "running" || node.data.status === "queued") return;
        const kind = node.data.kind;
        const spec = NODE_SPECS[kind];
        if (!spec.providerId) return;

        const nodesSnapshot = initialState.nodes;
        const edgesSnapshot = initialState.edges;
        const tabId = initialState.activeTabId;
        const localStartedAt = Date.now();
        const recordId = nanoid(8);
        const releaseNonUndoableRun = beginNonUndoableRun(`run:${id}`);
        let terminalRecorded = false;

        // 先记录用户的这次生成操作，再请求后端；即使请求失败或页面刷新也不会丢记录。
        const initialRecord: RecentResult = {
          id: recordId,
          image: "",
          nodeId: id,
          nodeLabel: node.data.label,
          kind,
          projectId: initialState.projectId,
          projectName: initialState.projectName,
          prompt: recordPrompt(node.data),
          startedAt: localStartedAt,
          status: "queued",
        };
        set({
          recentResults: [
            initialRecord,
            ...initialState.recentResults,
          ].slice(0, 100),
          selectedResultId: recordId,
        });

        try {
          updateTabNodes(set, tabId, (nodes) =>
            nodes.map((candidate) =>
              candidate.id === id
                ? { ...candidate, data: { ...candidate.data, status: "queued", error: undefined } }
                : candidate,
            ),
          );
          const response = await fetch("/api/run-plan", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nodes: nodesSnapshot,
              edges: edgesSnapshot,
              onlyNodeId: id,
              includeDownstream: false,
            }),
          });
          const payload = (await response.json().catch(() => ({}))) as {
            runId?: string;
            error?: string;
          };
          if (!response.ok || !payload.runId) {
            throw new Error(responseErrorMessage(response.status, payload));
          }

          set((state) => ({
            recentResults: state.recentResults.map((record) =>
              record.id === recordId ? { ...record, runId: payload.runId } : record,
            ),
          }));

          await consumeRunEvents(payload.runId, (event) => {
            if (event.type !== "node-status" || event.nodeId !== id) return;
            set((state) => ({
              recentResults: applyRunEventToRecentResults(state.recentResults, recordId, event),
            }));
            if (event.status === "running" || event.status === "queued") {
              updateTabNodes(set, tabId, (nodes) =>
                nodes.map((candidate) =>
                  candidate.id === id
                    ? { ...candidate, data: { ...candidate.data, status: event.status!, error: event.error } }
                    : candidate,
                ),
              );
              return;
            }
            if (event.status !== "success" && event.status !== "error") return;
            terminalRecorded = true;
            updateTabNodes(
              set,
              tabId,
              (nodes) =>
                nodes.map((candidate) =>
                  candidate.id === id
                    ? {
                        ...candidate,
                        data: {
                          ...candidate.data,
                          outputImages: event.images,
                          status: event.status,
                          error: event.error,
                        } as WorkflowNodeData,
                      }
                    : candidate,
                ),
              { markDirty: Boolean(event.images?.length) },
            );
          });
        } catch (err) {
          if (!terminalRecorded) {
            const message = err instanceof Error ? err.message : String(err);
            const event: RunEvent = {
                type: "node-status",
                nodeId: id,
                status: "error",
                error: message,
                startedAt: localStartedAt,
                finishedAt: Date.now(),
              };
            set((state) => ({
              recentResults: applyRunEventToRecentResults(state.recentResults, recordId, event),
            }));
            updateTabNodes(set, tabId, (nodes) =>
              nodes.map((candidate) =>
                candidate.id === id
                  ? { ...candidate, data: { ...candidate.data, status: "error", error: message } }
                  : candidate,
              ),
            );
          }
        } finally {
          releaseNonUndoableRun();
        }
      },

      saveProject: async () => {
        const tabId = get().activeTabId;
        const existing = saveQueueByTab.get(tabId);
        if (existing) {
          existing.queued = true;
          return existing.promise;
        }

        const queue: TabSaveQueue = { promise: Promise.resolve(), queued: false };
        queue.promise = (async () => {
          do {
            queue.queued = false;
            const snapshot = documentForTab(get(), tabId);
            if (!snapshot) return;
            patchTab(set, tabId, { saveState: "saving" });
            try {
              const res = await fetch("/api/projects", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  id: snapshot.projectId,
                  name: snapshot.projectName,
                  flow: {
                    schemaVersion: WORKFLOW_SCHEMA_VERSION,
                    nodes: snapshot.nodes,
                    edges: snapshot.edges,
                  },
                }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              patchTab(set, tabId, (latest) => {
                const clean = latest.revision === snapshot.revision;
                if (!clean) queue.queued = true;
                return {
                  savedRevision: Math.max(latest.savedRevision, snapshot.revision),
                  dirty: !clean,
                  saveState: clean ? "saved" : "saving",
                };
              });
            } catch {
              queue.queued = false;
              patchTab(set, tabId, (latest) => ({
                saveState: "error",
                dirty: latest.revision !== latest.savedRevision,
              }));
            }
          } while (queue.queued);
        })();
        saveQueueByTab.set(tabId, queue);
        try {
          await queue.promise;
        } finally {
          if (saveQueueByTab.get(tabId) === queue) saveQueueByTab.delete(tabId);
        }
      },

      undo: () => {
        const before = useFlowStore.getState();
        const runtimeById = new Map(
          before.nodes.map((node) => [node.id, { status: node.data.status, error: node.data.error }]),
        );
        useFlowStore.temporal.getState().undo();
        let after = useFlowStore.getState();
        const temporalStore = useFlowStore.temporal.getState();
        const wasTracking = temporalStore.isTracking;
        if (wasTracking) temporalStore.pause();
        try {
          useFlowStore.setState({
            nodes: after.nodes.map((node) => {
              const runtime = runtimeById.get(node.id);
              return runtime
                ? { ...node, data: { ...node.data, ...runtime } as WorkflowNodeData }
                : node;
            }),
          });
        } finally {
          if (wasTracking) temporalStore.resume();
        }
        after = useFlowStore.getState();
        if (after.nodes !== before.nodes || after.edges !== before.edges) {
          useFlowStore.setState({
            revision: after.revision + 1,
            dirty: true,
            saveState: after.saveState === "saving" ? "saving" : "idle",
          });
        }
      },
      redo: () => {
        const before = useFlowStore.getState();
        const runtimeById = new Map(
          before.nodes.map((node) => [node.id, { status: node.data.status, error: node.data.error }]),
        );
        useFlowStore.temporal.getState().redo();
        let after = useFlowStore.getState();
        const temporalStore = useFlowStore.temporal.getState();
        const wasTracking = temporalStore.isTracking;
        if (wasTracking) temporalStore.pause();
        try {
          useFlowStore.setState({
            nodes: after.nodes.map((node) => {
              const runtime = runtimeById.get(node.id);
              return runtime
                ? { ...node, data: { ...node.data, ...runtime } as WorkflowNodeData }
                : node;
            }),
          });
        } finally {
          if (wasTracking) temporalStore.resume();
        }
        after = useFlowStore.getState();
        if (after.nodes !== before.nodes || after.edges !== before.edges) {
          useFlowStore.setState({
            revision: after.revision + 1,
            dirty: true,
            saveState: after.saveState === "saving" ? "saving" : "idle",
          });
        }
      },

      loadFlow: ({ projectId, projectName, nodes, edges, markDirty = false }) => {
        const state = get();
        const tab: ProjectTab = {
          ...snapshotActiveTab(state),
          projectId,
          projectName,
          nodes,
          edges,
          selectedNodeId: null,
          selectedResultId: null,
          compareIds: [],
          saveState: "idle",
          revision: markDirty ? 1 : 0,
          savedRevision: 0,
          dirty: markDirty,
          documentEpoch: state.documentEpoch + 1,
        };
        set({ tabs: replaceTab(state.tabs, tab), ...activeFields(tab), viewer: null });
        // 清空撤销历史，避免撤销回上一个项目的画布状态
        useFlowStore.temporal.getState().clear();
      },
    });
    },
    {
      limit: 50,
      partialize: (state): FlowTemporalState => ({
        nodes: state.nodes,
        edges: state.edges,
      }),
      equality: (a, b) => a.nodes === b.nodes && a.edges === b.edges,
    },
  ),
);

// 最近生成变化时写入 localStorage（仅在该字段引用变化时）
if (typeof window !== "undefined") {
  let lastRecent = useFlowStore.getState().recentResults;
  useFlowStore.subscribe((state) => {
    if (state.recentResults !== lastRecent) {
      lastRecent = state.recentResults;
      persistRecentResults(lastRecent);
    }
  });

  let lastTabSessionJson = "";
  useFlowStore.subscribe((state) => {
    const current = snapshotActiveTab(state);
    const sessionJson = JSON.stringify({
      tabs: replaceTab(state.tabs, current),
      activeTabId: state.activeTabId,
    });
    if (sessionJson === lastTabSessionJson) return;
    lastTabSessionJson = sessionJson;
    persistTabSession(state);
  });
  persistTabSession(useFlowStore.getState());

  // 当前页签内容持续同步进 tabs，保证非激活页签始终是完整快照。
  let lastActiveSnapshot = snapshotActiveTab(useFlowStore.getState());
  useFlowStore.subscribe((state) => {
    const snapshot = snapshotActiveTab(state);
    if (
      snapshot.id !== lastActiveSnapshot.id ||
      snapshot.projectId !== lastActiveSnapshot.projectId ||
      snapshot.projectName !== lastActiveSnapshot.projectName ||
      snapshot.nodes !== lastActiveSnapshot.nodes ||
      snapshot.edges !== lastActiveSnapshot.edges ||
      snapshot.selectedNodeId !== lastActiveSnapshot.selectedNodeId ||
      snapshot.selectedResultId !== lastActiveSnapshot.selectedResultId ||
      snapshot.compareIds !== lastActiveSnapshot.compareIds ||
      snapshot.saveState !== lastActiveSnapshot.saveState ||
      snapshot.revision !== lastActiveSnapshot.revision ||
      snapshot.savedRevision !== lastActiveSnapshot.savedRevision ||
      snapshot.dirty !== lastActiveSnapshot.dirty ||
      snapshot.documentEpoch !== lastActiveSnapshot.documentEpoch
    ) {
      lastActiveSnapshot = snapshot;
      const current = state.tabs.find((tab) => tab.id === snapshot.id);
      if (current && current !== snapshot) {
        useFlowStore.setState({ tabs: replaceTab(state.tabs, snapshot) });
      }
    }
  });

  const resumable = lastRecent.filter(
    (record) =>
      (record.status === "queued" || record.status === "running") && Boolean(record.runId),
  );
  for (const record of resumable) {
    void (async () => {
      let terminalRecorded = false;
      try {
        const response = await fetch(`/api/run-plan/${encodeURIComponent(record.runId!)}`);
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "服务已重启或恢复窗口已过，无法继续跟踪此任务"
              : `恢复任务失败（HTTP ${response.status}）`,
          );
        }
        await consumeRunEvents(record.runId!, (event) => {
          if (event.type !== "node-status" || event.nodeId !== record.nodeId) return;
          useFlowStore.setState((state) => ({
            recentResults: applyRunEventToRecentResults(state.recentResults, record.id, event),
          }));
          const tabId = useFlowStore
            .getState()
            .tabs.find((tab) => tab.projectId === record.projectId)?.id;
          if (tabId && event.status) {
            updateTabNodes(
              useFlowStore.setState,
              tabId,
              (nodes) =>
                nodes.map((node) =>
                  node.id === record.nodeId
                    ? {
                        ...node,
                        data: {
                          ...node.data,
                          ...(event.images?.length ? { outputImages: event.images } : {}),
                          status: event.status!,
                          error: event.error,
                        } as WorkflowNodeData,
                      }
                    : node,
                ),
              { markDirty: event.status === "success" && Boolean(event.images?.length) },
            );
          }
          if (event.status === "success" || event.status === "error") terminalRecorded = true;
        });
      } catch (error) {
        if (terminalRecorded) return;
        const message = error instanceof Error ? error.message : String(error);
        useFlowStore.setState((state) => ({
          recentResults: applyRunEventToRecentResults(state.recentResults, record.id, {
            type: "node-status",
            nodeId: record.nodeId,
            status: "error",
            error: message,
            startedAt: record.startedAt,
            finishedAt: Date.now(),
          }),
        }));
        const tabId = useFlowStore
          .getState()
          .tabs.find((tab) => tab.projectId === record.projectId)?.id;
        if (tabId) {
          updateTabNodes(useFlowStore.setState, tabId, (nodes) =>
            nodes.map((node) =>
              node.id === record.nodeId
                ? { ...node, data: { ...node.data, status: "error", error: message } }
                : node,
            ),
          );
        }
      }
    })();
  }
}

/** 读取 result 节点聚合的上游图片（直接上游） */
export function selectResultImages(state: FlowState, nodeId: string): string[] {
  const urls: string[] = [];
  for (const e of state.edges) {
    if (e.target !== nodeId) continue;
    const src = state.nodes.find((n) => n.id === e.source);
    if (src) urls.push(...nodeOutputImages(src.data));
  }
  return urls;
}
