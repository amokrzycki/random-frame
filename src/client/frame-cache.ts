import { invoke } from "@tauri-apps/api/core";
import { getThumbnailBlob } from "./api.js";
import { state } from "./viewer-state.js";

export interface CachedBlob {
  blob: Blob;
  url: string;
}

const thumbnailStorageKey = "prntsc-gallery-thumbnails";
const THUMBNAIL_MAX_DIMENSION = 160;
// Small JPEG files; only non-favourites count toward this budget.
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

export const thumbnails = new Map<string, string>();
const savedThumbnails = new Map<string, string>();
let initializing: Promise<boolean> | undefined;
let initialized = false;
let retainedAfterClear: Set<string> | undefined;
let saveQueue: Promise<boolean> = Promise.resolve(true);

function thumbnailBytes(image: string): number[] {
  return Array.from(atob(image.slice(image.indexOf(",") + 1)), (character) => character.charCodeAt(0));
}

export function initializeThumbnailCache(): Promise<boolean> {
  if (initialized) return Promise.resolve(true);
  if (initializing) return initializing;
  initializing = (async () => {
    try {
      const entries = await invoke<[string, number[]][]>("load_thumbnail_cache");
      for (const [key, bytes] of entries) {
        const image = `data:image/jpeg;base64,${btoa(bytes.map((byte) => String.fromCharCode(byte)).join(""))}`;
        if ((!retainedAfterClear || retainedAfterClear.has(key)) && !thumbnails.has(key)) thumbnails.set(key, image);
        savedThumbnails.set(key, image);
      }
      const legacy = loadThumbnails();
      for (const [key, image] of legacy)
        if ((!retainedAfterClear || retainedAfterClear.has(key)) && !thumbnails.has(key)) thumbnails.set(key, image);
      if (legacy.size) {
        const entries = [...thumbnails].filter(([key, image]) => savedThumbnails.get(key) !== image);
        await invoke("save_thumbnail_cache", {
          entries: entries.map(([key, image]) => [key, thumbnailBytes(image)]),
          keep: [...thumbnails.keys()],
        });
        for (const [key, image] of entries) savedThumbnails.set(key, image);
      }
      // Remove the old value only after every legacy thumbnail was saved successfully.
      try {
        localStorage.removeItem(thumbnailStorageKey);
      } catch {
        // Saved files remain usable; legacy cleanup will be retried next launch.
      }
      initialized = true;
      retainedAfterClear = undefined;
      return true;
    } catch {
      return false;
    } finally {
      initializing = undefined;
    }
  })();
  return initializing;
}

export function persistThumbnails(): Promise<boolean> {
  // Serialize writes and pruning so a delayed save cannot undo a later clear.
  saveQueue = saveQueue.then(async () => {
    if (!(await initializeThumbnailCache())) return false;
    const pinned = new Set(state.favorites.map(({ source, id }) => blobKey(source, id)));
    const ordinary = [...thumbnails.keys()].filter((key) => !pinned.has(key));
    for (const key of ordinary.slice(0, Math.max(0, ordinary.length - THUMBNAIL_LIMIT))) thumbnails.delete(key);
    const entries = [...thumbnails].filter(([key, image]) => savedThumbnails.get(key) !== image);
    const keep = [...thumbnails.keys()];
    try {
      await invoke("save_thumbnail_cache", {
        entries: entries.map(([key, image]) => [key, thumbnailBytes(image)]),
        keep,
      });
      for (const key of savedThumbnails.keys()) if (!keep.includes(key)) savedThumbnails.delete(key);
      for (const [key, image] of entries) savedThumbnails.set(key, image);
      return true;
    } catch {
      return false;
    }
  });
  return saveQueue;
}

export async function cacheThumbnail(
  key: string,
  blob: Blob,
  persist = true,
  generation = clearGeneration,
): Promise<boolean> {
  await initializeThumbnailCache();
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
  await initializeThumbnailCache();
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

export async function clearThumbnails(keep: readonly { source: string; id: string }[]): Promise<void> {
  clearGeneration++;
  const retained = new Set(keep.map(({ source, id }) => blobKey(source, id)));
  retainedAfterClear = retained;
  await initializeThumbnailCache();
  for (const key of thumbnails.keys()) if (!retained.has(key)) thumbnails.delete(key);
  await persistThumbnails();
}
