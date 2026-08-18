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
  /** 列表预览图；打开详情和继续生成仍使用 image 原图。 */
  thumbnail?: string;
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
  ownerId?: string;
  ownerName?: string;
  requestedCount?: number;
  successfulCount?: number;
  providerRequests?: number;
  parameters?: Record<string, unknown>;
  referenceImages?: string[];
}

type SaveState = "idle" | "saving" | "saved" | "error";

export interface ProjectTab {
  id: string;
  projectId: string;
  projectName: string;
  readOnly: boolean;
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
  readOnly: boolean;
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
    readOnly?: boolean;
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

/** 历史分页可能重叠；同一后端 Run 同一时刻只允许一条恢复连接。 */
const resumingRecentRunIds = new Set<string>();

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
  | "readOnly"
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
    readOnly: state.readOnly,
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
    readOnly: tab.readOnly,
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
  readOnly?: boolean;
}): ProjectTab {
  const markDirty = opts?.markDirty ?? false;
  return {
    id: nanoid(10),
    projectId: opts?.projectId ?? nanoid(10),
    projectName: opts?.projectName ?? "未命名设计项目",
    readOnly: opts?.readOnly ?? false,
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
export const TAB_SESSION_SCHEMA_VERSION = 1 as const;

interface PersistedTabSession {
  schemaVersion: typeof TAB_SESSION_SCHEMA_VERSION;
  tabs: ProjectTab[];
  activeTabId: string;
}

const NODE_KINDS = new Set<NodeKind>(Object.keys(NODE_SPECS) as NodeKind[]);
const NODE_STATUSES = new Set<NodeRunStatus>(["idle", "queued", "running", "success", "error"]);

function finiteNonNegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringList(value: unknown, max = 100): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, max)
    : [];
}

/**
 * 会话缓存属于浏览器易失数据：逐节点容错迁移，坏节点/悬空边单独丢弃，
 * 不让一个历史字段缺失导致所有项目页签都无法恢复。
 */
function normalizeSessionNode(value: unknown): FlowNode | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" ||
    !raw.id ||
    typeof raw.type !== "string" ||
    !NODE_KINDS.has(raw.type as NodeKind) ||
    !raw.position ||
    typeof raw.position !== "object" ||
    !raw.data ||
    typeof raw.data !== "object"
  ) return undefined;
  const position = raw.position as Record<string, unknown>;
  if (
    typeof position.x !== "number" || !Number.isFinite(position.x) ||
    typeof position.y !== "number" || !Number.isFinite(position.y)
  ) return undefined;

  const kind = raw.type as NodeKind;
  const input = raw.data as Record<string, unknown>;
  const defaults = defaultNodeData(kind) as unknown as Record<string, unknown>;
  const status = typeof input.status === "string" && NODE_STATUSES.has(input.status as NodeRunStatus)
    ? input.status as NodeRunStatus
    : "idle";
  const data: Record<string, unknown> = {
    ...defaults,
    ...input,
    kind,
    label: typeof input.label === "string" && input.label.trim() ? input.label : defaults.label,
    status,
  };
  if (typeof input.error !== "string") delete data.error;

  switch (kind) {
    case "image-input":
      data.imageRole = typeof input.imageRole === "string" && ["default", "sketch", "garment", "fabric", "reference"].includes(input.imageRole)
        ? input.imageRole
        : "default";
      if (typeof input.imageUrl !== "string") delete data.imageUrl;
      break;
    case "sketch-to-render":
    case "ai-modify":
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.aspectRatio = typeof input.aspectRatio === "string" && ["1:1", "3:4", "4:3", "9:16", "16:9"].includes(input.aspectRatio)
        ? input.aspectRatio
        : kind === "sketch-to-render" ? "3:4" : "1:1";
      data.batchSize = [1, 2, 4, 8].includes(Number(input.batchSize)) ? Number(input.batchSize) : 1;
      data.outputImages = stringList(input.outputImages);
      break;
    case "fabric-recolor":
      data.colors = stringList(input.colors, 8).filter((color) => /^#[0-9a-fA-F]{6}$/.test(color));
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.outputImages = stringList(input.outputImages);
      if (typeof input.fabricImageUrl !== "string") delete data.fabricImageUrl;
      break;
    case "upscale":
      data.imageSize = input.imageSize === "4K" ? "4K" : "2K";
      data.outputImages = stringList(input.outputImages);
      break;
    case "print-extract":
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.outputImages = stringList(input.outputImages);
      data.savedAsAssets = stringList(input.savedAsAssets);
      break;
    case "print-mutate":
      data.prompt = typeof input.prompt === "string" ? input.prompt : "";
      data.count = Number.isInteger(input.count) && Number(input.count) >= 1 && Number(input.count) <= 8
        ? input.count
        : 4;
      data.outputImages = stringList(input.outputImages);
      break;
    case "result":
      data.images = stringList(input.images);
      if (typeof input.note !== "string") delete data.note;
      break;
  }

  return {
    ...raw,
    id: raw.id,
    type: kind,
    position: { x: position.x, y: position.y },
    data: data as unknown as WorkflowNodeData,
  } as FlowNode;
}

