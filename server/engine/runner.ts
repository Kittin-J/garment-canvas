/**
 * 执行计划运行器：逐步执行 ExecutionPlan，通过事件总线推送每步状态（SSE 用）。
 * 运行记录保存在内存（P0 单进程足够）。
 */
import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import {
  NODE_SPECS,
  MAX_REFERENCE_IMAGES,
  type ExecutionPlan,
  type NodeExecution,
  type NodeRunStatus,
} from "../../src/types/workflow";
import { getProvider } from "../providers";
import { ProviderError, publicProviderErrorMessage } from "../providers/base";
import { generateExactImages } from "../providers/exact";
import { normalizeImageRef, persistImageRef } from "../lib/fileStore";
import { buildRecolorPrompt } from "../../src/lib/colors";
import {
  completeGenerationRecord,
  createGenerationRecord,
  failGenerationRecord,
  markGenerationRunning,
  registerGeneratedFiles,
  type GenerationRecordContext,
} from "../lib/generationRecords";

export interface RunFailure {
  prompt?: string;
  error: string;
}

interface RunEventMeta {
  /** Run 内单调递增事件序号，供 SSE 重连去重。 */
  seq?: number;
  error?: string;
  model?: string;
  /** 每张成功图片对应的实际提示词；顺序与 images 一致。 */
  prompts?: string[];
  failures?: RunFailure[];
  startedAt?: number;
  finishedAt?: number;
}

export type RunEvent =
  | (RunEventMeta & {
      type: "node-status";
      nodeId: string;
      status: Exclude<NodeRunStatus, "success" | "error" | "idle">;
      images?: never;
    })
  | (RunEventMeta & {
      type: "node-status";
      nodeId: string;
      status: "success";
      images: string[];
    })
  | (Omit<RunEventMeta, "error"> & {
      type: "node-status";
      nodeId: string;
      status: "error";
      error: string;
      images?: never;
    })
  | { seq?: number; type: "done" }
  | { seq?: number; type: "run-error"; nodeId?: string; error: string; finishedAt?: number };

interface StepResult {
  images: string[];
  model?: string;
  prompts?: string[];
  failures?: RunFailure[];
  providerRequests: number;
}

const DEFAULT_PROMPTS: Partial<Record<NodeExecution["kind"], string>> = {
  "sketch-to-render": "将线稿渲染为写实服装效果图，保持结构与轮廓，高端时装摄影质感",
  "ai-modify": "在保持整体版型不变的前提下，优化服装细节设计",
  "fabric-recolor": "保持服装款式、细节、光影与背景不变，仅替换面料质感",
};

interface Run {
  id: string;
  /** 实时运行数据始终绑定发起用户；不从可选的记录上下文间接推断。 */
  ownerId: string;
  plan: ExecutionPlan;
  emitter: EventEmitter;
  events: RunEvent[]; // 已完成事件（供 SSE 重放）
  finished: boolean;
  createdAt: number;
  recordContext?: GenerationRecordContext;
}

const runs = new Map<string, Run>();

/** 已完成 Run 的保留上限（超出后清理最老的无订阅 Run，防内存无限增长） */
const MAX_FINISHED_RUNS = 50;
/** 已完成 Run 的最大存活时间（30 分钟） */
const FINISHED_RUN_TTL_MS = 30 * 60 * 1000;

/** 清理终态 Run：不影响正在运行或仍有活跃 SSE 订阅的 Run */
function pruneRuns(): void {
  const now = Date.now();
  const finished: Run[] = [];
  for (const run of runs.values()) {
    if (!run.finished) continue;
    if (run.emitter.listenerCount("event") > 0) continue; // 有活跃订阅，不动
    if (now - run.createdAt > FINISHED_RUN_TTL_MS) {
      runs.delete(run.id);
    } else {
      finished.push(run);
    }
  }
  // 超上限：从最老的开始删
  if (finished.length > MAX_FINISHED_RUNS) {
    finished.sort((a, b) => a.createdAt - b.createdAt);
    for (const run of finished.slice(0, finished.length - MAX_FINISHED_RUNS)) {
      runs.delete(run.id);
    }
  }
}

export function getRunForUser(id: string, ownerId: string): Run | undefined {
  const run = runs.get(id);
  return run?.ownerId === ownerId ? run : undefined;
}

export async function createRun(
  plan: ExecutionPlan,
  ownerId: string,
  recordContext?: GenerationRecordContext,
): Promise<Run> {
  if (!ownerId.trim()) throw new Error("run ownerId is required");
  if (recordContext && recordContext.userId !== ownerId) {
    throw new Error("run ownerId must match recordContext.userId");
  }
  pruneRuns();
  const run: Run = {
    id: nanoid(10),
    ownerId,
    plan,
    emitter: new EventEmitter(),
    events: [],
    finished: false,
    createdAt: Date.now(),
    recordContext,
  };
  run.emitter.setMaxListeners(50);
  runs.set(run.id, run);
  if (recordContext) await createGenerationRecord(run.id, recordContext, run.createdAt);
  // 异步启动，调用方先拿到 runId 再订阅事件
  setImmediate(() => {
    executeRun(run).catch(async (err) => {
      const message = err instanceof ProviderError ? publicProviderErrorMessage(err) : err instanceof Error ? err.message : String(err);
      if (run.recordContext) await failGenerationRecord(run.id, message, Date.now());
      emit(run, { type: "run-error", error: message });
    });
  });
  return run;
}

