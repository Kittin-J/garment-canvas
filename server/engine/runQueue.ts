import os from "node:os";
import path from "node:path";
import type { PoolClient } from "pg";
import { nanoid } from "nanoid";
import type { ExecutionPlan, NodeExecution } from "../../src/types/workflow";
import { isImageModelId } from "../../src/types/imageModels";
import { db, query, queryOne, transaction } from "../lib/database";
import { persistImageRef } from "../lib/fileStore";
import type { GenerationRecordContext } from "../lib/generationRecords";
import { getProvider } from "../providers";
import {
  ProviderError,
  publicProviderErrorMessage,
  sanitizedProviderDiagnostic,
} from "../providers/base";
import { executeStep, type ProviderResolver, type RunEvent, type StepResult } from "./runner";

export type DurableRunStatus =
  | "queued"
  | "running"
  | "retry_wait"
  | "cancel_requested"
  | "cancelled"
  | "succeeded"
  | "failed"
  | "outcome_unknown";

const TERMINAL_RUN_STATUSES = new Set<DurableRunStatus>([
  "cancelled",
  "succeeded",
  "failed",
  "outcome_unknown",
]);
const DEFAULT_LEASE_MS = 45_000;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_POLL_MS = 750;
const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000] as const;
const CANCELLED_AFTER_START_WARNING = "取消请求未能中止已经开始的上游调用，结果已按实际返回保存";
export const DURABLE_RUN_EVENT_BATCH_SIZE = 500;

interface DurableRunRow {
  id: string;
  owner_id: string;
  project_id: string | null;
  node_id: string;
  status: DurableRunStatus | "success" | "error";
  target_step_id: string | null;
  started_at: number;
  finished_at: number | null;
}

interface ClaimedJob {
  id: string;
  runId: string;
  stepId: string;
  nodeId: string;
  stepIndex: number;
  step: NodeExecution;
  retryCount: number;
  startedAt: number;
}

interface JobLockRow {
  id: string;
  run_id: string;
  step_id: string;
  status: DurableRunStatus;
  retry_count: number;
  attempt_started_at: number | null;
  worker_id: string | null;
  node_id: string;
  step_index: number;
  step_json: string;
  step_started_at: number | null;
  target_step_id: string | null;
}

export interface ProcessGenerationJobOptions {
  resolveProvider?: ProviderResolver;
  now?: () => number;
  retryDelaysMs?: readonly number[];
  random?: () => number;
  leaseMs?: number;
  heartbeatMs?: number;
}

class CancelledBeforeProviderCall extends Error {
  constructor() {
    super("任务已在上游调用开始前取消");
    this.name = "CancelledBeforeProviderCall";
  }
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status as DurableRunStatus) || status === "success" || status === "error";
}

async function lockRun(client: PoolClient, runId: string): Promise<DurableRunRow | undefined> {
  return (await client.query<DurableRunRow>(
    "SELECT id, owner_id, project_id, node_id, status, target_step_id, started_at, finished_at FROM generation_runs WHERE id = $1 FOR UPDATE",
    [runId],
  )).rows[0];
}

async function appendRunEvent(
  client: PoolClient,
  runId: string,
  event: RunEvent,
  createdAt: number,
): Promise<RunEvent> {
  const seqRow = (await client.query<{ seq: number }>(`
    SELECT COALESCE(MAX(seq), 0)::int + 1 AS seq
    FROM generation_run_events WHERE run_id = $1
  `, [runId])).rows[0];
  const sequenced = { ...event, seq: seqRow?.seq ?? 1 } as RunEvent;
  await client.query(`
    INSERT INTO generation_run_events (run_id, seq, payload_json, created_at)
    VALUES ($1, $2, $3, $4)
  `, [runId, sequenced.seq, JSON.stringify(sequenced), createdAt]);
  return sequenced;
}

