import fs from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";

/**
 * 同目录临时文件 + rename，避免进程崩溃时留下半截 JSON。rename 在同一文件系统内
 * 是原子的；失败时尽力清理临时文件，但绝不覆盖原文件。
 */
export function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${nanoid(6)}.tmp`);
  try {
    const fd = fs.openSync(tempPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // 临时文件可能尚未创建，或已经成功 rename。
    }
    throw error;
  }
}
