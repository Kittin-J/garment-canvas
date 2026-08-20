import type { AIProvider, ImageGenRequest, ImageGenResult } from "../../src/types/workflow";
import { ProviderError, publicProviderErrorMessage, sanitizedProviderDiagnostic } from "./base";

export interface ExactImageResult extends ImageGenResult {
  providerRequests: number;
  failures: string[];
}

export interface ExactImageOptions {
  runId?: string;
  nodeId?: string;
  /** Worker 在实际发出每一次可能计费的上游请求前持久化 attempt_started_at。 */
  beforeProviderCall?: (providerRequest: number) => void | Promise<void>;
}

function logProviderFailure(provider: AIProvider, error: ProviderError, options: ExactImageOptions, attempt: number): void {
  console.error("[ai-provider-failure]", JSON.stringify({
    runId: options.runId ?? "unknown",
    nodeId: options.nodeId ?? "unknown",
    providerId: error.providerId ?? provider.id,
    status: error.status ?? null,
    category: error.category,
    attempt,
    diagnostic: sanitizedProviderDiagnostic(error) ?? error.message,
  }));
}

/**
 * 网关可能忽略 n 并只回一张；此处按缺口循环补发，保证所有批量节点行为一致。
 * 每轮最多请求 4 张，总请求次数有界；重试由 PostgreSQL Worker 统一调度。
 * 一旦已经拿到部分成功结果，后续失败立即停止，绝不重放此前成功的调用。
 */
export async function generateExactImages(
  provider: AIProvider,
  request: ImageGenRequest,
  requestedCount: number,
  options: ExactImageOptions = {},
): Promise<ExactImageResult> {
  const target = Math.max(1, Math.min(8, Math.floor(requestedCount) || 1));
  const images: string[] = [];
  const providerOutputSizes: Array<string | null> = [];
  const failures: string[] = [];
  let model = provider.id;
  let providerRequests = 0;
  let firstError: unknown;
  const maxRequests = target;

  while (images.length < target && providerRequests < maxRequests) {
    const remaining = target - images.length;
    const current: ImageGenRequest = { ...request, batchSize: Math.min(4, remaining) };
    const mode = current.referenceImages?.length ? "edit" : "generate";
    await provider.validate?.(current, mode);
    await options.beforeProviderCall?.(providerRequests + 1);
    providerRequests += 1;
    try {
      const result = mode === "edit"
        ? await provider.edit(current)
        : await provider.generate(current);
      model = result.model;
      const accepted = result.images
        .map((image, index) => ({ image, providerOutputSize: result.providerOutputSizes?.[index] ?? null }))
        .filter((item) => Boolean(item.image))
        .slice(0, remaining);
      images.push(...accepted.map((item) => item.image));
      providerOutputSizes.push(...accepted.map((item) => item.providerOutputSize));
      if (accepted.length === 0) {
        failures.push("模型未返回图片");
        break;
      }
    } catch (error) {
      firstError ??= error;
      if (error instanceof ProviderError) logProviderFailure(provider, error, options, providerRequests);
      if (error instanceof ProviderError && error.category === "outcome_unknown") throw error;
      if (images.length > 0) {
        failures.push(publicProviderErrorMessage(error));
        break;
      }
      failures.push(publicProviderErrorMessage(error));
      break;
    }
  }

  if (images.length === 0) throw firstError instanceof Error ? firstError : new Error(failures[0] ?? "模型未返回图片");
  if (images.length < target) failures.push(`只生成了 ${images.length}/${target} 张图片`);
  return {
    images,
    model,
    providerRequests,
    failures,
    providerOutputSizes: providerOutputSizes.some((size) => size !== null) ? providerOutputSizes : undefined,
  };
}
