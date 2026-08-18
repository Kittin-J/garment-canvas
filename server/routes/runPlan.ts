/**
 * 工作流执行：
 *   POST /api/run-plan            { nodes, edges, onlyNodeId?, includeDownstream? } → { runId }
 *                                   （内部构建 ExecutionPlan 并立即异步执行）
 *   GET  /api/run-plan/:id/events SSE 事件流（含重放，事件见 engine/runner.ts RunEvent）
 */
import { Router } from "express";
import { WORKFLOW_SCHEMA_VERSION } from "../../src/types/workflow";
import { assertPlanInputs, buildExecutionPlan, DagError } from "../engine/dag";
import { createRun, getRunForUser, type RunEvent } from "../engine/runner";
import { validateAndMigrateFlow, WorkflowValidationError } from "../lib/workflowSchema";
import { requestUser } from "../lib/auth";
import { asyncHandler } from "../lib/asyncHandler";
import { queryOne } from "../lib/database";

export const runPlanRouter = Router();

export function requestedCountForStep(kind: string, params: Record<string, unknown>): number {
  return kind === "fabric-recolor"
    ? Math.max(1, Array.isArray(params.colors) ? params.colors.length : 1)
    : kind === "print-mutate"
      ? Math.max(1, Math.min(8, Number(params.count) || 4))
      : kind === "sketch-to-render" || kind === "ai-modify"
        ? Math.max(1, Math.min(8, Number(params.batchSize) || 1))
        : 1;
}

runPlanRouter.post("/", asyncHandler(async (req, res) => {
  const { nodes, edges, onlyNodeId, includeDownstream, projectId, projectName } = req.body as {
    nodes?: unknown[];
    edges?: unknown[];
    onlyNodeId?: string;
    includeDownstream?: boolean;
    projectId?: string;
    projectName?: string;
  };
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    res.status(400).json({ error: "nodes and edges arrays are required" });
    return;
  }
  if (onlyNodeId !== undefined && (typeof onlyNodeId !== "string" || !onlyNodeId.trim())) {
    res.status(400).json({ error: "onlyNodeId must be a non-empty string" });
    return;
  }
  if (includeDownstream !== undefined && typeof includeDownstream !== "boolean") {
    res.status(400).json({ error: "includeDownstream must be a boolean" });
    return;
  }
  try {
    // 执行与项目/模板持久化共用同一份运行时 schema，拒绝损坏或旧版漂移数据。
    const flow = validateAndMigrateFlow({
      schemaVersion: WORKFLOW_SCHEMA_VERSION,
      nodes,
      edges,
    });
    const plan = buildExecutionPlan(flow.nodes, flow.edges, {
      onlyNodeId,
      // 点击单节点默认只执行自己，避免无意触发整条下游产生额外费用。
      includeDownstream: includeDownstream ?? false,
    });
    if (plan.steps.length === 0) {
      res.status(400).json({ error: "workflow contains no executable nodes" });
      return;
    }
    assertPlanInputs(plan, flow.edges);
    const targetStep = plan.steps.find((step) => step.nodeId === onlyNodeId) ?? plan.steps[plan.steps.length - 1];
    const targetNode = flow.nodes.find((node) => node.id === targetStep.nodeId);
    const params = targetStep.params;
    const requestedCount = requestedCountForStep(targetStep.kind, params);
    const user = requestUser(req);
    if (typeof projectId === "string") {
      const project = await queryOne<{ owner_id: string }>(
        "SELECT owner_id FROM projects WHERE id = $1 AND deleted_at IS NULL",
        [projectId],
      );
      if (!project) {
        res.status(404).json({ error: "项目不存在或已删除" });
        return;
      }
      if (project && project.owner_id !== user.id) {
        res.status(403).json({ error: "管理员只能查看其他用户项目，不能运行或修改" });
        return;
      }
    }
    const run = await createRun(plan, user.id, {
      userId: user.id,
      projectId: typeof projectId === "string" ? projectId : undefined,
      projectName: typeof projectName === "string" ? projectName : undefined,
      nodeId: targetStep.nodeId,
      nodeLabel: targetNode?.data.label ?? targetStep.kind,
      kind: targetStep.kind,
      prompt: typeof params.prompt === "string" ? params.prompt : undefined,
      parameters: params,
      referenceImages: targetStep.inputImages,
      requestedCount,
    });
    res.json({ runId: run.id });
  } catch (err) {
    if (err instanceof DagError || err instanceof WorkflowValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }
}));

runPlanRouter.get("/:id/events", (req, res) => {
  const run = getRunForUser(req.params.id, requestUser(req).id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  const send = (event: RunEvent) => {
    if (event.seq !== undefined) res.write(`id: ${event.seq}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const lastEventId = Number(req.get("Last-Event-ID") ?? 0);
  const cursor = Number.isSafeInteger(lastEventId) && lastEventId >= 0 ? lastEventId : 0;
  // 晚连接拿全量；重连只补发游标后的事件，避免终态/最近生成重复记账。
  for (const event of run.events) {
    if ((event.seq ?? 0) > cursor) send(event);
  }
  if (run.finished) {
    res.end();
    return;
  }
  run.emitter.on("event", send);
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  const close = () => {
    clearInterval(heartbeat);
    run.emitter.off("event", send);
    res.end();
  };
  run.emitter.once("finish", close);
  req.on("close", () => {
    clearInterval(heartbeat);
    run.emitter.off("event", send);
    run.emitter.off("finish", close);
  });
});

/** 刷新后先确认内存中的 Run 仍可恢复，避免对已丢失的 id 无限 SSE 重连。 */
runPlanRouter.get("/:id", (req, res) => {
  const run = getRunForUser(req.params.id, requestUser(req).id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({ runId: run.id, finished: run.finished });
});
