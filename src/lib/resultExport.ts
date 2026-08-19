/** 结果图导出到本地文件夹：File System Access API + IndexedDB 句柄持久化（per-device）。 */
import { imageExtensionFromReference } from "./imageFormat";

const IDB_NAME = "garment-canvas";
const IDB_STORE = "kv";
const DIR_KEY = "resultExportDir";

export type ExportPermission = "unknown" | "granted" | "prompt" | "denied";

export interface SaveResult {
  saved: number;
  savedImages: string[];
  errors: string[];
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

// ---------- 极简 IndexedDB keyval：仅用于持久化目录句柄（句柄无法 JSON 序列化） ----------
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) request.result.createObjectStore(IDB_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const request = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).get(key);
      request.onsuccess = () => resolve(request.result as T | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

async function idbDel(key: string): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// ---------- 目录句柄 ----------
export async function pickExportDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) throw new Error("当前浏览器不支持文件夹选择");
  const handle = await window.showDirectoryPicker({ mode: "readwrite" });
  try {
    await idbSet(DIR_KEY, handle);
  } catch {
    // IndexedDB 不可用时仍允许本次会话使用刚选择的目录。
  }
  return handle;
}

export async function getSavedDirectory(): Promise<FileSystemDirectoryHandle | undefined> {
  if (typeof indexedDB === "undefined") return undefined;
  try {
    return await idbGet<FileSystemDirectoryHandle>(DIR_KEY);
  } catch {
    return undefined;
  }
}

export async function clearSavedDirectory(): Promise<void> {
  try {
    await idbDel(DIR_KEY);
  } catch {
    // ignore
  }
}

/** 查询/申请文件夹读写权限。刷新后权限通常回到 prompt，需一次用户手势重新授权。 */
export async function checkPermission(handle: FileSystemDirectoryHandle, prompt: boolean): Promise<ExportPermission> {
  const options = { mode: "readwrite" as const };
  const query = handle.queryPermission?.bind(handle);
  const request = handle.requestPermission?.bind(handle);
  // 不暴露权限 API 的实现视为已授权（写入失败会在保存阶段作为错误返回）。
  let state: PermissionState = query ? await query(options) : "granted";
  if (state !== "granted" && prompt && request) state = await request(options);
  return state as ExportPermission;
}

// ---------- 纯逻辑（可单测） ----------
function referenceHash(ref: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < ref.length; index += 1) {
    hash ^= ref.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

/** /api/files/:id → garment-<id>.<ext>；其他引用使用稳定哈希，分批保存也不会按序号互相覆盖。 */
export function resultExportFilename(ref: string): string {
  const extension = imageExtensionFromReference(ref);
  const suffix = extension ? `.${extension}` : "";
  const fileId = /\/api\/files\/([A-Za-z0-9_-]+)/.exec(ref)?.[1];
  return fileId ? `garment-${fileId}${suffix}` : `garment-result-${referenceHash(ref)}${suffix}`;
}

/** 自动保存去重：返回 current 中尚未保存过的图。 */
export function pendingExportImages(saved: ReadonlySet<string>, current: readonly string[]): string[] {
  return current.filter((ref) => !saved.has(ref));
}

// ---------- 写盘 ----------
export async function saveImagesToDirectory(
  handle: FileSystemDirectoryHandle,
  images: readonly string[],
): Promise<SaveResult> {
  let saved = 0;
  const savedImages: string[] = [];
  const errors: string[] = [];
  for (const ref of images) {
    try {
      const response = await fetch(ref, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const fileHandle = await handle.getFileHandle(resultExportFilename(ref), { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(blob);
      await writable.close();
      saved += 1;
      savedImages.push(ref);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { saved, savedImages, errors };
}
