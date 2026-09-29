import { getThumbnailBlob } from "./api.js";
import { state } from "./viewer-state.js";

export interface CachedBlob {
  blob: Blob;
  url: string;
}

const thumbnailStorageKey = "prntsc-gallery-thumbnails";
const THUMBNAIL_MAX_DIMENSION = 160;
// ~5-8 KB each as base64 JPEG; only non-favourites count toward this budget.
const THUMBNAIL_LIMIT = 300;
let clearGeneration = 0;
const pendingThumbnails = new Map<string, Promise<boolean>>();

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

export function persistThumbnails(): boolean {
  const pinned = new Set(state.favorites.map(({ source, id }) => blobKey(source, id)));
  const ordinary = [...thumbnails.keys()].filter((key) => !pinned.has(key));
  for (const key of ordinary.slice(0, Math.max(0, ordinary.length - THUMBNAIL_LIMIT))) thumbnails.delete(key);
  const write = (entries: Map<string, string>) =>
    localStorage.setItem(thumbnailStorageKey, JSON.stringify(Object.fromEntries(entries)));
  try {
    write(thumbnails);
    return true;
  } catch (error) {
    if (!(error instanceof Error && error.name === "QuotaExceededError")) return false;
    for (const key of thumbnails.keys()) if (!pinned.has(key)) thumbnails.delete(key);
    try {
      write(thumbnails);
      return true;
    } catch {
      // If a new pinned image does not fit, still free old ordinary entries on disk.
      const previouslySaved = loadThumbnails();
      for (const key of previouslySaved.keys()) if (!pinned.has(key)) previouslySaved.delete(key);
      try {
        write(previouslySaved);
      } catch {
        // Keep the previous value if storage itself is unavailable.
      }
      return false;
    }
  }
}

export async function cacheThumbnail(
  key: string,
  blob: Blob,
  persist = true,
  generation = clearGeneration,
): Promise<boolean> {
  if (thumbnails.get(key)) return persist ? persistThumbnails() : true;
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
    if (generation !== clearGeneration && !state.favorites.some(({ source, id }) => blobKey(source, id) === key))
      return false;
    if (thumbnails.get(key)) return persist ? persistThumbnails() : true;
    thumbnails.set(key, canvas.toDataURL("image/jpeg", 0.6));
    return persist ? persistThumbnails() : true;
  } catch {
    // Thumbnail generation is best-effort; the grid falls back to a placeholder
    return false;
  }
}

export async function ensureThumbnail(frame: { source: string; id: string }, persist = true): Promise<boolean> {
  const key = blobKey(frame.source, frame.id);
  if (thumbnails.get(key)) return persist ? persistThumbnails() : true;
  const pending = pendingThumbnails.get(key);
  if (pending) return pending;
  const generation = clearGeneration;
  const work = (async () => {
    const blob = blobs.get(key)?.blob ?? (await getThumbnailBlob(frame.id, frame.source));
    return cacheThumbnail(key, blob, persist, generation);
  })();
  pendingThumbnails.set(key, work);
  try {
    return await work;
  } finally {
    pendingThumbnails.delete(key);
  }
}

export function releaseAllBlobs(): void {
  for (const { url } of blobs.values()) URL.revokeObjectURL(url);
  blobs.clear();
}

export function clearThumbnails(keep: readonly { source: string; id: string }[]): void {
  clearGeneration++;
  const retained = new Set(keep.map(({ source, id }) => blobKey(source, id)));
  for (const key of thumbnails.keys()) if (!retained.has(key)) thumbnails.delete(key);
  if (thumbnails.size) persistThumbnails();
  else {
    try {
      localStorage.removeItem(thumbnailStorageKey);
    } catch {
      // Clearing history still succeeds when local thumbnail storage is unavailable.
    }
  }
}
