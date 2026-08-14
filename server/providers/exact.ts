import type { AIProvider, ImageGenRequest, ImageGenResult } from "../../src/types/workflow";
import { ProviderError } from "./base";

export interface ExactImageResult extends ImageGenResult {
  providerRequests: number;
  failures: string[];
}

/**
 * 网关可能忽略 n 并只回一张；此处按缺口循环补发，保证所有批量节点行为一致。
 * 每轮最多请求 4 张，总尝试次数有界；部分成功交给上层保留并明确展示 N/M。
 */
export async function generateExactImages(
  provider: AIProvider,
  request: ImageGenRequest,
  requestedCount: number,
): Promise<ExactImageResult> {
  const target = Math.max(1, Math.min(8, Math.floor(requestedCount) || 1));
  const images: string[] = [];
  const failures: string[] = [];
  let model = provider.id;
  let providerRequests = 0;
  let firstError: unknown;
  const maxAttempts = target + 3;

  while (images.length < target && providerRequests < maxAttempts) {
    const remaining = target - images.length;
    const current: ImageGenRequest = { ...request, batchSize: Math.min(4, remaining) };
    providerRequests += 1;
    try {
      const result = current.referenceImages?.length
        ? await provider.edit(current)
        : await provider.generate(current);
      model = result.model;
      const accepted = result.images.filter(Boolean).slice(0, remaining);
      images.push(...accepted);
      if (accepted.length === 0) failures.push("模型未返回图片");
    } catch (error) {
      firstError ??= error;
      failures.push(error instanceof Error ? error.message : String(error));
      if (error instanceof ProviderError && error.status !== undefined && error.status >= 400 && error.status < 500) break;
    }
  }

  if (images.length === 0) throw firstError instanceof Error ? firstError : new Error(failures[0] ?? "模型未返回图片");
  if (images.length < target) failures.push(`只生成了 ${images.length}/${target} 张图片`);
  return { images, model, providerRequests, failures };
}
