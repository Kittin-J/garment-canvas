import { useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { useFlowStore } from "@/store/flowStore";
import { useCustomColors } from "@/store/customColors";
import { isNodeRunActive, type FabricRecolorNodeData } from "@/types/workflow";
import { NodeFrame, RunButton, Developing } from "./NodeFrame";
import { ImageGrid } from "./ImageGrid";
import { ModelControls } from "./ModelControls";
import {
  COLOR_CATEGORIES,
  buildRecolorPrompt,
  isValidHex,
  nameOfColor,
  normalizeHex,
} from "@/lib/colors";

const MAX_COLORS = 8;
const CUSTOM_CATEGORY_ID = "custom";

export function FabricRecolorNode({
  id,
  data,
  selected,
}: NodeProps<Node<FabricRecolorNodeData>>) {
  const updateNodeData = useFlowStore((s) => s.updateNodeData);
  const runNode = useFlowStore((s) => s.runNode);
  const cancelNodeRun = useFlowStore((s) => s.cancelNodeRun);
  const hasFabricInput = useFlowStore((s) =>
    s.edges.some((e) => e.target === id && e.targetHandle === "fabric"),
  );
  const running = isNodeRunActive(data.status);

  const colors = data.colors ?? [];
  const [hexInput, setHexInput] = useState("");
  const [categoryId, setCategoryId] = useState(COLOR_CATEGORIES[0].id);

  const customColors = useCustomColors((s) => s.colors);
  const addCustomColor = useCustomColors((s) => s.add);
  const removeCustomColor = useCustomColors((s) => s.remove);

  /** 页签 = 三个预置分类 + 自定义色 */
  const tabs = [
    ...COLOR_CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
    { id: CUSTOM_CATEGORY_ID, label: "自定义色" },
  ];

  /** 当前页签展示的色块（自定义页签取用户保存的颜色，名即色值） */
  const activeSwatches =
    categoryId === CUSTOM_CATEGORY_ID
      ? customColors.map((hex) => ({ name: hex, hex }))
      : (COLOR_CATEGORIES.find((c) => c.id === categoryId) ?? COLOR_CATEGORIES[0]).swatches;

  const applyColors = (next: string[]) => {
    updateNodeData(id, {
      colors: next,
      prompt: next.length > 0 ? buildRecolorPrompt(next) : "",
      error: undefined,
    });
  };

  const toggleColor = (hex: string) => {
    if (colors.includes(hex)) {
      applyColors(colors.filter((c) => c !== hex));
    } else if (colors.length < MAX_COLORS) {
      applyColors([...colors, hex]);
    }
  };

  const addCustomHex = () => {
    if (!isValidHex(hexInput)) return;
    const hex = normalizeHex(hexInput);
    addCustomColor(hex); // 保存到自定义色分类（localStorage 持久化）
    if (!colors.includes(hex) && colors.length < MAX_COLORS) {
      applyColors([...colors, hex]);
    }
    setHexInput("");
  };

  return (
    <>
      <Handle
        type="target"
        position={Position.Left}
        id="garment"
        style={{ top: "32%" }}
        title="款式图输入"
      />
      <Handle
        type="target"
        position={Position.Left}
        id="fabric"
        style={{ top: "68%" }}
        title="面料图输入"
      />
      <NodeFrame nodeId={id} title={data.label} status={data.status} error={data.error} selected={selected}>
        <div className="rounded-md border border-[#262626] bg-[#0f0f0f] px-2 py-1.5 text-[10px] leading-relaxed text-neutral-500">
          左侧输入口：上 = 款式/补充参考，下 = 面料参考；总计最多 8 图
        </div>

        {/* 已选配色（最多 3 色，点击移除） */}
        <div className="flex min-h-[22px] flex-wrap items-center gap-1 rounded-md border border-[#262626] bg-[#0f0f0f] px-1.5 py-1">
          {colors.length === 0 ? (
            <span className="text-[10px] text-neutral-600">已选配色（最多 8 色，每色出 1 张图）</span>
          ) : (
            colors.map((hex) => (
              <button
                key={hex}
                type="button"
                onClick={() => toggleColor(hex)}
                title={`${nameOfColor(hex)} ${hex} · 点击移除`}
                className="flex items-center gap-1 rounded-sm border border-[#333] bg-[#161616] px-1 py-0.5 text-[9px] text-neutral-300 hover:border-red-400/60"
              >
                <span
                  className="h-2.5 w-2.5 rounded-[2px]"
                  style={{ backgroundColor: hex }}
                />
                {nameOfColor(hex)}
              </button>
            ))
          )}
        </div>

        {/* 色板常显：分类页签 + 色块网格 */}
        <div className="nodrag rounded-md border border-[#262626] bg-[#161616] p-1.5">
          <div className="mb-1.5 grid grid-cols-4 gap-1">
            {tabs.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => setCategoryId(cat.id)}
                className={`rounded-sm border px-1 py-1 text-[10px] transition-colors ${
                  cat.id === categoryId
                    ? "border-[#C9A66B] bg-[#C9A66B]/15 text-[#C9A66B]"
                    : "border-[#333] text-neutral-400 hover:border-[#C9A66B]/40"
                }`}
              >
                {cat.label}
              </button>
            ))}
          </div>

          <div className="grid max-h-[132px] grid-cols-6 gap-1 overflow-y-auto pr-0.5">
            {activeSwatches.length === 0 && categoryId === CUSTOM_CATEGORY_ID ? (
              <span className="col-span-6 py-2 text-center text-[10px] text-neutral-600">
                还没有自定义颜色，用下方取色器添加
              </span>
            ) : (
              activeSwatches.map((c) => {
                const active = colors.includes(c.hex);
                return (
                  <button
                    key={c.hex}
                    type="button"
                    title={`${c.name} ${c.hex}`}
                    onClick={() => toggleColor(c.hex)}
                    onContextMenu={(e) => {
                      // 自定义色：右键从色板删除
                      if (categoryId === CUSTOM_CATEGORY_ID) {
                        e.preventDefault();
                        removeCustomColor(c.hex);
                      }
                    }}
                    className="flex flex-col items-center gap-0.5"
                  >
                    <span
                      className={`h-5 w-full rounded-sm border transition-transform hover:scale-105 ${
                        active
                          ? "border-[#C9A66B] ring-1 ring-[#C9A66B]"
                          : "border-white/15"
                      }`}
                      style={{ backgroundColor: c.hex }}
                    />
                    <span
                      className={`w-full truncate text-center text-[8px] leading-tight ${
                        active ? "text-[#C9A66B]" : "text-neutral-500"
                      }`}
                    >
                      {c.name}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {/* 自定义色值输入（仅在自定义色页签内显示） */}
          {categoryId === CUSTOM_CATEGORY_ID && (
            <div className="mt-1.5 flex items-center gap-1">
              <input
                type="color"
                value={isValidHex(hexInput) ? normalizeHex(hexInput) : "#C9A66B"}
                onChange={(e) => setHexInput(e.target.value)}
                className="h-6 w-7 cursor-pointer rounded-sm border border-[#333] bg-transparent p-0"
                title="自定义取色"
              />
              <input
                value={hexInput}
                onChange={(e) => setHexInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCustomHex()}
                placeholder="#RRGGBB"
                className="h-6 flex-1 rounded-sm border border-[#333] bg-[#0f0f0f] px-1.5 font-mono text-[10px] text-neutral-200 outline-none focus:border-[#C9A66B]/60"
              />
              <button
                type="button"
                onClick={addCustomHex}
                disabled={!isValidHex(hexInput)}
                className="h-6 rounded-sm border border-[#333] px-2 text-[10px] text-neutral-300 hover:border-[#C9A66B]/60 disabled:opacity-40"
              >
                添加
              </button>
            </div>
          )}
        </div>

        <ModelControls nodeId={id} modelId={data.modelId} modelOptions={data.modelOptions} disabled={running} />
        <RunButton
          status={data.status}
          onClick={() => void runNode(id)}
          onCancel={() => void cancelNodeRun(id)}
          label="替换面料配色"
          disabled={colors.length === 0 && !hasFabricInput}
        />
        {running && <Developing />}
        <ImageGrid images={data.outputImages} />
      </NodeFrame>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
