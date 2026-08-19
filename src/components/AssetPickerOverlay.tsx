import { useCallback, useEffect, useRef, useState } from "react";
import { useFlowStore } from "@/store/flowStore";
import type { Asset } from "@/types/workflow";
import { thumbnailImageUrl } from "@/lib/images";

/** 图片上传节点「从素材库选择」派发此事件来打开选择器 */
export const OPEN_ASSET_PICKER_EVENT = "garment:open-asset-picker";

export interface AssetPickerRequest {
  tabId: string;
  nodeId: string;
}

const CATEGORY_TABS = [
  ["all", "全部"],
  ["print", "印花"],
  ["fabric", "面料"],
  ["reference", "参考"],
] as const;

type CategoryFilter = (typeof CATEGORY_TABS)[number][0];

const PAGE_SIZE = 20;

/** 素材库选择浮层：按分类筛选 + 名称搜索，选中后写回目标图片上传节点 */
export function AssetPickerOverlay() {
  const updateNodeDataInTab = useFlowStore((s) => s.updateNodeDataInTab);
  const [target, setTarget] = useState<AssetPickerRequest | null>(null);
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<AssetPickerRequest>).detail;
      if (!detail?.tabId || !detail?.nodeId) return;
      setTarget(detail);
      setCategory("all");
      setSearch("");
      setDebouncedSearch("");
    };
    window.addEventListener(OPEN_ASSET_PICKER_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ASSET_PICKER_EVENT, onOpen);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async (offset: number) => {
    const generation = offset === 0 ? requestGeneration.current + 1 : requestGeneration.current;
    if (offset === 0) {
      requestGeneration.current = generation;
      setAssets([]);
      setHasMore(false);
    }
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (category !== "all") params.set("category", category);
      if (debouncedSearch) params.set("search", debouncedSearch);
      const res = await fetch(`/api/assets?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as Asset[];
      if (!Array.isArray(page)) throw new Error("素材数据格式无效");
      if (generation !== requestGeneration.current) return;
      setAssets((current) => {
        if (offset === 0) return page;
        const ids = new Set(current.map((asset) => asset.id));
        return [...current, ...page.filter((asset) => !ids.has(asset.id))];
      });
      setHasMore(page.length === PAGE_SIZE);
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [category, debouncedSearch]);

  // 打开、切换分类或搜索词变化时都从第一页重新拉取
  useEffect(() => {
    if (!target) {
      requestGeneration.current += 1;
      return;
    }
    void load(0);
  }, [target, load]);

  useEffect(() => {
    if (!target) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTarget(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target]);

  if (!target) return null;

  const pick = (asset: Asset) => {
    // 选择器打开期间目标页签或节点可能已被关闭/删除，写回前再校验一次
    const exists = useFlowStore.getState().tabs.some((tab) =>
      tab.id === target.tabId && tab.nodes.some((node) => node.id === target.nodeId),
    );
    if (exists) {
      updateNodeDataInTab(target.tabId, target.nodeId, {
        imageUrl: asset.image,
        status: "success",
        error: undefined,
      });
    }
    setTarget(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={() => setTarget(null)}
    >
      <div
        className="flex max-h-[80vh] w-[min(680px,90vw)] flex-col rounded-lg border border-[#262626] bg-[#141414]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[#262626] px-4 py-3">
          <span className="text-xs font-medium tracking-widest text-neutral-400">从素材库选择</span>
          <button
            type="button"
            onClick={() => setTarget(null)}
            className="rounded border border-[#262626] px-2 py-1 text-[10px] text-neutral-500 hover:border-gold/50 hover:text-gold"
          >
            关闭
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-[#262626] px-4 py-2.5">
          <div className="flex gap-1">
            {CATEGORY_TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setCategory(key)}
                className={`rounded border px-2 py-1 text-[10px] transition-colors ${
                  category === key
                    ? "border-gold/60 text-gold"
                    : "border-[#262626] text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索素材名称"
            className="ml-auto w-44 rounded border border-[#262626] bg-[#0f0f0f] px-2 py-1 text-[10px] text-neutral-200 placeholder:text-neutral-600 focus:border-gold/60 focus:outline-none"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="py-6 text-center">
              <p className="text-[10px] text-neutral-600">素材服务暂不可用（{error}）</p>
              <button
                type="button"
                onClick={() => void load(0)}
                className="mt-2 rounded border border-[#262626] px-2 py-1 text-[10px] text-neutral-400 hover:border-gold/50 hover:text-gold"
              >
                重试
              </button>
            </div>
          )}
          {!error && loading && assets.length === 0 && (
            <p className="py-6 text-center text-[10px] text-neutral-600">加载中…</p>
          )}
          {!error && !loading && assets.length === 0 && (
            <p className="py-6 text-center text-[10px] text-neutral-600">
              {debouncedSearch ? "没有匹配的素材" : "暂无素材，可在印花提取节点中「存为素材」"}
            </p>
          )}
          {assets.length > 0 && (
            <div className="grid grid-cols-4 gap-2.5">
              {assets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  onClick={() => pick(asset)}
                  title={asset.name}
                  className="overflow-hidden rounded-md border border-[#262626] bg-[#1a1a1a] text-left transition-colors hover:border-gold/60"
                >
                  <img
                    src={asset.thumbnail ?? thumbnailImageUrl(asset.image)}
                    alt={asset.name}
                    loading="lazy"
                    decoding="async"
                    className="aspect-square w-full bg-[#0f0f0f] object-cover"
                  />
                  <div className="truncate px-1.5 py-1 text-[10px] text-neutral-300">{asset.name}</div>
                </button>
              ))}
            </div>
          )}
          {hasMore && (
            <button
              type="button"
              onClick={() => void load(assets.length)}
              disabled={loading}
              className="mt-2.5 w-full rounded-md border border-dashed border-[#262626] px-3 py-2 text-[10px] text-neutral-500 hover:border-gold/60 hover:text-gold disabled:opacity-50"
            >
              {loading ? "加载中…" : "加载更多素材"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