function emit(run: Run, event: RunEvent): void {
  const sequenced = { ...event, seq: run.events.length + 1 };
  run.events.push(sequenced);
  run.emitter.emit("event", sequenced);
  if (sequenced.type === "done" || sequenced.type === "run-error") {
    run.finished = true;
    run.emitter.emit("finish");
  }
}

async function executeRun(run: Run): Promise<void> {
  /** 每个节点的产出图片（统一为 /api/files/:id 引用），供下游节点使用 */
  const outputs = new Map<string, string[]>();

  for (const step of run.plan.steps) {
    // 运行时解析真实输入：优先本次 Run 上游产出，范围外上游回退到计划期快照
    const inputImages = (step.upstream ?? []).flatMap(
      (u) => outputs.get(u.nodeId) ?? u.images,
    );

    if (NODE_SPECS[step.kind].providerId && inputImages.length > MAX_REFERENCE_IMAGES) {
      const message = `Node ${step.nodeId} accepts at most ${MAX_REFERENCE_IMAGES} reference images`;
      const finishedAt = Date.now();
      emit(run, { type: "node-status", nodeId: step.nodeId, status: "error", error: message, finishedAt });
      emit(run, { type: "run-error", nodeId: step.nodeId, error: message, finishedAt });
      return;
    }

    // 运行时最终门禁：即使静态计划中的上游节点实际未产图，也绝不退化成无参考图付费生成。
    if (NODE_SPECS[step.kind].providerId && step.kind !== "sketch-to-render" && inputImages.length === 0) {
      const message = `Node ${step.nodeId} requires an upstream image`;
      const finishedAt = Date.now();
      emit(run, {
        type: "node-status",
        nodeId: step.nodeId,
        status: "error",
        error: message,
        finishedAt,
      });
      emit(run, { type: "run-error", nodeId: step.nodeId, error: message, finishedAt });
      return;
    }

    const startedAt = Date.now();
    if (run.recordContext?.nodeId === step.nodeId) await markGenerationRunning(run.id, startedAt);
    emit(run, { type: "node-status", nodeId: step.nodeId, status: "running", startedAt });
    try {
      const result = await executeStep(step, inputImages);
      // 产出统一落盘为 /api/files/:id，避免 base64 大图驻留事件与内存
      const persisted = await persistOutputImages(result.images);
      if (run.recordContext) {
        await registerGeneratedFiles(run.recordContext, run.id, step.nodeId, persisted, Date.now());
      }
      outputs.set(step.nodeId, persisted);
      const finishedAt = Date.now();
      if (run.recordContext?.nodeId === step.nodeId) {
        await completeGenerationRecord({
          runId: run.id,
          images: persisted,
          prompts: result.prompts,
          failures: result.failures,
          model: result.model,
          providerRequests: result.providerRequests,
          startedAt,
          finishedAt,
        });
      }
      const partialWarning = result.failures?.length
        ? `${result.failures.length} 个生成任务失败`
        : undefined;
      emit(run, {
        type: "node-status",
        nodeId: step.nodeId,
        status: "success",
        images: persisted,
        error: partialWarning,
        model: result.model,
        prompts: result.prompts,
        failures: result.failures,
        startedAt,
        finishedAt,
      });
    } catch (err) {
      const message = err instanceof ProviderError
        ? publicProviderErrorMessage(err)
        : err instanceof Error ? err.message : String(err);
      const finishedAt = Date.now();
      if (run.recordContext?.nodeId === step.nodeId) await failGenerationRecord(run.id, message, finishedAt);
      emit(run, {
        type: "node-status",
        nodeId: step.nodeId,
        status: "error",
        error: message,
        startedAt,
        finishedAt,
      });
      emit(run, { type: "run-error", nodeId: step.nodeId, error: message, finishedAt });
      return; // P0：单步失败即终止整个 run
    }
  }
  emit(run, { type: "done" });
}

/** 产出图片归一化：dataURL / 远程 URL → 落盘为 /api/files/:id；已是本地引用的原样保留 */
async function persistOutputImages(images: string[]): Promise<string[]> {
  return Promise.all(images.map((img) => persistImageRef(img)));
}

