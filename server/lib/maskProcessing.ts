import sharp from "sharp";
import { ProviderError, toDataUrl } from "../providers/base";
import { withImageProcessingSlot } from "./imageProcessingLimit";
import { validateImageDataUrl } from "./imageValidation";

export const MAX_GPT_IMAGE_MASK_BYTES = 4 * 1024 * 1024;
const MAX_MASK_PIXELS = 40_000_000;

export interface ValidatedMaskPair {
  sourceBuffer: Buffer;
  maskBuffer: Buffer;
  width: number;
  height: number;
}

export async function validateMaskForSource(
  sourceDataUrl: string,
  maskDataUrl: string,
  providerId = "gpt-image-2",
): Promise<ValidatedMaskPair> {
  const source = validateImageDataUrl(sourceDataUrl);
  const mask = validateImageDataUrl(maskDataUrl, MAX_GPT_IMAGE_MASK_BYTES);
  if (mask.mime !== "image/png") {
    throw new ProviderError("蒙版必须是 PNG 图片", 400, providerId, "invalid_request");
  }

  return withImageProcessingSlot(async () => {
    const sourceMeta = await sharp(source.buffer, {
      animated: false, failOn: "error", limitInputPixels: MAX_MASK_PIXELS,
    }).metadata();
    const maskImage = sharp(mask.buffer, {
      animated: false, failOn: "error", limitInputPixels: MAX_MASK_PIXELS,
    });
    const maskMeta = await maskImage.metadata();
    if (!sourceMeta.width || !sourceMeta.height || !maskMeta.width || !maskMeta.height) {
      throw new ProviderError("无法读取原图或蒙版尺寸", 400, providerId, "invalid_request");
    }
    if (sourceMeta.width !== maskMeta.width || sourceMeta.height !== maskMeta.height) {
      throw new ProviderError(
        `蒙版尺寸必须与原图完全一致（原图 ${sourceMeta.width}x${sourceMeta.height}，蒙版 ${maskMeta.width}x${maskMeta.height}）`,
        400, providerId, "invalid_request",
      );
    }
    if (!maskMeta.hasAlpha) {
      throw new ProviderError("蒙版 PNG 必须包含 Alpha 通道", 400, providerId, "invalid_request");
    }
    const alphaPixels = await maskImage.extractChannel("alpha").raw().toBuffer();
    let minAlpha = 255;
    let maxAlpha = 0;
    for (const value of alphaPixels) {
      minAlpha = Math.min(minAlpha, value);
      maxAlpha = Math.max(maxAlpha, value);
    }
    if (minAlpha === 255) {
      throw new ProviderError("蒙版没有可编辑区域，请先涂抹需要修改的位置", 400, providerId, "invalid_request");
    }
    if (maxAlpha === 0) {
      throw new ProviderError("蒙版覆盖了整张图片，请保留不需要修改的区域", 400, providerId, "invalid_request");
    }
    return {
      sourceBuffer: source.buffer,
      maskBuffer: mask.buffer,
      width: sourceMeta.width,
      height: sourceMeta.height,
    };
  });
}

/** 用原图逐像素覆盖蒙版外区域，避免把模型的“尽量保留”误当成硬保证。 */
export async function compositeMaskedEdit(
  sourceDataUrl: string,
  maskDataUrl: string,
  generatedDataUrl: string,
): Promise<string> {
  const pair = await validateMaskForSource(sourceDataUrl, maskDataUrl);
  const generated = validateImageDataUrl(generatedDataUrl);
  return withImageProcessingSlot(async () => {
    const generatedMeta = await sharp(generated.buffer, {
      animated: false, failOn: "error", limitInputPixels: MAX_MASK_PIXELS,
    }).metadata();
    if (generatedMeta.width !== pair.width || generatedMeta.height !== pair.height) {
      throw new ProviderError(
        "AI 返回图片尺寸与原图不一致，无法安全执行蒙版外像素保护",
        502, "gpt-image-2", "invalid_response",
      );
    }
    const editMask = await sharp(pair.maskBuffer)
      .negate({ alpha: true })
      .png()
      .toBuffer();
    const editableLayer = await sharp(generated.buffer)
      .ensureAlpha()
      .composite([{ input: editMask, blend: "dest-in" }])
      .png()
      .toBuffer();
    const output = await sharp(pair.sourceBuffer)
      .ensureAlpha()
      .composite([{ input: editableLayer, blend: "over" }])
      .png()
      .toBuffer();
    return toDataUrl(output.toString("base64"), "image/png");
  });
}
