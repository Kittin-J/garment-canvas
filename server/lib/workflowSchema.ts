import {
  WORKFLOW_SCHEMA_VERSION,
  MAX_REFERENCE_IMAGES,
  NODE_SPECS,
  type NodeKind,
  type PersistedWorkflow,
  type PersistedWorkflowEdge,
  type PersistedWorkflowNode,
  type WorkflowNodeData,
  BATCH_SIZES,
} from "../../src/types/workflow";
import { isLocalImageReference, validateImageDataUrl } from "./imageValidation";
import {
  DEFAULT_GENERATION_MODEL_ID,
  MASK_REDRAW_MODEL_ID,
  defaultImageModelOptions,
  imageModelOptionsError,
  isImageModelId,
  isModelAllowedForNode,
  normalizeImageModelOptions,
} from "../../src/types/imageModels";

const NODE_KINDS: readonly NodeKind[] = [
  "image-input",
  "sketch-to-render",
  "ai-modify",
  "fabric-recolor",
  "upscale",
  "print-extract",
  "print-mutate",
  "mask-redraw",
  "result",
];
const STATUSES = [
  "idle", "queued", "running", "retry_wait", "cancel_requested",
  "success", "error", "outcome_unknown", "cancelled",
] as const;
const IMAGE_ROLES = ["default", "sketch", "garment", "fabric", "reference"] as const;
const ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
const IMAGE_SIZES = ["2K", "4K"] as const;
const MAX_NODES = 500;
const MAX_EDGES = 2_000;
const MAX_TEXT_LENGTH = 20_000;
const MAX_IMAGE_REFS = 100;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new WorkflowValidationError(`${path}: ${message}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, path: string, opts?: { nonEmpty?: boolean }): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (opts?.nonEmpty && value.trim().length === 0) fail(path, "must not be empty");
  if (value.length > MAX_TEXT_LENGTH) fail(path, `must be at most ${MAX_TEXT_LENGTH} characters`);
  return value;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, path);
}

function imageReference(value: unknown, path: string): string {
  const ref = stringValue(value, path, { nonEmpty: true });
  if (ref.startsWith("data:")) {
    try {
      validateImageDataUrl(ref);
    } catch (error) {
      fail(path, error instanceof Error ? error.message : "invalid image dataURL");
    }
    return ref;
  }
  const isRemote = /^https?:\/\//i.test(ref);
  if (!isLocalImageReference(ref) && !isRemote) {
    fail(path, "must be an image dataURL, local /api/files reference, or http(s) URL");
  }
  return ref;
}

function optionalImageReference(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : imageReference(value, path);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "must be a finite number");
  return value;
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) fail(path, `must be one of: ${allowed.join(", ")}`);
  return value as T;
}

function stringArray(value: unknown, path: string, max = MAX_IMAGE_REFS): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > max) fail(path, `must contain at most ${max} items`);
  return value.map((item, index) => stringValue(item, `${path}[${index}]`, { nonEmpty: true }));
}

function imageReferenceArray(value: unknown, path: string, max = MAX_IMAGE_REFS): string[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > max) fail(path, `must contain at most ${max} items`);
  return value.map((item, index) => imageReference(item, `${path}[${index}]`));
}

function migratedModelFields(
  kind: NodeKind,
  raw: Record<string, unknown>,
  preferredAspectRatio = "1:1",
): Record<string, unknown> {
  const requested = isImageModelId(raw.modelId) && isModelAllowedForNode(raw.modelId, kind)
    ? raw.modelId
    : kind === "mask-redraw" ? MASK_REDRAW_MODEL_ID : DEFAULT_GENERATION_MODEL_ID;
  return {
    modelId: requested,
    modelOptions: normalizeImageModelOptions(requested, raw.modelOptions, preferredAspectRatio),
  };
}

function migrateNodeData(kind: NodeKind, raw: Record<string, unknown>): Record<string, unknown> {
  // v0/v1 文件保留现有值，只补后来新增且运行时依赖的确定性默认字段。
  switch (kind) {
    case "image-input":
      return { imageRole: "default", ...raw };
    case "sketch-to-render":
      return {
        prompt: "", aspectRatio: "3:4", batchSize: 1, outputImages: [],
        ...raw, ...migratedModelFields(kind, raw, typeof raw.aspectRatio === "string" ? raw.aspectRatio : "3:4"),
      };
    case "ai-modify":
      return {
        prompt: "", aspectRatio: "1:1", batchSize: 1, outputImages: [],
        ...raw, ...migratedModelFields(kind, raw, typeof raw.aspectRatio === "string" ? raw.aspectRatio : "1:1"),
      };
    case "fabric-recolor":
      return { colors: [], prompt: "", outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "upscale":
      return { imageSize: "2K", outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "print-extract":
      return { prompt: "", outputImages: [], savedAsAssets: [], ...raw, ...migratedModelFields(kind, raw) };
    case "print-mutate":
      return { prompt: "", count: 4, outputImages: [], ...raw, ...migratedModelFields(kind, raw) };
    case "mask-redraw":
      return {
        prompt: "", outputImages: [], ...raw,
        modelId: MASK_REDRAW_MODEL_ID,
        modelOptions: defaultImageModelOptions(MASK_REDRAW_MODEL_ID),
      };
    case "result":
      return { images: [], ...raw };
  }
}

function validateModelSelection(kind: NodeKind, raw: Record<string, unknown>, path: string): void {
  if (!NODE_SPECS[kind].providerId) return;
  if (!isImageModelId(raw.modelId)) fail(`${path}.modelId`, "must be a supported API易 image model");
  if (!isModelAllowedForNode(raw.modelId, kind)) {
    fail(`${path}.modelId`, `${raw.modelId} is not allowed for ${kind}`);
  }
  const optionsError = imageModelOptionsError(raw.modelId, raw.modelOptions);
  if (optionsError) fail(`${path}.modelOptions`, optionsError);
}

function validateData(kind: NodeKind, rawValue: unknown, path: string): WorkflowNodeData {
  const input = record(rawValue, path);
  // 运行中与失败状态不能跨保存/模板持久化；成功结果本身可以保留。
  const runtimeStatus = input.status;
  const raw =
    runtimeStatus !== "idle" && runtimeStatus !== "success"
      ? { ...input, status: "idle", error: undefined }
      : input;
  if (raw.kind !== kind) fail(`${path}.kind`, `must equal node type ${kind}`);
  stringValue(raw.label, `${path}.label`, { nonEmpty: true });
  oneOf(raw.status, STATUSES, `${path}.status`);
  optionalString(raw.error, `${path}.error`);
  validateModelSelection(kind, raw, path);

  switch (kind) {
    case "image-input":
      oneOf(raw.imageRole, IMAGE_ROLES, `${path}.imageRole`);
      optionalImageReference(raw.imageUrl, `${path}.imageUrl`);
      break;
    case "sketch-to-render":
    case "ai-modify":
      stringValue(raw.prompt, `${path}.prompt`);
      oneOf(raw.aspectRatio, ASPECT_RATIOS, `${path}.aspectRatio`);
      oneOf(raw.batchSize, BATCH_SIZES, `${path}.batchSize`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "fabric-recolor": {
      const colors = stringArray(raw.colors, `${path}.colors`, 8);
      for (let i = 0; i < colors.length; i++) {
        if (!/^#[0-9a-fA-F]{6}$/.test(colors[i])) fail(`${path}.colors[${i}]`, "must be #RRGGBB");
      }
      stringValue(raw.prompt, `${path}.prompt`);
      optionalImageReference(raw.fabricImageUrl, `${path}.fabricImageUrl`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    }
    case "upscale":
      oneOf(raw.imageSize, IMAGE_SIZES, `${path}.imageSize`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "print-extract":
      stringValue(raw.prompt, `${path}.prompt`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      imageReferenceArray(raw.savedAsAssets, `${path}.savedAsAssets`);
      break;
    case "print-mutate":
      stringValue(raw.prompt, `${path}.prompt`);
      if (!Number.isInteger(raw.count) || (raw.count as number) < 1 || (raw.count as number) > 8) {
        fail(`${path}.count`, "must be an integer from 1 to 8");
      }
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "mask-redraw":
      stringValue(raw.prompt, `${path}.prompt`);
      optionalImageReference(raw.mask, `${path}.mask`);
      optionalImageReference(raw.maskSourceRef, `${path}.maskSourceRef`);
      imageReferenceArray(raw.outputImages, `${path}.outputImages`);
      break;
    case "result":
      imageReferenceArray(raw.images, `${path}.images`);
      optionalString(raw.note, `${path}.note`);
      break;
  }
  return raw as unknown as WorkflowNodeData;
}

function validateNode(value: unknown, index: number, migrateLegacy: boolean): PersistedWorkflowNode {
  const path = `flow.nodes[${index}]`;
  const raw = record(value, path);
  const id = stringValue(raw.id, `${path}.id`, { nonEmpty: true });
  if (!SAFE_ID.test(id)) fail(`${path}.id`, "must contain only letters, digits, underscore or hyphen");
  const type = oneOf(raw.type, NODE_KINDS, `${path}.type`);
  const position = record(raw.position, `${path}.position`);
  finiteNumber(position.x, `${path}.position.x`);
  finiteNumber(position.y, `${path}.position.y`);
  const initialData = record(raw.data, `${path}.data`);
  const data = validateData(
    type,
    migrateLegacy ? migrateNodeData(type, initialData) : initialData,
    `${path}.data`,
  );
  return { ...raw, id, type, position: { ...position, x: position.x as number, y: position.y as number }, data } as PersistedWorkflowNode;
}

function validateEdge(value: unknown, index: number): PersistedWorkflowEdge {
  const path = `flow.edges[${index}]`;
  const raw = record(value, path);
  const id = stringValue(raw.id, `${path}.id`, { nonEmpty: true });
  const source = stringValue(raw.source, `${path}.source`, { nonEmpty: true });
  const target = stringValue(raw.target, `${path}.target`, { nonEmpty: true });
  if (!SAFE_ID.test(id)) fail(`${path}.id`, "must contain only letters, digits, underscore or hyphen");
  if (!SAFE_ID.test(source)) fail(`${path}.source`, "must be a valid node id");
  if (!SAFE_ID.test(target)) fail(`${path}.target`, "must be a valid node id");
  if (raw.sourceHandle !== undefined && raw.sourceHandle !== null) stringValue(raw.sourceHandle, `${path}.sourceHandle`);
  if (raw.targetHandle !== undefined && raw.targetHandle !== null) stringValue(raw.targetHandle, `${path}.targetHandle`);
  return { ...raw, id, source, target } as PersistedWorkflowEdge;
}

/** Validate untrusted JSON and migrate legacy unversioned/v0/v1 formats to v2. */
export function validateAndMigrateFlow(value: unknown): PersistedWorkflow {
  const raw = record(value, "flow");
  const version = raw.schemaVersion;
  const migrateLegacy = version === undefined || version === 0 || version === 1;
  if (!migrateLegacy && version !== WORKFLOW_SCHEMA_VERSION) {
    fail("flow.schemaVersion", `unsupported version ${String(version)}; current version is ${WORKFLOW_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(raw.nodes)) fail("flow.nodes", "must be an array");
  if (!Array.isArray(raw.edges)) fail("flow.edges", "must be an array");
  if (raw.nodes.length > MAX_NODES) fail("flow.nodes", `must contain at most ${MAX_NODES} nodes`);
  if (raw.edges.length > MAX_EDGES) fail("flow.edges", `must contain at most ${MAX_EDGES} edges`);

  const nodes = raw.nodes.map((node, index) => validateNode(node, index, migrateLegacy));
  const edges = raw.edges.map(validateEdge);
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodeIds.has(node.id)) fail("flow.nodes", `duplicate node id: ${node.id}`);
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) fail("flow.edges", `duplicate edge id: ${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source)) fail("flow.edges", `edge ${edge.id} source not found: ${edge.source}`);
    if (!nodeIds.has(edge.target)) fail("flow.edges", `edge ${edge.id} target not found: ${edge.target}`);
  }
  for (const node of nodes) {
    const incomingCount = edges.filter((edge) => edge.target === node.id).length;
    if (incomingCount > NODE_SPECS[node.type].inputs) {
      fail(
        "flow.edges",
        `node ${node.id} accepts at most ${NODE_SPECS[node.type].inputs} incoming image connections`,
      );
    }
    if (NODE_SPECS[node.type].providerId && incomingCount > MAX_REFERENCE_IMAGES) {
      fail("flow.edges", `node ${node.id} accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
    }
  }
  return { schemaVersion: WORKFLOW_SCHEMA_VERSION, nodes, edges };
}
