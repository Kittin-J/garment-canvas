import { nanoid } from "nanoid";
import path from "node:path";
import { db } from "./database";

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

export function createGenerationRecord(runId: string, context: GenerationRecordContext, startedAt: number): void {
  db().prepare(`
    INSERT INTO generation_runs (
      id, owner_id, project_id, project_name, node_id, node_label, kind, prompt,
      parameters_json, reference_images_json, requested_count, status, started_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
  `).run(
    runId, context.userId, context.projectId ?? null, context.projectName ?? null,
    context.nodeId, context.nodeLabel, context.kind, context.prompt ?? null,
    JSON.stringify(context.parameters ?? {}), JSON.stringify(context.referenceImages ?? []),
    context.requestedCount, startedAt,
  );
}

export function markGenerationRunning(runId: string, startedAt: number): void {
  db().prepare("UPDATE generation_runs SET status = 'running', started_at = ? WHERE id = ?")
    .run(startedAt, runId);
}

export function registerGeneratedFiles(
  context: GenerationRecordContext,
  runId: string,
  nodeId: string,
  images: string[],
  createdAt: number,
): void {
  const insert = db().prepare(`
    INSERT OR IGNORE INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
    VALUES (?, ?, 'generated', ?, ?, ?, ?)
  `);
  const createdAtIso = new Date(createdAt).toISOString();
  db().transaction(() => {
    for (const image of images) {
      if (image.startsWith("/api/files/")) {
        insert.run(path.basename(image), context.userId, context.projectId ?? null, nodeId, runId, createdAtIso);
      }
    }
  })();
}

export function completeGenerationRecord(args: {
  runId: string;
  images: string[];
  prompts?: string[];
  failures?: Array<{ prompt?: string; error: string }>;
  model?: string;
  providerRequests: number;
  startedAt: number;
  finishedAt: number;
}): void {
  const database = db();
  const run = database.prepare("SELECT owner_id, project_id, node_id FROM generation_runs WHERE id = ?")
    .get(args.runId) as { owner_id: string; project_id: string | null; node_id: string } | undefined;
  if (!run) return;
  database.transaction(() => {
    database.prepare("DELETE FROM generation_outputs WHERE run_id = ?").run(args.runId);
    const insertOutput = database.prepare(`
      INSERT INTO generation_outputs (id, run_id, image, prompt, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    args.images.forEach((image, index) => {
      insertOutput.run(nanoid(12), args.runId, image, args.prompts?.[index] ?? null, "success", null, args.finishedAt + index);
      if (image.startsWith("/api/files/")) {
        database.prepare(`
          INSERT OR IGNORE INTO files (id, owner_id, source_type, project_id, node_id, run_id, created_at)
          VALUES (?, ?, 'generated', ?, ?, ?, ?)
        `).run(path.basename(image), run.owner_id, run.project_id, run.node_id, args.runId, new Date(args.finishedAt).toISOString());
      }
    });
    (args.failures ?? []).forEach((failure, index) => {
      insertOutput.run(nanoid(12), args.runId, "", failure.prompt ?? null, "error", failure.error, args.finishedAt + args.images.length + index);
    });
    const warning = args.failures?.length ? `${args.failures.length} 个生成任务失败` : null;
    database.prepare(`
      UPDATE generation_runs SET status = 'success', successful_count = ?, provider_requests = ?,
        model = ?, error = ?, finished_at = ? WHERE id = ?
    `).run(args.images.length, args.providerRequests, args.model ?? null, warning, args.finishedAt, args.runId);
    if (args.images.length > 0) {
      database.prepare(`
        INSERT OR REPLACE INTO usage_events (
          id, owner_id, run_id, project_id, node_id, model, successful_count,
          provider_requests, duration_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        nanoid(12), run.owner_id, args.runId, run.project_id, run.node_id, args.model ?? null,
        args.images.length, args.providerRequests, Math.max(0, args.finishedAt - args.startedAt),
        new Date(args.finishedAt).toISOString(),
      );
    }
  })();
}

export function failGenerationRecord(runId: string, error: string, finishedAt: number): void {
  const database = db();
  database.transaction(() => {
    database.prepare(`
      UPDATE generation_runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?
    `).run(error, finishedAt, runId);
    database.prepare("DELETE FROM generation_outputs WHERE run_id = ?").run(runId);
    database.prepare(`
      INSERT INTO generation_outputs (id, run_id, image, status, error, created_at)
      SELECT ?, id, '', 'error', ?, ? FROM generation_runs WHERE id = ?
    `).run(nanoid(12), error, finishedAt, runId);
  })();
}
