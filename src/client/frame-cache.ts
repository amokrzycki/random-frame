import { getThumbnailBlob } from "./api.js";

export interface CachedBlob {
  blob: Blob;
  url: string;
}

const thumbnailStorageKey = "prntsc-gallery-thumbnails";
const THUMBNAIL_MAX_DIMENSION = 160;
// ~5-8 KB each as base64 JPEG; 300 stays well inside the webview's ~5 MB localStorage quota.
const THUMBNAIL_LIMIT = 300;

export const blobs = new Map<string, CachedBlob>();
// Blob keys saved to disk this session, so revisiting a saved frame still shows its check.
export const savedFrames = new Set<string>();

export function blobKey(source: string, id: string): string {
  return `${source}:${id}`;
}

function loadThumbnails(): Map<string, string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(thumbnailStorageKey) ?? "{}");
    if (typeof stored !== "object" || stored === null) return new Map();
    return new Map(
      Object.entries(stored as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].startsWith("data:image/"),
      ),
    );
  } catch {
    return new Map();
  }
}

export const thumbnails = loadThumbnails();

function persistThumbnails(): void {
  // ponytail: cache keeps the latest 300 generated thumbnails; older tiles use the placeholder.
  while (thumbnails.size > THUMBNAIL_LIMIT) thumbnails.delete(thumbnails.keys().next().value as string);
  try {
    localStorage.setItem(thumbnailStorageKey, JSON.stringify(Object.fromEntries(thumbnails)));
  } catch {
    // Storage quota exceeded; thumbnails simply stay in-memory for this session
  }
}

export async function cacheThumbnail(key: string, blob: Blob): Promise<boolean> {
  if (thumbnails.get(key)) return true;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close();
      return false;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    thumbnails.set(key, canvas.toDataURL("image/jpeg", 0.6));
    persistThumbnails();
    return Boolean(thumbnails.get(key));
  } catch {
    // Thumbnail generation is best-effort; the grid falls back to a placeholder
    return false;
  }
}

export async function ensureThumbnail(frame: { source: string; id: string }): Promise<boolean> {
  const key = blobKey(frame.source, frame.id);
  if (thumbnails.get(key)) return true;
  const blob = blobs.get(key)?.blob ?? (await getThumbnailBlob(frame.id, frame.source));
  if (thumbnails.get(key)) return true;
  return cacheThumbnail(key, blob);
}

export function releaseAllBlobs(): void {
  for (const { url } of blobs.values()) URL.revokeObjectURL(url);
  blobs.clear();
}

export function clearThumbnails(keep: readonly { source: string; id: string }[]): void {
  const retained = new Set(keep.map(({ source, id }) => blobKey(source, id)));
  for (const key of thumbnails.keys()) if (!retained.has(key)) thumbnails.delete(key);
  if (thumbnails.size) persistThumbnails();
  else localStorage.removeItem(thumbnailStorageKey);
}