export async function enqueueGenerationRun(
  plan: ExecutionPlan,
  ownerId: string,
  context: GenerationRecordContext,
  runType: "workflow" | "direct" = "workflow",
): Promise<{ id: string }> {
  if (!ownerId.trim() || context.userId !== ownerId) throw new Error("run owner is invalid");
  if (plan.steps.length === 0) throw new Error("execution plan has no steps");
  const runId = nanoid(10);
  const createdAt = Date.now();
  const requestedTargetIndex = plan.steps.findIndex((step) => step.nodeId === context.nodeId);
  const targetIndex = requestedTargetIndex >= 0 ? requestedTargetIndex : plan.steps.length - 1;
  const stepIds = plan.steps.map(() => nanoid(12));
  const targetStep = plan.steps[targetIndex] ?? plan.steps.at(-1)!;
  const targetStepId = stepIds[targetIndex] ?? stepIds.at(-1)!;
  const initialModel = isImageModelId(targetStep.params.modelId) ? targetStep.params.modelId : null;

  await transaction(async (client) => {
    await client.query(`
      INSERT INTO generation_runs (
        id, owner_id, project_id, project_name, node_id, node_label, kind, prompt,
        parameters_json, reference_images_json, model, requested_count, status,
        started_at, plan_json, target_step_id, run_type, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'queued',
        $13, $14, $15, $16, $13
      )
    `, [
      runId, ownerId, context.projectId ?? null, context.projectName ?? null,
      context.nodeId, context.nodeLabel, context.kind, context.prompt ?? null,
      JSON.stringify(context.parameters ?? {}), JSON.stringify(context.referenceImages ?? targetStep.inputImages ?? []),
      initialModel, context.requestedCount, createdAt, JSON.stringify(plan), targetStepId, runType,
    ]);

    for (const [index, step] of plan.steps.entries()) {
      const stepId = stepIds[index];
      const model = isImageModelId(step.params.modelId) ? step.params.modelId : null;
      await client.query(`
        INSERT INTO generation_run_steps (
          id, run_id, step_index, node_id, kind, step_json, status, model
        ) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)
      `, [stepId, runId, index, step.nodeId, step.kind, JSON.stringify(step), model]);
      await client.query(`
        INSERT INTO generation_jobs (
          id, run_id, step_id, idempotency_key, status, retry_count, available_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'queued', 0, $5, $5, $5)
      `, [nanoid(12), runId, stepId, `${runId}:${stepId}`, createdAt]);
      await appendRunEvent(client, runId, {
        type: "node-status", nodeId: step.nodeId, status: "queued", startedAt: createdAt,
      }, createdAt);
    }
  });
  return { id: runId };
}

async function claimNextJob(
  workerId: string,
  now: number,
  leaseMs: number,
): Promise<ClaimedJob | undefined> {
  return transaction(async (client) => {
    const row = (await client.query<JobLockRow>(`
      SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
        s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
      FROM generation_jobs j
      JOIN generation_run_steps s ON s.id = j.step_id
      JOIN generation_runs r ON r.id = j.run_id
      WHERE j.status IN ('queued','retry_wait')
        AND j.available_at <= $1
        AND r.status IN ('queued','running','retry_wait')
        AND NOT EXISTS (
          SELECT 1 FROM generation_run_steps previous
          WHERE previous.run_id = s.run_id
            AND previous.step_index < s.step_index
            AND previous.status <> 'succeeded'
        )
      ORDER BY j.available_at, r.started_at, s.step_index
      FOR UPDATE OF j SKIP LOCKED
      LIMIT 1
    `, [now])).rows[0];
    if (!row) return undefined;
    const run = await lockRun(client, row.run_id);
    if (!run || isTerminalRunStatus(run.status) || run.status === "cancel_requested") return undefined;
    await client.query(`
      UPDATE generation_jobs SET status = 'running', worker_id = $1, lease_expires_at = $2,
        attempt_started_at = NULL, updated_at = $3 WHERE id = $4
    `, [workerId, now + leaseMs, now, row.id]);
    await client.query(`
      UPDATE generation_run_steps SET status = 'running', started_at = COALESCE(started_at, $1), error = NULL
      WHERE id = $2
    `, [now, row.step_id]);
    await client.query(
      "UPDATE generation_runs SET status = 'running', updated_at = $1 WHERE id = $2",
      [now, row.run_id],
    );
    await appendRunEvent(client, row.run_id, {
      type: "node-status", nodeId: row.node_id, status: "running", startedAt: now,
    }, now);
    const step = parseJson<NodeExecution | undefined>(row.step_json, undefined);
    if (!step) throw new Error("generation step payload is invalid");
    return {
      id: row.id,
      runId: row.run_id,
      stepId: row.step_id,
      nodeId: row.node_id,
      stepIndex: row.step_index,
      step,
      retryCount: row.retry_count,
      startedAt: now,
    };
  });
}

