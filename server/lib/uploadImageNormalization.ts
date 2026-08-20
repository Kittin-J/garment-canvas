import sharp, { type Metadata, type OutputInfo } from "sharp";
import contracts from "../../docs/ai/apiyi/model-contracts.json";
import { withImageProcessingSlot } from "./imageProcessingLimit";
import { ImageValidationError, validateImageDataUrl } from "./imageValidation";

const inputContract = contracts.inputNormalization;

export const UPLOAD_MAX_INPUT_BYTES = inputContract.maxInputBytes;
export const UPLOAD_MAX_INPUT_PIXELS = inputContract.maxInputPixels;
export const UPLOAD_MAX_LONG_EDGE = inputContract.maxLongEdge;
export const UPLOAD_TARGET_BYTES = inputContract.targetBytes;
export const UPLOAD_JPEG_QUALITY = inputContract.jpegQuality.initial;
export const UPLOAD_MIN_JPEG_QUALITY = inputContract.jpegQuality.minimum;

const MIN_SHRINK_LONG_EDGE = 256;
const SHARP_INPUT_OPTIONS = {
  animated: false,
  failOn: "error" as const,
  limitInputPixels: UPLOAD_MAX_INPUT_PIXELS,
  sequentialRead: true,
};

export type NormalizedUploadMime = "image/png" | "image/jpeg";

export interface NormalizedUploadImage {
  buffer: Buffer;
  mimeType: NormalizedUploadMime;
  width: number;
  height: number;
  byteLength: number;
  normalized: true;
}

interface EncodedImage {
  buffer: Buffer;
  info: OutputInfo;
}

function orientedDimensions(metadata: Metadata): { width: number; height: number } {
  if (!metadata.width || !metadata.height) {
    throw new ImageValidationError("无法读取图片尺寸，请换一张标准 PNG、JPEG、WebP 或 GIF 图片");
  }
  if (metadata.width * metadata.height > UPLOAD_MAX_INPUT_PIXELS) {
    throw new ImageValidationError(
      `图片像素过大（最多 ${UPLOAD_MAX_INPUT_PIXELS.toLocaleString("en-US")} 像素），请缩小后重试`,
    );
  }
  const swapsAxes = metadata.orientation !== undefined && metadata.orientation >= 5 && metadata.orientation <= 8;
  return swapsAxes
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
}

