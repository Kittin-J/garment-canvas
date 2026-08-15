/**
 * Sharp 解码/缩放使用进程外内存。限制本地图片处理并发，避免多个 4K 或多参考图
 * 请求同时展开时叠加占用过多内存；AI 网关请求本身不受此队列限制。
 */
export const MAX_CONCURRENT_IMAGE_PROCESSING = 2;

let active = 0;
const waiters: Array<() => void> = [];

async function acquireImageProcessingSlot(): Promise<() => void> {
  if (active < MAX_CONCURRENT_IMAGE_PROCESSING) {
    active += 1;
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiters.shift();
    if (next) {
      // 将当前占用的名额直接移交给队首，active 保持不变。
      next();
    } else {
      active -= 1;
    }
  };
}

export async function withImageProcessingSlot<T>(work: () => Promise<T>): Promise<T> {
  const release = await acquireImageProcessingSlot();
  try {
    return await work();
  } finally {
    release();
  }
}
