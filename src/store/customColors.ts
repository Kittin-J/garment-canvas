/** 用户自定义色板：localStorage 持久化，跨项目/重启保留 */
import { create } from "zustand";

const STORAGE_KEY = "garment-canvas-custom-colors";

interface CustomColorsState {
  colors: string[];
  add: (hex: string) => void;
  remove: (hex: string) => void;
}

function load(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function persist(colors: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    // 存储不可用时静默降级（仅本次会话有效）
  }
}

export const useCustomColors = create<CustomColorsState>((set, get) => ({
  colors: typeof window === "undefined" ? [] : load(),
  add: (hex) => {
    if (get().colors.includes(hex)) return;
    const next = [...get().colors, hex];
    persist(next);
    set({ colors: next });
  },
  remove: (hex) => {
    const next = get().colors.filter((c) => c !== hex);
    persist(next);
    set({ colors: next });
  },
}));