function dimensionsWithinLongEdge(width: number, height: number): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= UPLOAD_MAX_LONG_EDGE) return { width, height };
  const scale = UPLOAD_MAX_LONG_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function smallerDimensions(
  width: number,
  height: number,
  encodedBytes: number,
): { width: number; height: number } {
  const longEdge = Math.max(width, height);
  if (longEdge <= MIN_SHRINK_LONG_EDGE) {
    throw new ImageValidationError("图片内容过于复杂，压缩后仍超过 1.5MB，请先裁剪图片后重试");
  }
  const estimated = Math.sqrt(UPLOAD_TARGET_BYTES / Math.max(encodedBytes, 1)) * 0.96;
  const scale = Math.max(0.5, Math.min(0.9, estimated));
  const next = {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
  if (next.width === width && next.height === height) {
    return width >= height
      ? { width: width - 1, height }
      : { width, height: height - 1 };
  }
  return next;
}

function pipeline(buffer: Buffer, width: number, height: number) {
  return sharp(buffer, SHARP_INPUT_OPTIONS)
    .rotate()
    .resize({ width, height, fit: "fill" })
    .toColourspace("srgb");
}

async function encodeJpeg(buffer: Buffer, width: number, height: number, quality: number): Promise<EncodedImage> {
  const result = await pipeline(buffer, width, height)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { buffer: result.data, info: result.info };
}

async function encodeOpaqueWithinLimit(
  buffer: Buffer,
  initialWidth: number,
  initialHeight: number,
): Promise<EncodedImage> {
  let width = initialWidth;
  let height = initialHeight;
  for (;;) {
    const high = await encodeJpeg(buffer, width, height, UPLOAD_JPEG_QUALITY);
    if (high.buffer.byteLength <= UPLOAD_TARGET_BYTES) return high;

    const low = await encodeJpeg(buffer, width, height, UPLOAD_MIN_JPEG_QUALITY);
    if (low.buffer.byteLength <= UPLOAD_TARGET_BYTES) {
      let best = low;
      let left = UPLOAD_MIN_JPEG_QUALITY + 1;
      let right = UPLOAD_JPEG_QUALITY - 1;
      while (left <= right) {
        const quality = Math.floor((left + right) / 2);
        const candidate = await encodeJpeg(buffer, width, height, quality);
        if (candidate.buffer.byteLength <= UPLOAD_TARGET_BYTES) {
          best = candidate;
          left = quality + 1;
        } else {
          right = quality - 1;
        }
      }
      return best;
    }
    ({ width, height } = smallerDimensions(width, height, low.buffer.byteLength));
  }
}

async function encodeTransparentWithinLimit(
  buffer: Buffer,
  initialWidth: number,
  initialHeight: number,
): Promise<EncodedImage> {
  let width = initialWidth;
  let height = initialHeight;
  for (;;) {
    const result = await pipeline(buffer, width, height)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer({ resolveWithObject: true });
    if (result.data.byteLength <= UPLOAD_TARGET_BYTES) return { buffer: result.data, info: result.info };
    ({ width, height } = smallerDimensions(width, height, result.data.byteLength));
  }
}

async function hasMeaningfulAlpha(buffer: Buffer, metadata: Metadata): Promise<boolean> {
  if (!metadata.hasAlpha) return false;
  const alpha = await sharp(buffer, SHARP_INPUT_OPTIONS)
    .rotate()
    .ensureAlpha()
    .extractChannel("alpha")
    .raw()
    .toBuffer();
  return alpha.some((value) => value < 255);
}

/**
 * API易输入素材标准化：校正 EXIF、动图取首帧、转换到 sRGB，并收敛尺寸与体积。
 * 透明素材保存为 PNG，其余素材保存为 JPEG，输出不携带原始 EXIF/ICC 元数据。
 */
export async function normalizeUploadImageDataUrl(dataUrl: unknown): Promise<NormalizedUploadImage> {
  const validated = validateImageDataUrl(dataUrl, UPLOAD_MAX_INPUT_BYTES);
  try {
    return await withImageProcessingSlot(async () => {
      const metadata = await sharp(validated.buffer, SHARP_INPUT_OPTIONS).metadata();
      const oriented = orientedDimensions(metadata);
      const target = dimensionsWithinLongEdge(oriented.width, oriented.height);
      const transparent = await hasMeaningfulAlpha(validated.buffer, metadata);
      const encoded = transparent
        ? await encodeTransparentWithinLimit(validated.buffer, target.width, target.height)
        : await encodeOpaqueWithinLimit(validated.buffer, target.width, target.height);
      if (!encoded.info.width || !encoded.info.height) {
        throw new ImageValidationError("标准化后无法读取图片尺寸");
      }
      return {
        buffer: encoded.buffer,
        mimeType: transparent ? "image/png" : "image/jpeg",
        width: encoded.info.width,
        height: encoded.info.height,
        byteLength: encoded.buffer.byteLength,
        normalized: true,
      };
    });
  } catch (error) {
    if (error instanceof ImageValidationError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    if (/pixel limit|exceeds.*pixels|too large/i.test(detail)) {
      throw new ImageValidationError(
        `图片像素过大（最多 ${UPLOAD_MAX_INPUT_PIXELS.toLocaleString("en-US")} 像素），请缩小后重试`,
      );
    }
    throw new ImageValidationError(
      `图片无法完成标准化处理，请转换为标准 PNG、JPEG、WebP 或 GIF 后重试（${detail.slice(0, 160)}）`,
    );
  }
}
