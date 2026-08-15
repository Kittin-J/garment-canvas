import sharp from "sharp";
import { withImageProcessingSlot } from "../lib/imageProcessingLimit";
import { parseDataUrl } from "./base";

export const IMAGE2_COLLAGE_LAYOUT = {
  padding: 24,
  gap: 16,
  labelHeight: 48,
  tileSize: 512,
  maxColumns: 4,
} as const;

export const MAX_REFERENCE_INPUT_PIXELS = 40_000_000;

export interface Image2ReferenceUpload {
  buffer: Buffer;
  filename: string;
  mime: string;
}

function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function referenceLabel(index: number): Buffer {
  const { tileSize, labelHeight } = IMAGE2_COLLAGE_LAYOUT;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${tileSize}" height="${labelHeight}">` +
      '<rect width="100%" height="100%" fill="#171717"/>' +
      `<text x="16" y="32" fill="#ffffff" font-family="sans-serif" font-size="22" font-weight="700">Image ${index}</text>` +
    "</svg>",
  );
}

/**
 * GPT image2 edits 只接受单个 `image` 字段。多参考图按业务顺序合成一张带编号的拼图：
 * 从左到右、从上到下依次为 Image 1..N。为避免解码峰值，每张图严格按顺序处理。
 */
export async function prepareImage2ReferenceUpload(referenceImages: string[]): Promise<Image2ReferenceUpload> {
  if (referenceImages.length === 1) {
    const { buffer, mime } = parseDataUrl(referenceImages[0]);
    return {
      buffer,
      filename: `reference-1.${extensionForMime(mime)}`,
      mime,
    };
  }

  return withImageProcessingSlot(async () => {
    const { padding, gap, labelHeight, tileSize, maxColumns } = IMAGE2_COLLAGE_LAYOUT;
    const columns = Math.min(referenceImages.length, maxColumns);
    const rows = Math.ceil(referenceImages.length / columns);
    const width = padding * 2 + columns * tileSize + (columns - 1) * gap;
    const height = padding * 2 + rows * (labelHeight + tileSize) + (rows - 1) * gap;

    const tiles: Buffer[] = [];
    for (const referenceImage of referenceImages) {
      const { buffer } = parseDataUrl(referenceImage);
      const tile = await sharp(buffer, {
        animated: false,
        failOn: "warning",
        limitInputPixels: MAX_REFERENCE_INPUT_PIXELS,
        sequentialRead: true,
      })
        .rotate()
        .resize(tileSize, tileSize, {
          fit: "contain",
          background: { r: 255, g: 255, b: 255, alpha: 1 },
        })
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .png()
        .toBuffer();
      tiles.push(tile);
    }

    const inputs: Array<{ input: Buffer; left: number; top: number }> = [];
    for (let index = 0; index < tiles.length; index += 1) {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const left = padding + column * (tileSize + gap);
      const top = padding + row * (labelHeight + tileSize + gap);
      inputs.push({ input: referenceLabel(index + 1), left, top });
      inputs.push({ input: tiles[index], left, top: top + labelHeight });
    }

    const buffer = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 244, g: 244, b: 244 },
      },
    })
      .composite(inputs)
      .png()
      .toBuffer();

    return {
      buffer,
      filename: "numbered-references.png",
      mime: "image/png",
    };
  });
}

export function promptWithImageLayout(prompt: string, referenceCount: number): string {
  if (referenceCount <= 1) return prompt;
  return `Reference collage: Image 1..${referenceCount} are arranged row by row, left to right, then top to bottom.\n${prompt}`;
}
