export type ImageFileExtension = "png" | "jpg" | "webp" | "gif";

const MIME_EXTENSIONS: Readonly<Record<string, ImageFileExtension>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

function normalizeExtension(value: string | undefined): ImageFileExtension | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase() === "jpeg" ? "jpg" : value.toLowerCase();
  return ["png", "jpg", "webp", "gif"].includes(normalized)
    ? normalized as ImageFileExtension
    : undefined;
}

/** Infer a downloadable image extension without fetching data or consulting browser state. */
export function imageExtensionFromReference(ref: string): ImageFileExtension | undefined {
  const dataUrlMime = /^data:([^;,]+)[;,]/i.exec(ref)?.[1]?.toLowerCase();
  if (dataUrlMime) return MIME_EXTENSIONS[dataUrlMime];

  let pathname: string;
  try {
    pathname = new URL(ref, "http://local.invalid").pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith("/api/files/")) return undefined;
  return normalizeExtension(/\.([^.\/]+)$/.exec(pathname)?.[1]);
}