async function inputImagesForStep(runId: string, step: NodeExecution): Promise<string[]> {
  if (!step.upstream?.length) return step.inputImages;
  const rows = await query<{ node_id: string; output_images_json: string }>(`
    SELECT node_id, output_images_json FROM generation_run_steps
    WHERE run_id = $1 AND status = 'succeeded'
  `, [runId]);
  const outputs = new Map(rows.map((row) => [row.node_id, parseJson<string[]>(row.output_images_json, [])]));
  return step.upstream.flatMap((upstream) => outputs.get(upstream.nodeId) ?? upstream.images);
}

async function markAttemptStarted(
  job: ClaimedJob,
  workerId: string,
  now: number,
  leaseMs: number,
): Promise<void> {
  await transaction(async (client) => {
    const row = (await client.query<{ status: DurableRunStatus; worker_id: string | null }>(
      "SELECT status, worker_id FROM generation_jobs WHERE id = $1 FOR UPDATE",
      [job.id],
    )).rows[0];
    if (!row || row.worker_id !== workerId) throw new Error("generation job lease was lost");
    if (row.status === "cancel_requested") throw new CancelledBeforeProviderCall();
    if (row.status !== "running") throw new Error(`generation job is ${row.status}`);
    await client.query(`
      UPDATE generation_jobs SET attempt_started_at = COALESCE(attempt_started_at, $1),
        lease_expires_at = $2, updated_at = $1 WHERE id = $3
    `, [now, now + leaseMs, job.id]);
    await client.query(`
      UPDATE generation_run_steps SET provider_requests = provider_requests + 1 WHERE id = $1
    `, [job.stepId]);
  });
}

async function persistStepImages(images: string[]): Promise<string[]> {
  const persisted: string[] = [];
  for (const image of images) persisted.push(await persistImageRef(image));
  return persisted;
}

async function finalizeSuccessfulRun(
  client: PoolClient,
  run: DurableRunRow,
  finishedAt: number,
  cancellationWarning?: string,
): Promise<void> {
  const target = run.target_step_id
      ? (await client.query<{
        output_images_json: string; prompts_json: string; provider_output_sizes_json: string;
        failures_json: string; model: string | null;
      }>(`
        SELECT output_images_json, prompts_json, provider_output_sizes_json, failures_json, model
        FROM generation_run_steps WHERE id = $1
      `, [run.target_step_id])).rows[0]
    : undefined;
  const images = parseJson<string[]>(target?.output_images_json ?? "[]", []);
  const prompts = parseJson<string[]>(target?.prompts_json ?? "[]", []);
  const providerOutputSizes = parseJson<Array<string | null>>(target?.provider_output_sizes_json ?? "[]", []);
  const failures = parseJson<Array<{ prompt?: string; error: string }>>(target?.failures_json ?? "[]", []);
  const aggregate = (await client.query<{ provider_requests: number; model: string | null }>(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [run.id])).rows[0];
  await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [run.id]);
  for (const [index, image] of images.entries()) {
    await client.query(`
      INSERT INTO generation_outputs (
        id, run_id, image, prompt, provider_output_size, status, error, created_at
      ) VALUES ($1, $2, $3, $4, $5, 'success', NULL, $6)
    `, [
      nanoid(12), run.id, image, prompts[index] ?? null,
      providerOutputSizes[index] ?? null, finishedAt + index,
    ]);
  }
  for (const [index, failure] of failures.entries()) {
    await client.query(`
      INSERT INTO generation_outputs (id, run_id, image, prompt, status, error, created_at)
      VALUES ($1, $2, '', $3, 'error', $4, $5)
    `, [nanoid(12), run.id, failure.prompt ?? null, failure.error, finishedAt + images.length + index]);
  }
  const warning = cancellationWarning ?? (failures.length ? `${failures.length} 个生成任务失败` : null);
  const model = target?.model ?? aggregate?.model ?? null;
  const providerRequests = aggregate?.provider_requests ?? 0;
  await client.query(`
    UPDATE generation_runs SET status = 'succeeded', successful_count = $1, provider_requests = $2,
      model = $3, error = $4, finished_at = $5, updated_at = $5 WHERE id = $6
  `, [images.length, providerRequests, model, warning, finishedAt, run.id]);
  if (images.length > 0) {
    await client.query(`
      INSERT INTO usage_events (
        id, owner_id, run_id, project_id, node_id, model, successful_count,
        provider_requests, duration_ms, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (run_id) DO UPDATE SET
        model = excluded.model, successful_count = excluded.successful_count,
        provider_requests = excluded.provider_requests, duration_ms = excluded.duration_ms,
        created_at = excluded.created_at
    `, [
      nanoid(12), run.owner_id, run.id, run.project_id, run.node_id, model, images.length,
      providerRequests, Math.max(0, finishedAt - run.started_at), new Date(finishedAt).toISOString(),
    ]);
  }
  await appendRunEvent(client, run.id, { type: "done" }, finishedAt);
}

