/** 服装行业常用色板（面料/配色替换节点用）：三大类，色板在节点上常显 */

export interface ColorSwatch {
  name: string;
  hex: string;
}

export interface ColorCategory {
  id: string;
  label: string;
  swatches: ColorSwatch[];
}

export const COLOR_CATEGORIES: ColorCategory[] = [
  {
    id: "neutral",
    label: "中性基础色",
    swatches: [
      { name: "碳素黑", hex: "#161616" },
      { name: "棕黑", hex: "#2B1D16" },
      { name: "炭黑", hex: "#1A1A1A" },
      { name: "暮色灰", hex: "#6B6B70" },
      { name: "烟灰", hex: "#6E6E6E" },
      { name: "深海鸥灰", hex: "#8B9296" },
      { name: "水泥灰", hex: "#9A9A98" },
      { name: "大象灰", hex: "#8A8378" },
      { name: "暮沙灰", hex: "#A39B8B" },
      { name: "云烟灰", hex: "#B9B7B2" },
      { name: "浅灰", hex: "#C8C8C8" },
      { name: "珍珠白", hex: "#F2EFE9" },
      { name: "燕麦白", hex: "#EDE6D6" },
      { name: "玛瑙白", hex: "#E9E4DA" },
      { name: "米白", hex: "#F5F0E6" },
      { name: "柔和米", hex: "#E5DCC8" },
      { name: "奶杏米", hex: "#F0E4CE" },
      { name: "纯白", hex: "#FFFFFF" },
      { name: "香槟色", hex: "#F0DCB8" },
      { name: "驼色", hex: "#C19A6B" },
      { name: "卡其", hex: "#B8A47E" },
      { name: "咖啡", hex: "#6F4E37" },
      { name: "榉木色", hex: "#A67B4F" },
      { name: "焦糖", hex: "#A0522D" },
    ],
  },
  {
    id: "warm",
    label: "暖色系",
    swatches: [
      // 红
      { name: "熔岩红", hex: "#B03A2E" },
      { name: "中国红", hex: "#DE2910" },
      { name: "正红", hex: "#C8102E" },
      { name: "樱桃红", hex: "#C2183C" },
      { name: "波艮第红", hex: "#5C1A24" },
      { name: "酒红", hex: "#722F37" },
      { name: "梅洛葡萄酒红", hex: "#6E2438" },
      { name: "砖红", hex: "#B5493A" },
      // 粉
      { name: "莓果粉", hex: "#D98CA6" },
      { name: "芭比粉", hex: "#E0219C" },
      { name: "珊瑚粉", hex: "#F88379" },
      { name: "藕粉", hex: "#E8C4C4" },
      { name: "玫瑰茶", hex: "#C08585" },
      { name: "雾玫瑰色", hex: "#B48A8C" },
      { name: "灰粉玫", hex: "#C4A4A8" },
      { name: "玫瑰金", hex: "#B76E79" },
      // 橙
      { name: "爱马仕橙", hex: "#F37021" },
      { name: "橘橙", hex: "#E8752A" },
      { name: "柳橙汁橘", hex: "#F28C28" },
      { name: "香瓜橙", hex: "#F2A65A" },
      { name: "柔和桃", hex: "#F5CBA7" },
      // 黄/金
      { name: "芦苇黄", hex: "#D9C97A" },
      { name: "透明黄", hex: "#F5E663" },
      { name: "鹅黄", hex: "#F2D16B" },
      { name: "姜黄", hex: "#D9A441" },
      { name: "金麦黄", hex: "#D9B24A" },
      { name: "琥珀黄", hex: "#D99400" },
      { name: "金棕榈色", hex: "#C9A227" },
      { name: "金合欢", hex: "#C77F2F" },
      { name: "香槟金", hex: "#D4C5A0" },
      // 棕/赭
      { name: "赤褐赭", hex: "#8C4A2F" },
      { name: "栗赤色", hex: "#7A3B2E" },
      { name: "红棕色", hex: "#8B3A2A" },
      { name: "拿铁棕", hex: "#9C7A5B" },
      { name: "路易威登棕", hex: "#4E3424" },
      { name: "凡戴克棕", hex: "#3D2B1F" },
      { name: "深焙棕", hex: "#4A2E1E" },
      { name: "巧克力色", hex: "#5C3A24" },
      { name: "熔岩烟雾", hex: "#7A6E6A" },
    ],
  },
  {
    id: "cool",
    label: "冷色系",
    swatches: [
      // 绿
      { name: "翠玉绿", hex: "#2E8B6E" },
      { name: "墨绿", hex: "#1F3D2B" },
      { name: "深苔绿", hex: "#3B4A2F" },
      { name: "深橄榄绿", hex: "#4A5423" },
      { name: "橄榄绿", hex: "#6B7C4A" },
      { name: "莳萝绿", hex: "#6E7F4E" },
      { name: "豚草绿", hex: "#8A9A4B" },
      { name: "薄荷绿", hex: "#98D8C8" },
      // 蓝
      { name: "蒂芙尼蓝", hex: "#81D8D0" },
      { name: "海滨蓝", hex: "#4FA3C2" },
      { name: "卡布里蓝", hex: "#3579A8" },
      { name: "远山蓝", hex: "#7B9BB8" },
      { name: "雾霾蓝", hex: "#8FA8BF" },
      { name: "牛仔蓝", hex: "#3B5B7C" },
      { name: "藏青", hex: "#1B2A4A" },
      { name: "群青", hex: "#4166B0" },
      { name: "克莱因蓝", hex: "#002FA7" },
      { name: "灵气靛蓝", hex: "#3F4E8C" },
      // 紫
      { name: "苋菜紫", hex: "#9B2D5F" },
      { name: "紫罗兰色", hex: "#7F5AA2" },
      { name: "薰衣草紫", hex: "#B4A7D6" },
      { name: "香芋紫", hex: "#B8A9C9" },
      { name: "烟熏紫", hex: "#6E5A72" },
      { name: "深紫", hex: "#4A3B5C" },
      { name: "银灰", hex: "#C0C0C0" },
    ],
  },
];

export const COLOR_PRESETS: ColorSwatch[] = COLOR_CATEGORIES.flatMap((c) => c.swatches);

export function nameOfColor(hex: string): string {
  return COLOR_PRESETS.find((c) => c.hex.toLowerCase() === hex.toLowerCase())?.name ?? hex;
}

/** 由选中颜色自动组装替换指令（替代原手填 prompt） */
export function buildRecolorPrompt(colors: string[]): string {
  const list = colors.map((hex) => `${nameOfColor(hex)}(${hex})`).join("、");
  return `保持服装的版型、款式细节、构图和光线完全不变，仅将面料配色替换为：${list}。配色应用于面料主体，呈现真实面料质感与准确色彩，无文字无水印。`;
}

/** 校验 #RGB / #RRGGBB */
export function isValidHex(value: string): boolean {
  return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

/** 归一化为 #RRGGBB 大写 */
export function normalizeHex(value: string): string {
  let v = value.trim();
  if (!v.startsWith("#")) v = `#${v}`;
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  }
  return v.toUpperCase();
}
