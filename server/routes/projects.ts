/**
 * 项目持久化（JSON 文件存储）：
 *   POST /api/projects       { id?, name, flow } → { ok, id }（无 id 则新建）
 *   GET  /api/projects/:id   → { id, name, flow, updatedAt }
 *   GET  /api/projects       → [{ id, name, updatedAt }]
 */
import { Router } from "express";
import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { config } from "../config";
import { writeJsonAtomicSync } from "../lib/atomicJson";
import { validateAndMigrateFlow, WorkflowValidationError } from "../lib/workflowSchema";
import type { PersistedWorkflow } from "../../src/types/workflow";

export const projectsRouter = Router();

interface ProjectFile {
  schemaVersion: 1;
  id: string;
  name: string;
  flow: PersistedWorkflow;
  updatedAt: string;
}

function readProjectFile(filePath: string): ProjectFile {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) {
    throw new WorkflowValidationError(`unsupported project schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.id !== "string" || !raw.id || typeof raw.name !== "string" || !raw.name) {
    throw new WorkflowValidationError("project id and name must be non-empty strings");
  }
  if (typeof raw.updatedAt !== "string" || !Number.isFinite(Date.parse(raw.updatedAt))) {
    throw new WorkflowValidationError("project updatedAt must be a valid date");
  }
  return {
    schemaVersion: 1,
    id: raw.id,
    name: raw.name,
    flow: validateAndMigrateFlow(raw.flow),
    updatedAt: raw.updatedAt,
  };
}

function projectsDir(): string {
  const dir = path.join(config.dataDir(), "projects");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function projectPath(id: string): string {
  return path.join(projectsDir(), `${path.basename(id)}.json`);
}

projectsRouter.post("/", (req, res) => {
  const { id, name, flow } = req.body as { id?: string; name?: string; flow?: unknown };
  if (typeof name !== "string" || name.trim().length === 0 || name.length > 200 || flow === undefined) {
    res.status(400).json({ error: "name and flow are required" });
    return;
  }
  if (id !== undefined && (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))) {
    res.status(400).json({ error: "id must contain only letters, digits, underscore or hyphen" });
    return;
  }
  const projectId = id || nanoid(10);
  try {
    const project: ProjectFile = {
      schemaVersion: 1,
      id: projectId,
      name: name.trim(),
      flow: validateAndMigrateFlow(flow),
      updatedAt: new Date().toISOString(),
    };
    writeJsonAtomicSync(projectPath(projectId), project);
    res.json({ ok: true, id: projectId });
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

projectsRouter.get("/", (_req, res) => {
  try {
    const list = fs
      .readdirSync(projectsDir())
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const p = readProjectFile(path.join(projectsDir(), f));
          return { id: p.id, name: p.name, updatedAt: p.updatedAt };
        } catch {
          return null;
        }
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

projectsRouter.get("/:id", (req, res) => {
  const filePath = projectPath(req.params.id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: "project not found" });
    return;
  }
  try {
    const project = readProjectFile(filePath);
    res.json(project);
  } catch (err) {
    res.status(err instanceof WorkflowValidationError ? 422 : 500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