async function finalizeCancelledTargetRun(
  client: PoolClient,
  run: DurableRunRow,
  targetNodeId: string,
  message: string,
  finishedAt: number,
): Promise<void> {
  const aggregate = (await client.query<{ provider_requests: number; model: string | null }>(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [run.id])).rows[0];
  await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [run.id]);
  await client.query(`
    UPDATE generation_runs SET status = 'cancelled', successful_count = 0, provider_requests = $1,
      model = $2, error = $3, finished_at = $4, updated_at = $4 WHERE id = $5
  `, [aggregate?.provider_requests ?? 0, aggregate?.model ?? null, message, finishedAt, run.id]);
  await appendRunEvent(client, run.id, {
    type: "node-status", nodeId: targetNodeId, status: "cancelled", error: message, finishedAt,
  }, finishedAt);
  await appendRunEvent(client, run.id, { type: "done" }, finishedAt);
}

async function completeJobSuccess(
  job: ClaimedJob,
  workerId: string,
  result: StepResult,
  persistedImages: string[],
  finishedAt: number,
): Promise<void> {
  await transaction(async (client) => {
    const locked = (await client.query<{ status: DurableRunStatus; worker_id: string | null }>(
      "SELECT status, worker_id FROM generation_jobs WHERE id = $1 FOR UPDATE",
      [job.id],
    )).rows[0];
    if (!locked || locked.worker_id !== workerId) throw new Error("generation job lease was lost before completion");
    const run = await lockRun(client, job.runId);
    if (!run) throw new Error("generation run disappeared");
    const cancellationWarning = locked.status === "cancel_requested" ? CANCELLED_AFTER_START_WARNING : undefined;
    await client.query(`
      UPDATE generation_jobs SET status = 'succeeded', worker_id = NULL, lease_expires_at = NULL,
        updated_at = $1, last_error = NULL WHERE id = $2
    `, [finishedAt, job.id]);
    await client.query(`
      UPDATE generation_run_steps SET status = 'succeeded', model = $1, output_images_json = $2,
        prompts_json = $3, provider_output_sizes_json = $4, failures_json = $5,
        error = $6, finished_at = $7
      WHERE id = $8
    `, [
      result.model ?? null, JSON.stringify(persistedImages), JSON.stringify(result.prompts ?? []),
      JSON.stringify(result.providerOutputSizes ?? []), JSON.stringify(result.failures ?? []),
      cancellationWarning ?? null, finishedAt, job.stepId,
    ]);
    for (const image of persistedImages) {
      if (!image.startsWith("/api/files/")) continue;
      await client.query(`
        INSERT INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
        VALUES ($1, $2, 'generated', $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING
      `, [path.basename(image), run.owner_id, run.project_id, job.nodeId, run.id, new Date(finishedAt).toISOString()]);
    }
    const partialWarning = result.failures?.length ? `${result.failures.length} 个生成任务失败` : undefined;
    await appendRunEvent(client, run.id, {
      type: "node-status",
      nodeId: job.nodeId,
      status: "success",
      images: persistedImages,
      model: result.model,
      prompts: result.prompts,
      providerOutputSizes: result.providerOutputSizes,
      failures: result.failures,
      error: cancellationWarning ?? partialWarning,
      startedAt: job.startedAt,
      finishedAt,
    }, finishedAt);

    if (cancellationWarning) {
      await client.query(`
        UPDATE generation_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL, updated_at = $1
        WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
      `, [finishedAt, run.id]);
      await client.query(`
        UPDATE generation_run_steps SET status = 'cancelled', finished_at = $1, error = '用户取消了后续步骤'
        WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
      `, [finishedAt, run.id]);
    }

    const active = (await client.query<{ count: number }>(`
      SELECT COUNT(*)::int AS count FROM generation_jobs
      WHERE run_id = $1 AND status IN ('queued','running','retry_wait','cancel_requested')
    `, [run.id])).rows[0]?.count ?? 0;
    if (active === 0) {
      const target = run.target_step_id
        ? (await client.query<{ status: DurableRunStatus; node_id: string; error: string | null }>(`
            SELECT status, node_id, error FROM generation_run_steps WHERE id = $1
          `, [run.target_step_id])).rows[0]
        : undefined;
      if (target?.status === "cancelled") {
        await finalizeCancelledTargetRun(
          client,
          run,
          target.node_id,
          target.error ?? "用户取消了目标步骤",
          finishedAt,
        );
      } else if (target?.status === "succeeded" || !target) {
        await finalizeSuccessfulRun(client, run, finishedAt, cancellationWarning);
      } else {
        throw new Error(`generation target step ended as ${target.status}`);
      }
    } else {
      await client.query("UPDATE generation_runs SET status = 'running', updated_at = $1 WHERE id = $2", [finishedAt, run.id]);
    }
  });
}

function isRetryableProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && (
    error.status === 429 ||
    (error.status === 503 && error.category === "gateway_unavailable")
  );
}

async function terminateRun(
  client: PoolClient,
  row: JobLockRow,
  status: "failed" | "outcome_unknown" | "cancelled",
  message: string,
  finishedAt: number,
): Promise<void> {
  const run = await lockRun(client, row.run_id);
  if (!run || isTerminalRunStatus(run.status)) return;
  await client.query(`
    UPDATE generation_jobs SET status = $1, worker_id = NULL, lease_expires_at = NULL,
      last_error = $2, updated_at = $3 WHERE id = $4
  `, [status, message, finishedAt, row.id]);
  await client.query(`
    UPDATE generation_run_steps SET status = $1, error = $2, finished_at = $3 WHERE id = $4
  `, [status, message, finishedAt, row.step_id]);
  await client.query(`
    UPDATE generation_jobs SET status = 'cancelled', worker_id = NULL, lease_expires_at = NULL,
      last_error = $1, updated_at = $2
    WHERE run_id = $3 AND id <> $4 AND status IN ('queued','retry_wait','cancel_requested')
  `, ["上游步骤未完成，后续任务已停止", finishedAt, row.run_id, row.id]);
  await client.query(`
    UPDATE generation_run_steps SET status = 'cancelled', error = $1, finished_at = $2
    WHERE run_id = $3 AND id <> $4 AND status IN ('queued','retry_wait','cancel_requested')
  `, ["上游步骤未完成，后续任务已停止", finishedAt, row.run_id, row.step_id]);
  const aggregate = (await client.query<{ provider_requests: number; model: string | null }>(`
    SELECT COALESCE(SUM(provider_requests), 0)::int AS provider_requests,
      (ARRAY_AGG(model ORDER BY step_index DESC) FILTER (WHERE model IS NOT NULL))[1] AS model
    FROM generation_run_steps WHERE run_id = $1
  `, [row.run_id])).rows[0];
  await client.query(`
    UPDATE generation_runs SET status = $1, error = $2, provider_requests = $3,
      model = COALESCE($4, model), finished_at = $5, updated_at = $5 WHERE id = $6
  `, [status, message, aggregate?.provider_requests ?? 0, aggregate?.model ?? null, finishedAt, row.run_id]);
  await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [row.run_id]);
  if (status === "failed") {
    await client.query(`
      INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
      VALUES ($1, $2, '', 'error', $3, $4)
    `, [nanoid(12), row.run_id, message, finishedAt]);
  }
  const clientStatus = status === "failed" ? "error" : status;
  await appendRunEvent(client, row.run_id, {
    type: "node-status", nodeId: row.node_id, status: clientStatus, error: message,
    startedAt: row.step_started_at ?? undefined, finishedAt,
  } as RunEvent, finishedAt);
  if (status === "failed") {
    await appendRunEvent(client, row.run_id, {
      type: "run-error", nodeId: row.node_id, error: message, finishedAt,
    }, finishedAt);
  } else {
    await appendRunEvent(client, row.run_id, { type: "done" }, finishedAt);
  }
}

