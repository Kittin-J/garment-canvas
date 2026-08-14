/**
 * 工作流核心类型契约 —— 团队共用，改动需通知全员
 * P0 MVP：无限画布 + 节点 DAG + 双模型（nanobanana / gpt-image-2）
 */

// ---------- 节点类型 ----------
export type NodeKind =
  | "image-input"        // 图片上传（草图/款式图/面料参考）
  | "sketch-to-render"   // 草图→效果图（nanobanana）
  | "ai-modify"          // AI 改款/变体（gpt-image-2）
  | "fabric-recolor"     // 面料/配色替换（gpt-image-2）
  | "upscale"            // 高清放大（nanobanana，2K/4K）
  | "print-extract"      // 印花提取（gpt-image-2，抠出印花平铺展开）
  | "print-mutate"       // 印花裂变（gpt-image-2，1~8 张风格一致变体）
  | "result";            // 结果展示/管理

// ---------- 节点执行状态机 ----------
export type NodeRunStatus =
  | "idle"
  | "queued"
  | "running"
  | "success"
  | "error";

/** OpenAI Images Edit 最多支持 16 图；产品端为控制成本与上传体积限制为 8 图。 */
export const MAX_REFERENCE_IMAGES = 8;

// ---------- 节点数据（存 React Flow node.data）----------
export interface BaseNodeData {
  label: string;
  status: NodeRunStatus;
  error?: string;
  [key: string]: unknown;
}

export interface ImageInputNodeData extends BaseNodeData {
  kind: "image-input";
  /** dataURL 或 /api/files/xxx 路径 */
  imageUrl?: string;
  imageRole: "default" | "sketch" | "garment" | "fabric" | "reference";
}

export interface SketchToRenderNodeData extends BaseNodeData {
  kind: "sketch-to-render";
  prompt: string;
  aspectRatio: string;       // "1:1" | "3:4" | "4:3" | "9:16" | "16:9"
  batchSize: 1 | 2 | 4;
  outputImages: string[];    // 生成结果
}

export interface AiModifyNodeData extends BaseNodeData {
  kind: "ai-modify";
  prompt: string;
  aspectRatio: string;
  batchSize: 1 | 2 | 4;            // 改款指令，如"改成娃娃领、袖长改短"
  outputImages: string[];
}

export interface FabricRecolorNodeData extends BaseNodeData {
  kind: "fabric-recolor";
  /** 选中的配色（hex 数组，最多 8 个，一色出一张图），prompt 由它自动组装 */
  colors: string[];
  prompt: string;            // 由 colors 自动组装的替换指令
  fabricImageUrl?: string;   // 面料参考图（可来自上游 fabric 节点）
  outputImages: string[];
}

export interface UpscaleNodeData extends BaseNodeData {
  kind: "upscale";
  /** 放大档位（Gemini imageConfig.imageSize，必须大写） */
  imageSize: "2K" | "4K";
  outputImages: string[];
}

export interface PrintExtractNodeData extends BaseNodeData {
  kind: "print-extract";
  /** 补充说明（可选），如"只要胸前那朵花" */
  prompt: string;
  /** 提取出的印花图（平铺展开、纯色背景） */
  outputImages: string[];
  /** 已存为素材的图片 URL（防止重复保存） */
  savedAsAssets: string[];
}

export interface PrintMutateNodeData extends BaseNodeData {
  kind: "print-mutate";
  /** 裂变方向补充说明（可选），如"改成水墨风格" */
  prompt: string;
  /** 裂变数量（1~8） */
  count: number;
  outputImages: string[];
}

export interface ResultNodeData extends BaseNodeData {
  kind: "result";
  images: string[];
  note?: string;
}

export type WorkflowNodeData =
  | ImageInputNodeData
  | SketchToRenderNodeData
  | AiModifyNodeData
  | FabricRecolorNodeData
  | UpscaleNodeData
  | PrintExtractNodeData
  | PrintMutateNodeData
  | ResultNodeData;

// ---------- 持久化工作流（项目 / 模板共用）----------
/**
 * 版本 1 是首个显式、可校验的磁盘格式。读取无版本的历史文件时，服务端会先按
 * v0 迁移（补齐后来新增的节点默认字段），再返回 v1；新版本不得静默降级读取。
 */
export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export type WorkflowSchemaVersion = typeof WORKFLOW_SCHEMA_VERSION;

export interface PersistedWorkflowNode {
  id: string;
  type: NodeKind;
  position: { x: number; y: number };
  data: WorkflowNodeData;
  [key: string]: unknown;
}

export interface PersistedWorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  [key: string]: unknown;
}

export interface PersistedWorkflow {
  schemaVersion: WorkflowSchemaVersion;
  nodes: PersistedWorkflowNode[];
  edges: PersistedWorkflowEdge[];
}

