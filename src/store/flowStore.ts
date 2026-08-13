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

interface FlowState {
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

/** 只允许最新保存请求更新保存状态，避免乱序响应覆盖新状态。 */
let latestSaveRequestId = 0;
let saveInFlight: Promise<void> | null = null;
let saveQueued = false;

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

const starterNode: FlowNode = {
  id: nanoid(8),
  type: "image-input",
  position: { x: 0, y: 0 },
  data: defaultNodeData("image-input"),
};

type FlowTemporalState = Pick<FlowState, "nodes" | "edges">;

/** 最近生成持久化（localStorage）：刷新/重开浏览器不丢 */
const RECENT_STORAGE_KEY = "garment-canvas-recent-results";

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
    (set, get) => ({
      projectId: nanoid(10),
      projectName: "未命名设计项目",
      nodes: [starterNode],
      edges: [],
      selectedNodeId: null,
      selectedResultId: null,
      recentResults: typeof window === "undefined" ? [] : loadRecentResults(),
      compareIds: [],
      viewer: null,
      saveState: "idle",
      revision: 0,
      savedRevision: 0,
      dirty: false,
      documentEpoch: 0,

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
        const documentEpoch = initialState.documentEpoch;
        const localStartedAt = Date.now();
        const recordId = nanoid(8);
        const releaseNonUndoableRun = beginNonUndoableRun(`run:${id}`);
        let terminalRecorded = false;

        const isCurrentDocument = () =>
          get().documentEpoch === documentEpoch && get().nodes.some((candidate) => candidate.id === id);

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
          get().setNodeStatus(id, "queued", undefined);
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
              if (isCurrentDocument()) get().setNodeStatus(id, event.status, event.error);
              return;
            }
            if (event.status !== "success" && event.status !== "error") return;
            terminalRecorded = true;
            if (isCurrentDocument() && event.images?.length) {
              markDocumentChanged(set, {
                nodes: get().nodes.map((candidate) =>
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
              });
            }
            if (isCurrentDocument()) get().setNodeStatus(id, event.status, event.error);
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
            if (isCurrentDocument()) get().setNodeStatus(id, "error", message);
          }
        } finally {
          releaseNonUndoableRun();
        }
      },

      saveProject: async () => {
        if (saveInFlight) {
          saveQueued = true;
          await saveInFlight;
          return;
        }
        const drainSaves = async () => {
          do {
            saveQueued = false;
            const { projectId, projectName, nodes, edges, revision, documentEpoch } = get();
            const requestId = ++latestSaveRequestId;
            set({ saveState: "saving" });
            try {
              const res = await fetch("/api/projects", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  id: projectId,
                  name: projectName,
                  flow: { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges },
                }),
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              set((state) => {
                if (
                  requestId !== latestSaveRequestId ||
                  state.documentEpoch !== documentEpoch ||
                  state.projectId !== projectId
                ) return {};
                const savedRevision = Math.max(state.savedRevision, revision);
                const clean = state.revision === revision;
                if (!clean) saveQueued = true;
                return {
                  savedRevision,
                  dirty: !clean,
                  saveState: clean ? "saved" : "saving",
                };
              });
            } catch {
              set((state) => {
                if (
                  requestId !== latestSaveRequestId ||
                  state.documentEpoch !== documentEpoch ||
                  state.projectId !== projectId
                ) return {};
                return { saveState: "error", dirty: state.revision !== state.savedRevision };
              });
              saveQueued = false;
            }
          } while (saveQueued);
        };
        saveInFlight = drainSaves();
        try {
          await saveInFlight;
        } finally {
          saveInFlight = null;
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
        latestSaveRequestId += 1;
        set({
          projectId,
          projectName,
          nodes,
          edges,
          selectedNodeId: null,
          selectedResultId: null,
          compareIds: [],
          viewer: null,
          saveState: "idle",
          revision: markDirty ? 1 : 0,
          savedRevision: 0,
          dirty: markDirty,
          documentEpoch: get().documentEpoch + 1,
        });
        // 清空撤销历史，避免撤销回上一个项目的画布状态
        useFlowStore.temporal.getState().clear();
      },
    }),
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