async function handleJobError(
  job: ClaimedJob,
  workerId: string,
  error: unknown,
  options: ProcessGenerationJobOptions,
): Promise<void> {
  const now = options.now?.() ?? Date.now();
  const message = error instanceof CancelledBeforeProviderCall
    ? error.message
    : error instanceof ProviderError
      ? publicProviderErrorMessage(error)
      : error instanceof Error ? error.message : String(error);
  if (error instanceof ProviderError) {
    console.error("[ai-provider-worker-failure]", JSON.stringify({
      runId: job.runId, nodeId: job.nodeId, providerId: error.providerId, status: error.status ?? null,
      category: error.category, retryCount: job.retryCount, diagnostic: sanitizedProviderDiagnostic(error) ?? error.message,
    }));
  }
  await transaction(async (client) => {
    const row = (await client.query<JobLockRow>(`
      SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
        s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
      FROM generation_jobs j JOIN generation_run_steps s ON s.id = j.step_id
      JOIN generation_runs r ON r.id = j.run_id WHERE j.id = $1 FOR UPDATE OF j
    `, [job.id])).rows[0];
    if (!row || (row.worker_id !== workerId && row.status !== "cancel_requested")) return;
    if (error instanceof CancelledBeforeProviderCall) {
      await terminateRun(client, row, "cancelled", message, now);
      return;
    }
    if (error instanceof ProviderError && error.category === "outcome_unknown") {
      await terminateRun(client, row, "outcome_unknown", message, now);
      return;
    }
    if (row.status === "cancel_requested") {
      await terminateRun(client, row, "cancelled", "用户取消了任务，系统未继续重试", now);
      return;
    }
    if (isRetryableProviderError(error) && row.retry_count < 2) {
      const retryNumber = row.retry_count + 1;
      const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
      const baseDelay = retryDelays[Math.min(row.retry_count, retryDelays.length - 1)] ?? DEFAULT_RETRY_DELAYS_MS[1];
      const jitter = Math.floor((options.random?.() ?? Math.random()) * 1_000);
      const availableAt = now + Math.max(0, baseDelay) + jitter;
      await lockRun(client, row.run_id);
      await client.query(`
        UPDATE generation_jobs SET status = 'retry_wait', retry_count = $1, available_at = $2,
          worker_id = NULL, lease_expires_at = NULL, attempt_started_at = NULL, last_error = $3, updated_at = $4
        WHERE id = $5
      `, [retryNumber, availableAt, message, now, row.id]);
      await client.query(`
        UPDATE generation_run_steps SET status = 'retry_wait', error = $1 WHERE id = $2
      `, [message, row.step_id]);
      await client.query("UPDATE generation_runs SET status = 'retry_wait', error = $1, updated_at = $2 WHERE id = $3", [
        message, now, row.run_id,
      ]);
      await appendRunEvent(client, row.run_id, {
        type: "node-status", nodeId: row.node_id, status: "retry_wait", error: message,
        startedAt: row.step_started_at ?? job.startedAt,
      }, now);
      return;
    }
    await terminateRun(client, row, "failed", message, now);
  });
}