// ---------- Provider 抽象层契约 ----------
/** 所有 AI 调用必须经此接口，禁止业务代码直连第三方 SDK */
export interface ImageGenRequest {
  prompt: string;
  /** 参考图（dataURL 数组，按连线顺序，最多 8 张） */
  referenceImages?: string[];
  aspectRatio?: string;
  batchSize?: number;
  /** 分辨率档位（Gemini imageConfig.imageSize："1K"|"2K"|"4K"，必须大写） */
  imageSize?: string;
  /** 局部编辑蒙版（dataURL），P0 可选 */
  mask?: string;
}

export interface ImageGenResult {
  images: string[];          // dataURL 或可访问 URL
  model: string;
  usageNote?: string;
}

export interface AIProvider {
  readonly id: string;                 // "nanobanana" | "gpt-image-2" | "comfyui-local"(预留)
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
  edit(req: ImageGenRequest): Promise<ImageGenResult>;
}

// ---------- 节点执行计划（DAG 引擎与后端之间）----------
export interface NodeExecution {
  nodeId: string;
  kind: NodeKind;
  /** 上游传入的图片（按边顺序，计划期静态快照） */
  inputImages: string[];
  /**
   * 上游依赖（按边顺序）：运行时优先取本次 Run 中该上游的产出，
   * 上游不在执行范围（单节点重跑）时回退到 images 快照。
   */
  upstream?: { nodeId: string; images: string[] }[];
  params: Record<string, unknown>;
}

export interface ExecutionPlan {
  /** 拓扑排序后的执行序列 */
  steps: NodeExecution[];
}

// ---------- 工作流模板（P1-a）----------
export interface WorkflowTemplate {
  schemaVersion: WorkflowSchemaVersion;
  id: string;
  name: string;
  description: string;
  /** 内置模板（随部署预置，不可删） */
  builtIn?: boolean;
  /** 缩略图（可选，/api/files/xxx） */
  thumbnail?: string;
  flow: PersistedWorkflow;
  createdAt: string;
}

// ---------- 素材库（印花提取等产出的可复用素材）----------
export interface Asset {
  id: string;
  name: string;
  /** 素材类型：print=印花 / fabric=面料 / reference=参考图 */
  category: "print" | "fabric" | "reference";
  /** 图片 URL（/api/files/xxx） */
  image: string;
  /** 来源说明（如来自哪个节点/项目） */
  sourceNote?: string;
  createdAt: string;
}

// ---------- API 契约（前端 ↔ Express）----------
// POST /api/generate   { providerId, request: ImageGenRequest } → ImageGenResult
// POST /api/files      { dataUrl } → { id, url }
// GET  /api/files/:id  读取图片
// POST /api/projects   保存项目 { id, name, flow } → { ok }
// GET  /api/projects/:id → { id, name, flow }
// GET    /api/templates        → WorkflowTemplate[]（内置 + 用户）
// POST   /api/templates        { name, description, thumbnail?, flow } → { ok, id }
// DELETE /api/templates/:id    删除用户模板（内置不可删，403）
// GET    /api/templates/:id    → WorkflowTemplate
// GET    /api/assets           ?category=print → Asset[]（按 createdAt 倒序）
// POST   /api/assets           { name, category, image, sourceNote? } → { ok, id }
// PATCH  /api/assets/:id       { name? } 重命名
// DELETE /api/assets/:id       删除素材（不删底层图片文件，允许多素材共图）

// ---------- 节点注册表（前端渲染 + 引擎共用）----------
export interface NodeSpec {
  kind: NodeKind;
  title: string;
  description: string;
  providerId?: string;     // AI 节点对应的 provider
  inputs: number;          // 接受的图片输入数（0 = 无输入）
  outputs: "images" | "none";
}

export const NODE_SPECS: Record<NodeKind, NodeSpec> = {
  "image-input": {
    kind: "image-input",
    title: "图片上传",
    description: "上传草图 / 款式图 / 面料参考",
    inputs: 0,
    outputs: "images",
  },
  "sketch-to-render": {
    kind: "sketch-to-render",
    title: "草图→效果图",
    description: "AI 将线稿渲染为服装效果图",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
  },
  "ai-modify": {
    kind: "ai-modify",
    title: "AI 改款",
    description: "gpt-image-2 改领型/袖型/长度/细节",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
  },
  "fabric-recolor": {
    kind: "fabric-recolor",
    title: "面料/配色替换",
    description: "gpt-image-2 替换面料纹理与配色",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
  },
  upscale: {
    kind: "upscale",
    title: "高清放大",
    description: "AI 放大至 2K/4K，精修细节",
    providerId: "gpt-image-2",
    inputs: 1,
    outputs: "images",
  },
  "print-extract": {
    kind: "print-extract",
    title: "印花提取",
    description: "gpt-image-2 从服装上抠出印花，平铺展开存素材",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
  },
  "print-mutate": {
    kind: "print-mutate",
    title: "印花裂变",
    description: "gpt-image-2 基于印花生成 1~8 张风格一致的变体",
    providerId: "gpt-image-2",
    inputs: MAX_REFERENCE_IMAGES,
    outputs: "images",
  },
  result: {
    kind: "result",
    title: "结果",
    description: "汇总展示与导出",
    inputs: 4,
    outputs: "none",
  },
};