function normalizeSessionEdge(value: unknown, nodeIds: Set<string>): Edge | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.id !== "string" || !raw.id ||
    typeof raw.source !== "string" || !nodeIds.has(raw.source) ||
    typeof raw.target !== "string" || !nodeIds.has(raw.target)
  ) return undefined;
  return { ...raw, id: raw.id, source: raw.source, target: raw.target } as Edge;
}

function normalizeSessionTab(value: unknown): ProjectTab | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<ProjectTab>;
  if (
    typeof raw.id !== "string" || !raw.id ||
    typeof raw.projectId !== "string" || !raw.projectId ||
    typeof raw.projectName !== "string" ||
    !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)
  ) return undefined;

  const seenNodeIds = new Set<string>();
  const nodes = raw.nodes.flatMap((node): FlowNode[] => {
    const normalized = normalizeSessionNode(node);
    if (!normalized || seenNodeIds.has(normalized.id)) return [];
    seenNodeIds.add(normalized.id);
    return [normalized];
  });
  // 一个原本非空的页签若没有任何节点能迁移，说明其结构整体不可恢复。
  if (raw.nodes.length > 0 && nodes.length === 0) return undefined;
  const seenEdgeIds = new Set<string>();
  const edges = raw.edges.flatMap((edge): Edge[] => {
    const normalized = normalizeSessionEdge(edge, seenNodeIds);
    if (!normalized || seenEdgeIds.has(normalized.id)) return [];
    seenEdgeIds.add(normalized.id);
    return [normalized];
  });
  const revision = finiteNonNegative(raw.revision, 0);
  const wasSaving = raw.saveState === "saving";
  const dirty = wasSaving || raw.dirty === true;
  const savedRevision = Math.min(finiteNonNegative(raw.savedRevision, 0), revision);

  return {
    id: raw.id,
    projectId: raw.projectId,
    projectName: raw.projectName,
    readOnly: raw.readOnly === true,
    nodes,
    edges,
    selectedNodeId: typeof raw.selectedNodeId === "string" && seenNodeIds.has(raw.selectedNodeId)
      ? raw.selectedNodeId
      : null,
    selectedResultId: typeof raw.selectedResultId === "string" ? raw.selectedResultId : null,
    compareIds: stringList(raw.compareIds, 4),
    // 刷新会中断 in-flight 请求；必须恢复成可再次保存，同时保守地视为未保存。
    saveState: raw.saveState === "saved" || raw.saveState === "error" ? raw.saveState : "idle",
    revision,
    savedRevision,
    dirty,
    documentEpoch: finiteNonNegative(raw.documentEpoch, 0),
  };
}

