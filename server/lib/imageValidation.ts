const ALLOWED_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageValidationError";
  }
}

export interface ValidatedImageDataUrl {
  mime: AllowedImageMime;
  buffer: Buffer;
}

function hasMagic(buffer: Buffer, bytes: readonly number[], offset = 0): boolean {
  return bytes.every((byte, index) => buffer[offset + index] === byte);
}

export function detectImageMime(buffer: Buffer): AllowedImageMime | null {
  if (buffer.length >= 8 && hasMagic(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (buffer.length >= 3 && hasMagic(buffer, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 6) {
    const signature = buffer.toString("ascii", 0, 6);
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return null;
}

/** Strict base64 data URL parser with declared MIME, decoded magic-byte and size checks. */
export function validateImageDataUrl(
  dataUrl: unknown,
  maxBytes = MAX_IMAGE_BYTES,
): ValidatedImageDataUrl {
  if (typeof dataUrl !== "string") throw new ImageValidationError("image dataURL must be a string");
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  if (!match) throw new ImageValidationError("invalid image dataURL (strict base64 required)");
  const mime = match[1].toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.includes(mime as AllowedImageMime)) {
    throw new ImageValidationError(`unsupported image MIME: ${mime}`);
  }
  const encoded = match[2];
  if (encoded.length === 0 || encoded.length % 4 !== 0) {
    throw new ImageValidationError("invalid image base64 payload");
  }
  if (encoded.includes("=") && !/^[A-Za-z0-9+/]+={1,2}$/.test(encoded)) {
    throw new ImageValidationError("invalid image base64 padding");
  }
  const estimatedBytes = Math.floor((encoded.length * 3) / 4) - (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0);
  if (estimatedBytes > maxBytes) throw new ImageValidationError(`image too large (limit ${maxBytes} bytes)`);
  const buffer = Buffer.from(encoded, "base64");
  if (buffer.length === 0 || buffer.length !== estimatedBytes) {
    throw new ImageValidationError("invalid image base64 payload");
  }
  if (buffer.toString("base64") !== encoded) {
    throw new ImageValidationError("non-canonical image base64 payload");
  }
  const detected = detectImageMime(buffer);
  if (!detected) throw new ImageValidationError("unrecognized image file signature");
  if (detected !== mime) {
    throw new ImageValidationError(`image MIME/signature mismatch: declared ${mime}, detected ${detected}`);
  }
  return { mime: mime as AllowedImageMime, buffer };
}

/** Asset records may only point at an immutable local upload, never an arbitrary URL/path. */
export function isLocalImageReference(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^\/api\/files\/[A-Za-z0-9_-]{1,128}\.(?:png|jpe?g|webp|gif)$/.test(value);
}
