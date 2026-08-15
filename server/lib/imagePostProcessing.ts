import sharp, { type Sharp } from "sharp";
import { normalizeImageRef } from "./fileStore";
import { withImageProcessingSlot } from "./imageProcessingLimit";
import { MAX_IMAGE_BYTES, validateImageDataUrl } from "./imageValidation";

export const EXACT_ASPECT_DIMENSIONS = {
  "1:1": { width: 1024, height: 1024 },
  "3:4": { width: 1152, height: 1536 },
  "4:3": { width: 1536, height: 1152 },
  "9:16": { width: 864, height: 1536 },
  "16:9": { width: 1536, height: 864 },
} as const;

export type ExactAspectRatio = keyof typeof EXACT_ASPECT_DIMENSIONS;
export type UpscaleSize = "2K" | "4K";

const WEBP_QUALITIES = [92, 84, 76, 68, 60, 50, 40, 30, 20, 10] as const;
const SHARP_INPUT_OPTIONS = {
  animated: false,
  failOn: "warning" as const,
  limitInputPixels: 40_000_000,
};

function isExactAspectRatio(value: unknown): value is ExactAspectRatio {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(EXACT_ASPECT_DIMENSIONS, value);
}

function isUpscaleSize(value: unknown): value is UpscaleSize {
  return value === "2K" || value === "4K";
}

export function normalizeExactAspectRatio(value: unknown): ExactAspectRatio {
  return isExactAspectRatio(value) ? value : "1:1";
}

export function normalizeUpscaleSize(value: unknown): UpscaleSize {
  return isUpscaleSize(value) ? value : "2K";
}

async function imageRefToBuffer(ref: string): Promise<Buffer> {
  const dataUrl = await normalizeImageRef(ref);
  return validateImageDataUrl(dataUrl).buffer;
}

/** Encode to a supported local format while enforcing the project's 20 MB encoded-file limit. */
async function encodeWebpWithinLimit(image: Sharp): Promise<Buffer> {
  for (const quality of WEBP_QUALITIES) {
    const output = await image.clone().webp({ quality, effort: 4, smartSubsample: true }).toBuffer();
    if (output.byteLength <= MAX_IMAGE_BYTES) return output;
  }
  throw new Error(`processed image exceeds ${MAX_IMAGE_BYTES} bytes even at minimum quality`);
}

function toWebpDataUrl(buffer: Buffer): string {
  return `data:image/webp;base64,${buffer.toString("base64")}`;
}

/**
 * Keep the whole generated image visible and place it on an exact-ratio canvas without stretching.
 * Padding uses the source image's dominant colour so portrait/landscape conversions do not create
 * arbitrary black bars.
 */
export async function fitGeneratedImageToAspect(
  ref: string,
  aspectRatio: unknown,
): Promise<string> {
  return withImageProcessingSlot(async () => {
    const normalizedAspectRatio = normalizeExactAspectRatio(aspectRatio);
    const input = await imageRefToBuffer(ref);
    const { width, height } = EXACT_ASPECT_DIMENSIONS[normalizedAspectRatio];
    const source = sharp(input, SHARP_INPUT_OPTIONS).rotate();
    const { dominant } = await source.clone().stats();
    const background = { r: dominant.r, g: dominant.g, b: dominant.b, alpha: 1 };
    const output = await encodeWebpWithinLimit(
      source
        .resize({ width, height, fit: "contain", position: "centre", background })
        .flatten({ background })
        .toColourspace("srgb"),
    );
    return toWebpDataUrl(output);
  });
}

/** Preserve the source ratio and make its long edge exactly 2048 px (2K) or 4096 px (4K). */
export async function upscaleImageToLongEdge(ref: string, imageSize: unknown): Promise<string> {
  return withImageProcessingSlot(async () => {
    const normalizedImageSize = normalizeUpscaleSize(imageSize);
    const input = await imageRefToBuffer(ref);
    const longEdge = normalizedImageSize === "4K" ? 4096 : 2048;
    const output = await encodeWebpWithinLimit(
      sharp(input, SHARP_INPUT_OPTIONS)
        .rotate()
        .resize({ width: longEdge, height: longEdge, fit: "inside" })
        .toColourspace("srgb"),
    );
    return toWebpDataUrl(output);
  });
}
