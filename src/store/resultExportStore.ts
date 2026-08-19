/** 结果图本地保存文件夹：per-device 配置。目录句柄存 IndexedDB，autoSave 存 localStorage。 */
import { create } from "zustand";
import {
  checkPermission,
  clearSavedDirectory,
  getSavedDirectory,
  pickExportDirectory,
  saveImagesToDirectory,
  supportsDirectoryPicker,
  type ExportPermission,
  type SaveResult,
} from "@/lib/resultExport";

const AUTO_KEY = "garment-canvas-result-autosave";

function loadAutoSave(): boolean {
  try {
    return window.localStorage.getItem(AUTO_KEY) === "1";
  } catch {
    return false;
  }
}

function persistAutoSave(value: boolean): void {
  try {
    window.localStorage.setItem(AUTO_KEY, value ? "1" : "0");
  } catch {
    // 存储不可用时静默降级（仅本次会话有效）
  }
}

interface ResultExportState {
  supported: boolean;
  handle: FileSystemDirectoryHandle | null;
  directoryName: string | null;
  autoSave: boolean;
  permission: ExportPermission;
  hydrate: () => Promise<void>;
  chooseDirectory: () => Promise<void>;
  clearDirectory: () => Promise<void>;
  setAutoSave: (value: boolean) => void;
  saveAll: (images: readonly string[], opts?: { prompt?: boolean }) => Promise<SaveResult>;
}

export const useResultExport = create<ResultExportState>((set, get) => ({
  supported: supportsDirectoryPicker(),
  handle: null,
  directoryName: null,
  autoSave: typeof window === "undefined" ? false : loadAutoSave(),
  permission: "unknown",
  hydrate: async () => {
    if (!get().supported) return;
    const handle = await getSavedDirectory();
    if (!handle) return;
    try {
      const permission = await checkPermission(handle, false);
      set({ handle, directoryName: handle.name, permission });
    } catch {
      await clearSavedDirectory();
      set({ handle: null, directoryName: null, permission: "unknown" });
    }
  },
  chooseDirectory: async () => {
    const handle = await pickExportDirectory();
    const permission = await checkPermission(handle, false);
    set({ handle, directoryName: handle.name, permission });
  },
  clearDirectory: async () => {
    await clearSavedDirectory();
    set({ handle: null, directoryName: null, permission: "unknown" });
  },
  setAutoSave: (value) => {
    persistAutoSave(value);
    set({ autoSave: value });
  },
  saveAll: async (images, opts) => {
    const handle = get().handle;
    if (!handle) return { saved: 0, savedImages: [], errors: ["未设置保存文件夹"] };
    try {
      const permission = await checkPermission(handle, opts?.prompt ?? true);
      set({ permission });
      if (permission !== "granted") return { saved: 0, savedImages: [], errors: ["未获得文件夹写入授权"] };
      return saveImagesToDirectory(handle, images);
    } catch (error) {
      return {
        saved: 0,
        savedImages: [],
        errors: [error instanceof Error ? error.message : String(error)],
      };
    }
  },
}));

// 启动即从 IndexedDB 恢复目录句柄（不弹窗）
if (typeof window !== "undefined") void useResultExport.getState().hydrate();
