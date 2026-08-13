/**
 * DAG 工作流执行计划构建。
 * 输入 React Flow 的 nodes/edges JSON，Kahn 拓扑排序输出 ExecutionPlan。
 * 支持环检测与两种局部重跑：只跑选中节点，或选中节点及其下游。
 */
import type {
  ExecutionPlan,
  NodeExecution,
  NodeKind,
  WorkflowNodeData,
} from "../../src/types/workflow";
import { NODE_SPECS } from "../../src/types/workflow";

/** React Flow 节点/边的最小结构（前端传入） */
export interface FlowNode {
  id: string;
  type?: string;
  data: WorkflowNodeData & { kind: NodeKind };
}

export interface FlowEdge {
  id?: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export class DagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagError";
  }
}

/** 运行前验证会产生费用的节点具备真实图片输入。 */
export function assertPlanInputs(plan: ExecutionPlan, edges: FlowEdge[]): void {
  const executingNodeIds = new Set(plan.steps.map((step) => step.nodeId));
  for (const step of plan.steps) {
    const spec = NODE_SPECS[step.kind];
    if (!spec.providerId) continue;
    const usableImages = (step.upstream ?? []).flatMap((upstream) =>
      executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images,
    );
    if (step.kind === "sketch-to-render" && usableImages.length === 0) {
      // sketch-to-render 同时承担文生款式，只有 prompt 时允许无图片执行。
      const prompt = typeof step.params.prompt === "string" ? step.params.prompt.trim() : "";
      if (!prompt) throw new DagError(`Node ${step.nodeId} requires an image or a prompt`);
      continue;
    }
    if (step.kind === "fabric-recolor") {
      const garmentEdges = edges.filter(
        (edge) => edge.target === step.nodeId && edge.targetHandle !== "fabric",
      );
      const garmentIds = new Set(garmentEdges.map((edge) => edge.source));
      const garmentImages = (step.upstream ?? [])
        .filter((upstream) => garmentIds.has(upstream.nodeId))
        .flatMap((upstream) =>
          executingNodeIds.has(upstream.nodeId) ? ["__runtime_output__"] : upstream.images,
        );
      if (garmentImages.length === 0) {
        throw new DagError(`Node ${step.nodeId} requires a garment image`);
      }
      continue;
    }
    if (usableImages.length === 0) {
      throw new DagError(`Node ${step.nodeId} requires an upstream image`);
    }
  }
}

/**
 * 构建执行计划。
 * @param opts.onlyNodeId 从指定节点开始构建局部计划
 * @param opts.includeDownstream 是否把指定节点的下游也纳入计划（默认 true，保持旧接口语义）
 */
export function buildExecutionPlan(
  nodes: FlowNode[],
  edges: FlowEdge[],
  opts?: { onlyNodeId?: string; includeDownstream?: boolean },
): ExecutionPlan {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  // 校验边引用的节点存在
  for (const e of edges) {
    if (!nodeMap.has(e.source)) throw new DagError(`Edge source not found: ${e.source}`);
    if (!nodeMap.has(e.target)) throw new DagError(`Edge target not found: ${e.target}`);
  }

  // 局部重跑：目标节点始终在范围内；按需继续扩展到全部下游。
  let scope: Set<string> | null = null;
  if (opts?.onlyNodeId) {
    if (!nodeMap.has(opts.onlyNodeId)) {
      throw new DagError(`Node not found: ${opts.onlyNodeId}`);
    }
    scope = new Set([opts.onlyNodeId]);
    if (opts.includeDownstream !== false) {
      const queue = [opts.onlyNodeId];
      while (queue.length) {
        const cur = queue.shift()!;
        for (const e of edges) {
          if (e.source === cur && !scope.has(e.target)) {
            scope.add(e.target);
            queue.push(e.target);
          }
        }
      }
    }
  }

  const inScope = (id: string) => scope === null || scope.has(id);
  const scopedNodes = nodes.filter((n) => inScope(n.id));
  const scopedEdges = edges.filter((e) => inScope(e.source) && inScope(e.target));

  // Kahn 拓扑排序
  const indegree = new Map<string, number>();
  for (const n of scopedNodes) indegree.set(n.id, 0);
  for (const e of scopedEdges) indegree.set(e.target, (indegree.get(e.target) ?? 0) + 1);

  const queue = scopedNodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id);
  const sorted: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    sorted.push(id);
    for (const e of scopedEdges) {
      if (e.source !== id) continue;
      const d = (indegree.get(e.target) ?? 0) - 1;
      indegree.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }

  if (sorted.length !== scopedNodes.length) {
    const remaining = scopedNodes.filter((n) => !sorted.includes(n.id)).map((n) => n.id);
    throw new DagError(`Cycle detected in workflow, involved nodes: ${remaining.join(", ")}`);
  }

  // 生成执行步骤：记录每个节点的上游依赖（节点 ID + 计划期快照）。
  // 运行时由 runner 从本次 Run 的 outputs 解析真实输入；
  // 上游不在执行范围（单节点重跑）时回退到快照。
  const steps: NodeExecution[] = sorted.map((id) => {
    const node = nodeMap.get(id)!;
    const data = node.data;

    // 上游按 edges 数组顺序（result 节点多输入时保持连接顺序）
    const upstream: { nodeId: string; images: string[] }[] = [];
    for (const e of edges) {
      if (e.target !== id) continue;
      const srcData = nodeMap.get(e.source)!.data;
      upstream.push({ nodeId: e.source, images: extractOutputImages(srcData) });
    }

    return {
      nodeId: id,
      kind: data.kind,
      inputImages: upstream.flatMap((u) => u.images),
      upstream,
      params: extractParams(data),
    };
  });

  return { steps };
}

/** 从节点 data 提取该节点当前已知的输出图片 */
function extractOutputImages(data: WorkflowNodeData): string[] {
  switch (data.kind) {
    case "image-input":
      return data.imageUrl ? [data.imageUrl] : [];
    case "sketch-to-render":
    case "ai-modify":
    case "fabric-recolor":
    case "upscale":
    case "print-extract":
    case "print-mutate":
      return data.outputImages ?? [];
    case "result":
      return data.images ?? [];
  }
}

/** 提取节点执行参数（prompt / aspectRatio / batchSize / fabricImageUrl 等） */
function extractParams(data: WorkflowNodeData): Record<string, unknown> {
  switch (data.kind) {
    case "image-input":
      return { imageUrl: data.imageUrl, imageRole: data.imageRole };
    case "sketch-to-render":
      return { prompt: data.prompt, aspectRatio: data.aspectRatio, batchSize: data.batchSize };
    case "ai-modify":
      return { prompt: data.prompt, aspectRatio: data.aspectRatio, batchSize: data.batchSize };
    case "fabric-recolor":
      return {
        prompt: data.prompt,
        colors: data.colors,
        fabricImageUrl: data.fabricImageUrl,
      };
    case "upscale":
      return { imageSize: data.imageSize };
    case "print-extract":
      return { prompt: data.prompt };
    case "print-mutate":
      return { prompt: data.prompt, count: data.count };
    case "result":
      return { note: data.note };
  }
}