async function executeStep(step: NodeExecution, inputImages: string[]): Promise<StepResult> {
  switch (step.kind) {
    case "image-input": {
      const imageUrl = step.params.imageUrl as string | undefined;
      return { images: imageUrl ? [imageUrl] : [], providerRequests: 0 };
    }
    case "result": {
      // 结果节点：汇总上游本次运行的真实产出
      return { images: inputImages, providerRequests: 0 };
    }
    case "sketch-to-render":
    case "ai-modify":
    case "fabric-recolor":
    case "upscale":
    case "print-extract":
    case "print-mutate": {
      const spec = NODE_SPECS[step.kind];
      const provider = getProvider(spec.providerId!);
      const referenceImages = await resolveImageRefs(inputImages);

      // fabric-recolor 的面料参考图（可能不是边连入，而是节点参数）
      const fabricImageUrl = step.params.fabricImageUrl as string | undefined;
      if (step.kind === "fabric-recolor" && fabricImageUrl) {
        referenceImages.push(...(await resolveImageRefs([fabricImageUrl])));
      }
      if (referenceImages.length > MAX_REFERENCE_IMAGES) {
        throw new Error(`Node ${step.nodeId} accepts at most ${MAX_REFERENCE_IMAGES} reference images`);
      }

      const extra = ((step.params.prompt as string) ?? "").trim();

      // 配色替换：每个颜色独立调用，保证一色一图；部分失败也保留成功结果。
      if (step.kind === "fabric-recolor") {
        const colors = Array.isArray(step.params.colors)
          ? step.params.colors.filter((value): value is string => typeof value === "string")
          : [];
        if (colors.length > 0) {
          const images: string[] = [];
          const prompts: string[] = [];
          const failures: RunFailure[] = [];
          let model: string | undefined;
          let providerRequests = 0;
          for (const color of colors) {
            const prompt = buildRecolorPrompt([color]);
            try {
              const result = await generateExactImages(provider, { prompt, referenceImages }, 1);
              providerRequests += result.providerRequests;
              model = result.model;
              for (const image of result.images) {
                images.push(image);
                prompts.push(prompt);
              }
            } catch (err) {
              failures.push({
                prompt,
                error: err instanceof ProviderError
                  ? publicProviderErrorMessage(err)
                  : err instanceof Error ? err.message : String(err),
              });
            }
          }
          if (images.length === 0) {
            throw new Error(failures[0]?.error ?? "全部配色生成失败");
          }
          return { images, prompts, model, providerRequests, failures: failures.length ? failures : undefined };
        }
      }

      // 印花裂变：分批出图（单次最多 4 张）
      if (step.kind === "print-mutate") {
        const count = Math.max(1, Math.min(8, Number(step.params.count) || 4));
        const prompt =
          "基于这张印花图案生成风格一致的新变体：保持原有配色体系、艺术风格与笔触质感，重新编排元素的构图与组合方式，纯白背景，适合作为印花素材复用" +
          (extra ? `。补充要求：${extra}` : "");
        const result = await generateExactImages(provider, { prompt, referenceImages }, count);
        const failures = result.failures.map((error) => ({ prompt, error }));
        return {
          images: result.images,
          prompts: result.images.map(() => prompt),
          model: result.model,
          providerRequests: result.providerRequests,
          failures: failures.length ? failures : undefined,
        };
      }

      const prompt =
        step.kind === "upscale"
          ? "将这张服装效果图放大为超高清版本，增强面料纹理、走线与边缘细节，保持原有构图、色彩和光影完全不变"
          : step.kind === "print-extract"
            ? "提取这件衣服上的印花图案：将印花完整抠出并平铺展开为规整的矩形图案，纯白背景，去除衣身、褶皱、阴影和穿着效果，印花的比例、细节和色彩与原图保持一致，适合作为印花素材复用" +
              (extra ? `。补充要求：${extra}` : "")
            : extra || DEFAULT_PROMPTS[step.kind] || NODE_SPECS[step.kind].description;
      const request = {
        prompt,
        referenceImages: referenceImages.length ? referenceImages : undefined,
        aspectRatio: step.params.aspectRatio as string | undefined,
        batchSize: step.params.batchSize as number | undefined,
        imageSize: step.kind === "upscale" ? (step.params.imageSize as string) : undefined,
      };
      const requestedCount = step.kind === "sketch-to-render" || step.kind === "ai-modify"
        ? Math.max(1, Math.min(4, Number(step.params.batchSize) || 1))
        : 1;
      const result = await generateExactImages(provider, request, requestedCount);
      return {
        images: result.images,
        model: result.model,
        prompts: result.images.map(() => prompt),
        providerRequests: result.providerRequests,
        failures: result.failures.length ? result.failures.map((error) => ({ prompt, error })) : undefined,
      };
    }
  }
}

/**
 * 将节点图片引用统一解析为 dataURL：
 * - data:... 原样返回
 * - /api/files/:id 从 DATA_DIR/uploads 读取转 dataURL
 * - http(s) URL 原样返回（provider 端不支持的由 provider 报错）
 */
export async function resolveImageRefs(refs: string[]): Promise<string[]> {
  return Promise.all(refs.map(normalizeImageRef));
}
