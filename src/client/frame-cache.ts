import { state } from "./viewer-state.js";

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
    return new Map(Object.entries(stored as Record<string, string>));
  } catch {
    return new Map();
  }
}

export const thumbnails = loadThumbnails();

function persistThumbnails(): void {
  // ponytail: keeps the newest THUMBNAIL_LIMIT history entries; older tiles fall back to the stripe placeholder
  const keep = new Set(state.history.slice(-THUMBNAIL_LIMIT).map((item) => blobKey(item.source, item.id)));
  for (const key of thumbnails.keys()) if (!keep.has(key)) thumbnails.delete(key);
  try {
    localStorage.setItem(thumbnailStorageKey, JSON.stringify(Object.fromEntries(thumbnails)));
  } catch {
    // Storage quota exceeded; thumbnails simply stay in-memory for this session
  }
}

export async function cacheThumbnail(key: string, blob: Blob): Promise<void> {
  if (thumbnails.has(key)) return;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    thumbnails.set(key, canvas.toDataURL("image/jpeg", 0.6));
    persistThumbnails();
  } catch {
    // Thumbnail generation is best-effort; the grid falls back to a placeholder
  }
}

export function releaseAllBlobs(): void {
  for (const { url } of blobs.values()) URL.revokeObjectURL(url);
  blobs.clear();
}

export function clearThumbnails(): void {
  thumbnails.clear();
  localStorage.removeItem(thumbnailStorageKey);
}
