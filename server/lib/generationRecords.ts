import { nanoid } from "nanoid";
import path from "node:path";
import { query, queryOne, transaction } from "./database";

export interface GenerationRecordContext {
  userId: string;
  projectId?: string;
  projectName?: string;
  nodeId: string;
  nodeLabel: string;
  kind: string;
  prompt?: string;
  parameters?: Record<string, unknown>;
  referenceImages?: string[];
  requestedCount: number;
}

export async function createGenerationRecord(runId: string, context: GenerationRecordContext, startedAt: number): Promise<void> {
  await query(`
    INSERT INTO generation_runs (
      id, owner_id, project_id, project_name, node_id, node_label, kind, prompt,
      parameters_json, reference_images_json, requested_count, status, started_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12)
  `, [
    runId, context.userId, context.projectId ?? null, context.projectName ?? null,
    context.nodeId, context.nodeLabel, context.kind, context.prompt ?? null,
    JSON.stringify(context.parameters ?? {}), JSON.stringify(context.referenceImages ?? []),
    context.requestedCount, startedAt,
  ]);
}

export async function markGenerationRunning(runId: string, startedAt: number): Promise<void> {
  await query("UPDATE generation_runs SET status = 'running', started_at = $1 WHERE id = $2", [startedAt, runId]);
}

export async function registerGeneratedFiles(
  context: GenerationRecordContext,
  runId: string,
  nodeId: string,
  images: string[],
  createdAt: number,
): Promise<void> {
  const createdAtIso = new Date(createdAt).toISOString();
  await transaction(async (client) => {
    for (const image of images) {
      if (!image.startsWith("/api/files/")) continue;
      await client.query(`
        INSERT INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
        VALUES ($1, $2, 'generated', $3, $4, $5, $6)
        ON CONFLICT (id) DO NOTHING
      `, [path.basename(image), context.userId, context.projectId ?? null, nodeId, runId, createdAtIso]);
    }
  });
}

export async function completeGenerationRecord(args: {
  runId: string;
  images: string[];
  prompts?: string[];
  failures?: Array<{ prompt?: string; error: string }>;
  model?: string;
  providerRequests: number;
  startedAt: number;
  finishedAt: number;
}): Promise<void> {
  await transaction(async (client) => {
    const run = await queryOne<{ owner_id: string; project_id: string | null; node_id: string }>(
      "SELECT owner_id, project_id, node_id FROM generation_runs WHERE id = $1 FOR UPDATE",
      [args.runId],
      client,
    );
    if (!run) return;
    await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [args.runId]);
    for (const [index, image] of args.images.entries()) {
      await client.query(`
        INSERT INTO generation_outputs (id, run_id, image, prompt, status, error, created_at)
        VALUES ($1, $2, $3, $4, 'success', NULL, $5)
      `, [nanoid(12), args.runId, image, args.prompts?.[index] ?? null, args.finishedAt + index]);
      if (image.startsWith("/api/files/")) {
        await client.query(`
          INSERT INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
          VALUES ($1, $2, 'generated', $3, $4, $5, $6)
          ON CONFLICT (id) DO NOTHING
        `, [path.basename(image), run.owner_id, run.project_id, run.node_id, args.runId, new Date(args.finishedAt).toISOString()]);
      }
    }
    for (const [index, failure] of (args.failures ?? []).entries()) {
      await client.query(`
        INSERT INTO generation_outputs (id, run_id, image, prompt, status, error, created_at)
        VALUES ($1, $2, '', $3, 'error', $4, $5)
      `, [nanoid(12), args.runId, failure.prompt ?? null, failure.error, args.finishedAt + args.images.length + index]);
    }
    const warning = args.failures?.length ? `${args.failures.length} 个生成任务失败` : null;
    await client.query(`
      UPDATE generation_runs SET status = 'success', successful_count = $1, provider_requests = $2,
        model = $3, error = $4, finished_at = $5 WHERE id = $6
    `, [args.images.length, args.providerRequests, args.model ?? null, warning, args.finishedAt, args.runId]);
    if (args.images.length > 0) {
      await client.query(`
        INSERT INTO usage_events (
          id, owner_id, run_id, project_id, node_id, model, successful_count,
          provider_requests, duration_ms, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (run_id) DO UPDATE SET
          model = excluded.model,
          successful_count = excluded.successful_count,
          provider_requests = excluded.provider_requests,
          duration_ms = excluded.duration_ms,
          created_at = excluded.created_at
      `, [
        nanoid(12), run.owner_id, args.runId, run.project_id, run.node_id, args.model ?? null,
        args.images.length, args.providerRequests, Math.max(0, args.finishedAt - args.startedAt),
        new Date(args.finishedAt).toISOString(),
      ]);
    }
  });
}

export async function failGenerationRecord(runId: string, error: string, finishedAt: number): Promise<void> {
  await transaction(async (client) => {
    await client.query("UPDATE generation_runs SET status = 'error', error = $1, finished_at = $2 WHERE id = $3", [
      error, finishedAt, runId,
    ]);
    await client.query("DELETE FROM generation_outputs WHERE run_id = $1", [runId]);
    await client.query(`
      INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
      SELECT $1, id, '', 'error', $2, $3 FROM generation_runs WHERE id = $4
    `, [nanoid(12), error, finishedAt, runId]);
  });
}