export function normalizeTabSessionValue(value: unknown): PersistedTabSession | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as { schemaVersion?: unknown; tabs?: unknown; activeTabId?: unknown };
  if (
    raw.schemaVersion !== undefined &&
    raw.schemaVersion !== 0 &&
    raw.schemaVersion !== TAB_SESSION_SCHEMA_VERSION
  ) return undefined;
  if (!Array.isArray(raw.tabs) || typeof raw.activeTabId !== "string") return undefined;
  const tabs = raw.tabs.flatMap((tab): ProjectTab[] => {
    const normalized = normalizeSessionTab(tab);
    return normalized ? [normalized] : [];
  });
  if (tabs.length === 0) return undefined;
  const activeTabId = tabs.some((tab) => tab.id === raw.activeTabId) ? raw.activeTabId : tabs[0].id;
  return { schemaVersion: TAB_SESSION_SCHEMA_VERSION, tabs, activeTabId };
}

function loadTabSession(): { tabs: ProjectTab[]; activeTabId: string } | undefined {
  try {
    const raw = window.sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    if (!raw) return undefined;
    return normalizeTabSessionValue(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function persistTabSession(state: FlowState): void {
  try {
    const current = snapshotActiveTab(state);
    const normalized = normalizeTabSessionValue({
      schemaVersion: TAB_SESSION_SCHEMA_VERSION,
      tabs: replaceTab(state.tabs, current),
      activeTabId: state.activeTabId,
    });
    if (!normalized) return;
    window.sessionStorage.setItem(
      TAB_SESSION_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // 浏览器会话存储不可用或容量不足时退化为仅本次页面生命周期可用。
  }
}

/** 错误边界恢复：只丢弃当前损坏页签，其他页签与服务端项目都不受影响。 */
export function discardActiveTabSession(): void {
  if (typeof window === "undefined") return;
  try {
    const raw = window.sessionStorage.getItem(TAB_SESSION_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as { tabs?: unknown; activeTabId?: unknown };
    if (!Array.isArray(parsed.tabs) || typeof parsed.activeTabId !== "string") {
      window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
      return;
    }
    const activeIndex = parsed.tabs.findIndex(
      (value) => Boolean(value && typeof value === "object" && (value as { id?: unknown }).id === parsed.activeTabId),
    );
    const remaining = parsed.tabs.filter(
      (value) => !(value && typeof value === "object" && (value as { id?: unknown }).id === parsed.activeTabId),
    );
    if (remaining.length === 0) {
      window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
      return;
    }
    const fallbackIndex = Math.max(0, Math.min(activeIndex, remaining.length - 1));
    const fallback = remaining[fallbackIndex] as { id?: unknown };
    if (typeof fallback.id !== "string") {
      window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(
      TAB_SESSION_STORAGE_KEY,
      JSON.stringify({ tabs: remaining, activeTabId: fallback.id }),
    );
  } catch {
    window.sessionStorage.removeItem(TAB_SESSION_STORAGE_KEY);
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

interface RunEventMeta {
  seq?: number;
  error?: string;
  model?: string;
  prompts?: string[];
  failures?: RunFailure[];
  startedAt?: number;
  finishedAt?: number;
}

export type NodeStatusRunEvent =
  | (RunEventMeta & {
      type: "node-status";
      nodeId: string;
      status: "queued" | "running";
      images?: never;
    })
  | (RunEventMeta & {
      type: "node-status";
      nodeId: string;
      status: "success";
      /** 成功事件在客户端归一化后始终包含数组。 */
      images: string[];
    })
  | (Omit<RunEventMeta, "error"> & {
      type: "node-status";
      nodeId: string;
      status: "error";
      error: string;
      images?: never;
    });

export type RunEvent =
  | NodeStatusRunEvent
  | { seq?: number; type: "done" }
  | { seq?: number; type: "run-error"; nodeId?: string; error: string; finishedAt?: number };

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function runFailures(value: unknown): RunFailure[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const failures = value.flatMap((item): RunFailure[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as { prompt?: unknown; error?: unknown };
    const error = optionalString(candidate.error);
    if (!error) return [];
    return [{ error, ...(optionalString(candidate.prompt) ? { prompt: optionalString(candidate.prompt) } : {}) }];
  });
  return failures.length ? failures : undefined;
}

/** SSE 数据不可信：在进入状态层前归一为判别联合，缺失图片永远不会写成 undefined。 */
export function normalizeRunEvent(value: unknown): RunEvent {
  if (!value || typeof value !== "object") throw new Error("运行事件格式无效");
  const raw = value as Record<string, unknown>;
  const seq = optionalFiniteNumber(raw.seq);
  if (raw.type === "done") return { type: "done", ...(seq !== undefined ? { seq } : {}) };
  if (raw.type === "run-error") {
    return {
      type: "run-error",
      error: optionalString(raw.error) ?? "运行失败",
      ...(optionalString(raw.nodeId) ? { nodeId: optionalString(raw.nodeId) } : {}),
      ...(optionalFiniteNumber(raw.finishedAt) !== undefined ? { finishedAt: optionalFiniteNumber(raw.finishedAt) } : {}),
      ...(seq !== undefined ? { seq } : {}),
    };
  }
  if (raw.type !== "node-status") throw new Error("运行事件类型无效");
  const nodeId = optionalString(raw.nodeId);
  if (!nodeId) throw new Error("运行事件缺少节点标识");
  const common: RunEventMeta = {
    ...(seq !== undefined ? { seq } : {}),
    ...(optionalString(raw.error) ? { error: optionalString(raw.error) } : {}),
    ...(optionalString(raw.model) ? { model: optionalString(raw.model) } : {}),
    ...(stringArray(raw.prompts) ? { prompts: stringArray(raw.prompts) } : {}),
    ...(runFailures(raw.failures) ? { failures: runFailures(raw.failures) } : {}),
    ...(optionalFiniteNumber(raw.startedAt) !== undefined ? { startedAt: optionalFiniteNumber(raw.startedAt) } : {}),
    ...(optionalFiniteNumber(raw.finishedAt) !== undefined ? { finishedAt: optionalFiniteNumber(raw.finishedAt) } : {}),
  };
  if (raw.status === "success") {
    return { ...common, type: "node-status", nodeId, status: "success", images: stringArray(raw.images) ?? [] };
  }
  if (raw.status === "error") {
    const { error: commonError, ...meta } = common;
    return { ...meta, type: "node-status", nodeId, status: "error", error: commonError ?? "生成失败" };
  }
  if (raw.status === "queued" || raw.status === "running") {
    return { ...common, type: "node-status", nodeId, status: raw.status };
  }
  throw new Error("运行事件状态无效");
}

/** 单一节点回写规则：失败保留旧图片，只有成功事件可以替换 outputImages。 */
export function applyRunEventToNode(
  data: WorkflowNodeData,
  event: NodeStatusRunEvent,
): WorkflowNodeData {
  if (event.status === "success") {
    return {
      ...data,
      ...(data.kind !== "image-input" && data.kind !== "result" ? { outputImages: event.images } : {}),
      status: "success",
      error: event.error,
    } as WorkflowNodeData;
  }
  return {
    ...data,
    status: event.status,
    error: event.error,
  } as WorkflowNodeData;
}

function recordPrompt(data: WorkflowNodeData): string | undefined {
  if ("prompt" in data && typeof data.prompt === "string" && data.prompt.trim()) {
    return data.prompt.trim();
  }
  return undefined;
}

export function requestedResultCount(data: WorkflowNodeData): number {
  switch (data.kind) {
    case "sketch-to-render":
    case "ai-modify":
      return Math.max(1, Math.min(4, Number(data.batchSize) || 1));
    case "print-mutate":
      return Math.max(1, Math.min(8, Number(data.count) || 1));
    case "fabric-recolor":
      return Math.max(1, Math.min(8, data.colors.length || 1));
    default:
      return 1;
  }
}

function pendingResultCardId(recordId: string, index: number): string {
  return `${recordId}:pending:${index}`;
}

export function createQueuedResultCards(initial: RecentResult, count: number): RecentResult[] {
  const requestedCount = Math.max(1, Math.min(8, Math.floor(count) || 1));
  return Array.from({ length: requestedCount }, (_, index) => ({
    ...initial,
    id: index === 0 ? initial.id : pendingResultCardId(initial.id, index),
    requestedCount,
  }));
}

function terminalResultCardId(recordId: string, kind: "image" | "failure", index: number): string {
  return `${recordId}:terminal:${kind}:${index}`;
}

/** 用一次后端事件更新点击时创建的主卡片，并为额外图片/部分失败追加卡片。 */
export function applyRunEventToRecentResults(
  records: RecentResult[],
  recordId: string,
  event: RunEvent,
): RecentResult[] {
  if (event.type !== "node-status") return records;
  const current = records.find((record) => record.id === recordId);
  if (!current) return records;
  const pendingPrefix = `${recordId}:pending:`;
  const terminalPrefix = `${recordId}:terminal:`;
  const isBatchSibling = (record: RecentResult) =>
    record.id === recordId ||
    record.id.startsWith(pendingPrefix) ||
    record.id.startsWith(terminalPrefix) ||
    (Boolean(current.runId) && record.runId === current.runId);
  if (event.status === "queued" || event.status === "running") {
    const status = event.status;
    return records.map((record) =>
      isBatchSibling(record)
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
  const targetCount = Math.max(1, Math.min(8,
    current.requestedCount ?? Math.max(images.length + failures.length, 1),
  ));
  const terminalCards: RecentResult[] = [];

  for (let index = 0; index < Math.min(images.length, targetCount); index += 1) {
    terminalCards.push({
      ...base,
      id: index === 0 ? recordId : terminalResultCardId(recordId, "image", index),
      image: images[index],
      thumbnail: undefined,
      prompt: event.prompts?.[index] ?? current.prompt,
      status: "success",
      error: undefined,
    });
  }

  let failureIndex = 0;
  while (terminalCards.length < targetCount) {
    const failure = failures[failureIndex];
    const cardIndex = terminalCards.length;
    terminalCards.push({
      ...base,
      id: cardIndex === 0 ? recordId : terminalResultCardId(recordId, "failure", failureIndex),
      image: "",
      thumbnail: undefined,
      prompt: failure?.prompt ?? current.prompt,
      status: "error",
      error: failure?.error || event.error || (images.length > 0 ? "未返回图片" : "运行完成但未返回图片"),
    });
    failureIndex += 1;
  }

  const next: RecentResult[] = [];
  let inserted = false;
  for (const record of records) {
    if (isBatchSibling(record)) {
      if (!inserted) {
        next.push(...terminalCards);
        inserted = true;
      }
      continue;
    }
    next.push(record);
  }
  return next.slice(0, 100);
}

/** 合并服务器历史与请求期间新增的本地记录；同 id 以服务器终态为准。 */
export function mergeRecentResults(
  current: RecentResult[],
  incoming: RecentResult[],
  limit = 200,
): RecentResult[] {
  const incomingById = new Map(incoming.map((record) => [record.id, record]));
  const currentIds = new Set(current.map((record) => record.id));
  return [
    ...current.map((record) => incomingById.get(record.id) ?? record),
    ...incoming.filter((record) => !currentIds.has(record.id)),
  ].slice(0, limit);
}

export function appendSavedAsset(current: string[] | undefined, url: string): string[] {
  const existing = current ?? [];
  return existing.includes(url) ? existing : [...existing, url];
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
  targetNodeId: string,
  onEvent: (event: RunEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const source = new EventSource(`/api/run-plan/${encodeURIComponent(runId)}/events`);
    const seenEvents = new Set<string>();
    let lastSeq = 0;
    let targetTerminalSeen = false;
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
        const event = normalizeRunEvent(JSON.parse(message.data) as unknown);
        if (event.seq !== undefined && event.seq <= lastSeq) return;
        if (message.lastEventId) seenEvents.add(message.lastEventId);
        if (event.seq !== undefined) lastSeq = event.seq;
        onEvent(event);
        if (
          event.type === "node-status" &&
          event.nodeId === targetNodeId &&
          (event.status === "success" || event.status === "error")
        ) {
          targetTerminalSeen = true;
        }
        if (event.type === "done") {
          finish(targetTerminalSeen ? undefined : new Error("运行已结束，但目标节点未返回终态"));
        }
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

function updateTabFromRunEvent(
  set: (partial: Partial<FlowState> | ((state: FlowState) => Partial<FlowState>)) => unknown,
  tabId: string,
  nodeId: string,
  event: NodeStatusRunEvent,
): void {
  updateTabNodes(
    set,
    tabId,
    (nodes) =>
      nodes.map((node) =>
        node.id === nodeId ? { ...node, data: applyRunEventToNode(node.data, event) } : node,
      ),
    { markDirty: event.status === "success" && event.images.length > 0 },
  );
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
      // 服务端历史在登录成功后注入；不能从浏览器本地缓存恢复其他账号的记录。
      recentResults: [],
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
        const closingTab = syncedTabs[closingIndex];
        if (closingTab.nodes.some((node) => node.data.status === "queued" || node.data.status === "running")) {
          return;
        }
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
      openFlowTab: ({ projectId, projectName, nodes, edges, markDirty = false, readOnly = false }) => {
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
          const tab = newTab({ projectId, projectName, nodes, edges, markDirty, readOnly });
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
        if (get().readOnly) return;
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
        } else if (typeof window !== "undefined") {
          window.alert("最多选择 4 张图片进行对比");
        }
      },
      clearCompare: () => set({ compareIds: [] }),
      openViewer: (v) => set({ viewer: v }),
      closeViewer: () => set({ viewer: null }),

      onNodesChange: (changes) => {
        const allowed = get().readOnly ? changes.filter((change) => change.type === "select" || change.type === "dimensions") : changes;
        const nodes = applyNodeChanges(allowed, get().nodes);
        if (nodes === get().nodes) return;
        const changesDocument = allowed.some(
          (change) => change.type !== "select" && change.type !== "dimensions",
        );
        if (changesDocument) markDocumentChanged(set, { nodes });
        else withoutTemporalTracking(() => set({ nodes }));
      },
      onEdgesChange: (changes) => {
        const allowed = get().readOnly ? changes.filter((change) => change.type === "select") : changes;
        const edges = applyEdgeChanges(allowed, get().edges);
        if (edges === get().edges) return;
        const changesDocument = allowed.some((change) => change.type !== "select");
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
        if (get().readOnly) return;
        if (!get().isValidConnection(conn)) return;
        markDocumentChanged(set, { edges: addEdge(conn, get().edges) });
      },

      addNode: (kind, position) => {
        if (get().readOnly) return;
        const node: FlowNode = {
          id: nanoid(8),
          type: kind,
          position,
          data: defaultNodeData(kind),
        };
        markDocumentChanged(set, { nodes: [...get().nodes, node], selectedNodeId: node.id });
      },

      addExistingNode: (node) => {
        if (get().readOnly) return;
        markDocumentChanged(set, { nodes: [...get().nodes, node], selectedNodeId: node.id });
      },

      updateNodeData: (id, patch) => {
        if (get().readOnly) return;
        if (!get().nodes.some((n) => n.id === id)) return;
        markDocumentChanged(set, {
          nodes: get().nodes.map((n) =>
            n.id === id ? { ...n, data: { ...n.data, ...patch } as WorkflowNodeData } : n,
          ),
        });
      },
      updateNodeDataInTab: (tabId, id, patch) => {
        if (documentForTab(get(), tabId)?.readOnly) return;
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
        if (initialState.readOnly) return;
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
        const requestedCount = requestedResultCount(node.data);
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
          requestedCount,
        };
        const queuedRecords = createQueuedResultCards(initialRecord, requestedCount);
        set({
          recentResults: [
            ...queuedRecords,
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
              projectId: initialState.projectId,
              projectName: initialState.projectName,
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
              record.id === recordId || record.id.startsWith(`${recordId}:pending:`)
                ? { ...record, runId: payload.runId }
                : record,
            ),
          }));

          const runStatus = await fetch(`/api/run-plan/${encodeURIComponent(payload.runId)}`);
          if (!runStatus.ok) {
            throw new Error(
              runStatus.status === 404
                ? "服务已重启或运行状态已丢失，请重新发起任务"
                : `确认运行状态失败（HTTP ${runStatus.status}）`,
            );
          }

          await consumeRunEvents(payload.runId, id, (event) => {
            if (event.type !== "node-status" || event.nodeId !== id) return;
            set((state) => ({
              recentResults: applyRunEventToRecentResults(state.recentResults, recordId, event),
            }));
            updateTabFromRunEvent(set, tabId, id, event);
            if (event.status === "success" || event.status === "error") terminalRecorded = true;
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
            updateTabFromRunEvent(set, tabId, id, event);
          }
        } finally {
          releaseNonUndoableRun();
        }
      },

      saveProject: async () => {
        if (get().readOnly) return;
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
          readOnly: false,
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

if (typeof window !== "undefined") {
  let lastTabSessionJson = "";
  useFlowStore.subscribe((state, previousState) => {
    // 活动画布变化会由下一个订阅先同步进 tabs；历史/SSE/viewer 等全局状态无需序列化项目。
    if (state.tabs === previousState.tabs && state.activeTabId === previousState.activeTabId) return;
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
      snapshot.readOnly !== lastActiveSnapshot.readOnly ||
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
}

/** 登录后以服务器历史为准，恢复仍在当前服务进程中执行的任务。 */
export function resumeRecentResults(records: RecentResult[]): void {
  const resumable = records.filter(
    (record) =>
      (record.status === "queued" || record.status === "running") && Boolean(record.runId),
  );
  for (const record of resumable) {
    const runId = record.runId!;
    if (resumingRecentRunIds.has(runId)) continue;
    resumingRecentRunIds.add(runId);
    void (async () => {
      let terminalRecorded = false;
      try {
        const response = await fetch(`/api/run-plan/${encodeURIComponent(runId)}`);
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "服务已重启或恢复窗口已过，无法继续跟踪此任务"
              : `恢复任务失败（HTTP ${response.status}）`,
          );
        }
        await consumeRunEvents(runId, record.nodeId, (event) => {
          if (event.type !== "node-status" || event.nodeId !== record.nodeId) return;
          useFlowStore.setState((state) => ({
            recentResults: applyRunEventToRecentResults(state.recentResults, record.id, event),
          }));
          const tabId = useFlowStore
            .getState()
            .tabs.find((tab) => tab.projectId === record.projectId)?.id;
          if (tabId && event.status) {
            updateTabFromRunEvent(useFlowStore.setState, tabId, record.nodeId, event);
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
          updateTabFromRunEvent(useFlowStore.setState, tabId, record.nodeId, {
            type: "node-status",
            nodeId: record.nodeId,
            status: "error",
            error: message,
            startedAt: record.startedAt,
            finishedAt: Date.now(),
          });
        }
      } finally {
        // 成功、后端失败、恢复查询失败都必须释放，允许后续重试。
        resumingRecentRunIds.delete(runId);
      }
    })();
  }
}

/** 测试与外部恢复入口也必须复用同一套节点回写规则。 */
export function applyRunEventToTab(
  tabId: string,
  nodeId: string,
  event: NodeStatusRunEvent,
): void {
  updateTabFromRunEvent(useFlowStore.setState, tabId, nodeId, event);
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