export async function recoverExpiredGenerationJobs(now = Date.now()): Promise<number> {
  return transaction(async (client) => {
    const rows = (await client.query<JobLockRow>(`
      SELECT j.id, j.run_id, j.step_id, j.status, j.retry_count, j.attempt_started_at, j.worker_id,
        s.node_id, s.step_index, s.step_json, s.started_at AS step_started_at, r.target_step_id
      FROM generation_jobs j JOIN generation_run_steps s ON s.id = j.step_id
      JOIN generation_runs r ON r.id = j.run_id
      WHERE j.status IN ('running','cancel_requested') AND j.lease_expires_at < $1
      ORDER BY j.lease_expires_at ASC FOR UPDATE OF j SKIP LOCKED LIMIT 50
    `, [now])).rows;
    for (const row of rows) {
      if (row.attempt_started_at !== null) {
        await terminateRun(
          client, row, "outcome_unknown",
          "Worker 在上游调用开始后中断，结果可能已经生成；系统不会自动重试", now,
        );
        continue;
      }
      if (row.status === "cancel_requested") {
        await terminateRun(client, row, "cancelled", "任务已在上游调用开始前取消", now);
        continue;
      }
      await lockRun(client, row.run_id);
      await client.query(`
        UPDATE generation_jobs SET status = 'queued', worker_id = NULL, lease_expires_at = NULL,
          available_at = $1, updated_at = $1 WHERE id = $2
      `, [now, row.id]);
      await client.query("UPDATE generation_run_steps SET status = 'queued', error = NULL WHERE id = $1", [row.step_id]);
      await client.query("UPDATE generation_runs SET status = 'queued', error = NULL, updated_at = $1 WHERE id = $2", [now, row.run_id]);
      await appendRunEvent(client, row.run_id, {
        type: "node-status", nodeId: row.node_id, status: "queued",
        error: "Worker 租约过期，任务已安全重新排队",
      }, now);
    }
    return rows.length;
  });
}

export async function processNextGenerationJob(
  workerId: string,
  options: ProcessGenerationJobOptions = {},
): Promise<boolean> {
  const now = options.now?.() ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  await recoverExpiredGenerationJobs(now);
  const job = await claimNextJob(workerId, now, leaseMs);
  if (!job) return false;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    const heartbeatNow = options.now?.() ?? Date.now();
    void db().query(`
      UPDATE generation_jobs SET lease_expires_at = $1, updated_at = $2
      WHERE id = $3 AND worker_id = $4 AND status IN ('running','cancel_requested')
    `, [heartbeatNow + leaseMs, heartbeatNow, job.id, workerId]).catch((error) => {
      console.error("[garment-canvas] generation lease heartbeat failed", error);
    });
  }, heartbeatMs);
  heartbeat.unref();
  try {
    const inputImages = await inputImagesForStep(job.runId, job.step);
    const result = await executeStep(
      job.step,
      inputImages,
      options.resolveProvider ?? getProvider,
      {
        runId: job.runId,
        beforeProviderCall: async () => {
          await markAttemptStarted(job, workerId, options.now?.() ?? Date.now(), leaseMs);
        },
      },
    );
    const persistedImages = await persistStepImages(result.images);
    await completeJobSuccess(job, workerId, result, persistedImages, options.now?.() ?? Date.now());
  } catch (error) {
    await handleJobError(job, workerId, error, options);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

export function startGenerationWorker(): () => void {
  const workerId = `${os.hostname()}:${process.pid}:${nanoid(6)}`;
  let stopped = false;
  let busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      while (!stopped && await processNextGenerationJob(workerId)) {
        // Drain immediately available work before returning to the poll interval.
      }
    } catch (error) {
      console.error("[garment-canvas] generation worker failed", error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), DEFAULT_POLL_MS);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function getDurableRunForUser(
  runId: string,
  ownerId: string,
): Promise<{ id: string; status: string; finished: boolean } | undefined> {
  const row = await queryOne<{ id: string; status: string }>(`
    SELECT id, status FROM generation_runs
    WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
  `, [runId, ownerId]);
  return row ? { id: row.id, status: row.status, finished: isTerminalRunStatus(row.status) } : undefined;
}

export async function readDurableRunEvents(
  runId: string,
  ownerId: string,
  afterSeq: number,
): Promise<RunEvent[] | undefined> {
  const run = await queryOne<{ id: string }>(`
    SELECT id FROM generation_runs
    WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
  `, [runId, ownerId]);
  if (!run) return undefined;
  const rows = await query<{ seq: number; payload_json: string }>(`
    SELECT seq, payload_json FROM generation_run_events
    WHERE run_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3
  `, [runId, afterSeq, DURABLE_RUN_EVENT_BATCH_SIZE]);
  return rows.map((row) => ({ ...parseJson<RunEvent>(row.payload_json, { type: "done" }), seq: row.seq }));
}

export async function cancelDurableRun(
  runId: string,
  ownerId: string,
): Promise<{ status: DurableRunStatus; finished: boolean } | undefined> {
  const now = Date.now();
  return transaction(async (client) => {
    const visible = (await client.query<{ id: string }>(`
      SELECT id FROM generation_runs
      WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
    `, [runId, ownerId])).rows[0];
    if (!visible) return undefined;

    // Worker 始终先锁 job、再锁 run；取消必须保持同一顺序，避免并发完成时形成死锁。
    const jobs = (await client.query<{
      id: string; step_id: string; node_id: string; status: DurableRunStatus; attempt_started_at: number | null;
    }>(`
      SELECT j.id, j.step_id, s.node_id, j.status, j.attempt_started_at
      FROM generation_jobs j JOIN generation_run_steps s ON s.id = j.step_id
      WHERE j.run_id = $1
      ORDER BY j.id
      FOR UPDATE OF j
    `, [runId])).rows;
    const run = (await client.query<DurableRunRow>(`
      SELECT id, owner_id, project_id, node_id, status, target_step_id, started_at, finished_at
      FROM generation_runs
      WHERE id = $1 AND owner_id = $2 AND plan_json IS NOT NULL AND deleted_at IS NULL
      FOR UPDATE
    `, [runId, ownerId])).rows[0];
    if (!run) return undefined;
    if (isTerminalRunStatus(run.status)) {
      return { status: run.status as DurableRunStatus, finished: true };
    }
    const running = jobs.find((job) => job.status === "running" || job.status === "cancel_requested");
    if (running) {
      if (running.status === "cancel_requested") {
        return { status: "cancel_requested", finished: false };
      }
      await client.query(`
        UPDATE generation_jobs SET status = 'cancel_requested', updated_at = $1
        WHERE id = $2
      `, [now, running.id]);
      await client.query("UPDATE generation_run_steps SET status = 'cancel_requested' WHERE id = $1", [running.step_id]);
      await client.query(`
        UPDATE generation_jobs SET status = 'cancelled', updated_at = $1, last_error = '用户取消了后续步骤'
        WHERE run_id = $2 AND status IN ('queued','retry_wait')
      `, [now, runId]);
      await client.query(`
        UPDATE generation_run_steps SET status = 'cancelled', finished_at = $1, error = '用户取消了后续步骤'
        WHERE run_id = $2 AND status IN ('queued','retry_wait')
      `, [now, runId]);
      await client.query(`
        UPDATE generation_runs SET status = 'cancel_requested', cancel_requested_at = $1, updated_at = $1
        WHERE id = $2
      `, [now, runId]);
      await appendRunEvent(client, runId, {
        type: "node-status", nodeId: running.node_id, status: "cancel_requested",
        error: running.attempt_started_at === null
          ? "正在上游调用开始前取消"
          : "上游不支持中止，已记录取消请求并等待真实结果",
      }, now);
      return { status: "cancel_requested", finished: false };
    }

    const target = run.target_step_id
      ? (await client.query<{ node_id: string }>(
          "SELECT node_id FROM generation_run_steps WHERE id = $1", [run.target_step_id],
        )).rows[0]
      : undefined;
    await client.query(`
      UPDATE generation_jobs SET status = 'cancelled', updated_at = $1, last_error = '用户取消了任务'
      WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
    `, [now, runId]);
    await client.query(`
      UPDATE generation_run_steps SET status = 'cancelled', finished_at = $1, error = '用户取消了任务'
      WHERE run_id = $2 AND status IN ('queued','retry_wait','cancel_requested')
    `, [now, runId]);
    await client.query(`
      UPDATE generation_runs SET status = 'cancelled', error = '用户取消了任务',
        cancel_requested_at = $1, finished_at = $1, updated_at = $1 WHERE id = $2
    `, [now, runId]);
    await appendRunEvent(client, runId, {
      type: "node-status", nodeId: target?.node_id ?? run.node_id, status: "cancelled",
      error: "任务已在上游调用开始前取消", finishedAt: now,
    }, now);
    await appendRunEvent(client, runId, { type: "done" }, now);
    return { status: "cancelled", finished: true };
  });
}
