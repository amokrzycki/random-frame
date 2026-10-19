import { invoke } from "@tauri-apps/api/core";
import { getThumbnailBlob } from "./api.js";
import { PRNTSC_ID_PATTERN } from "./navigation.js";
import { state } from "./viewer-state.js";

export interface CachedBlob {
  blob: Blob;
  url: string;
}

const thumbnailStorageKey = "prntsc-gallery-thumbnails";
const THUMBNAIL_MAX_DIMENSION = 384;
// Small JPEG files; only non-favourites count toward this budget.
const THUMBNAIL_LIMIT = 300;
// Thumbnail byte budget: 8MB balances cache density with storage limits.
// ponytail: O(n) scan for normalized key lookup; acceptable at n≤300, add Map index if grid grows
const THUMBNAIL_BYTE_LIMIT = 8 * 1024 * 1024;
let clearGeneration = 0;
const pendingThumbnails = new Map<string, Promise<boolean>>();

export const blobs = new Map<string, CachedBlob>();
// Blob keys saved to disk this session, so revisiting a saved frame still shows its check.
export const savedFrames = new Set<string>();

export function blobKey(source: string, id: string): string {
  return `${source}:${id}`;
}

export function thumbnailFor(key: string): string | undefined {
  const exact = thumbnails.get(key);
  if (exact) return exact;
  const id = key.startsWith("prntsc:") ? key.slice(7) : "";
  if (!PRNTSC_ID_PATTERN.test(id)) return undefined;
  const value = Number.parseInt(id, 36);
  return [...thumbnails].find(
    ([other]) =>
      other.startsWith("prntsc:") &&
      PRNTSC_ID_PATTERN.test(other.slice(7)) &&
      Number.parseInt(other.slice(7), 36) === value,
  )?.[1];
}
function pendingThumbnailKey(key: string): string {
  const id = key.startsWith("prntsc:") ? key.slice(7) : "";
  return PRNTSC_ID_PATTERN.test(id) ? `prntsc:${Number.parseInt(id, 36).toString(36)}` : key;
}
export function discardThumbnail(key: string, expected: string): void {
  for (const [candidate, image] of thumbnails)
    if (image === expected && pendingThumbnailKey(candidate) === pendingThumbnailKey(key)) {
      thumbnails.delete(candidate);
      savedThumbnails.delete(candidate);
    }
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
        if ((!retainedAfterClear || retainedAfterClear.has(pendingThumbnailKey(key))) && !thumbnails.has(key))
          thumbnails.set(key, image);
        savedThumbnails.set(key, image);
      }
      const legacy = loadThumbnails();
      for (const [key, image] of legacy)
        if ((!retainedAfterClear || retainedAfterClear.has(pendingThumbnailKey(key))) && !thumbnails.has(key))
          thumbnails.set(key, image);
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

function isPinnedThumbnail(key: string): boolean {
  return state.favorites.some(
    ({ source, id }) => pendingThumbnailKey(blobKey(source, id)) === pendingThumbnailKey(key),
  );
}
function trimThumbnails(): void {
  const pinned = new Set(state.favorites.map(({ source, id }) => pendingThumbnailKey(blobKey(source, id))));
  const ordinary = [...thumbnails.keys()].filter((key) => !pinned.has(pendingThumbnailKey(key)));
  let bytes = ordinary.reduce((sum, key) => sum + encodedSize(thumbnails.get(key) ?? ""), 0);
  let count = ordinary.length;
  for (const key of ordinary) {
    if (count <= THUMBNAIL_LIMIT && bytes <= THUMBNAIL_BYTE_LIMIT) break;
    bytes -= encodedSize(thumbnails.get(key) ?? "");
    count--;
    thumbnails.delete(key);
    savedThumbnails.delete(key);
  }
}

export function persistThumbnails(): Promise<boolean> {
  // Serialize writes and pruning so a delayed save cannot undo a later clear.
  saveQueue = saveQueue.then(async () => {
    if (!(await initializeThumbnailCache())) return false;
    trimThumbnails();
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

function encodedSize(image: string): number {
  const base64 = image.slice(image.indexOf(",") + 1);
  return Math.max(0, Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0));
}
export function thumbnailGeneration(): number {
  return clearGeneration;
}
export async function cacheEncodedThumbnail(
  key: string,
  bytes: Uint8Array,
  persist = true,
  generation = clearGeneration,
): Promise<boolean> {
  await initializeThumbnailCache();
  if (generation !== clearGeneration && !isPinnedThumbnail(key)) return false;
  if (!thumbnails.has(key)) {
    if (!bytes.length || bytes.length > 128 * 1024) return false;
    // Efficient binary string construction for base64 encoding
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    thumbnails.set(key, `data:image/jpeg;base64,${btoa(binary)}`);
    trimThumbnails();
  }
  return persist ? persistThumbnails() : true;
}
export function shareThumbnail(key: string, work: () => Promise<boolean>): Promise<boolean> {
  key = pendingThumbnailKey(key);
  const pending = pendingThumbnails.get(key);
  if (pending) return pending;
  const promise = work().finally(() => {
    if (pendingThumbnails.get(key) === promise) pendingThumbnails.delete(key);
  });
  pendingThumbnails.set(key, promise);
  return promise;
}

export async function cacheThumbnail(
  key: string,
  blob: Blob,
  persist = true,
  generation = clearGeneration,
  repair = false,
): Promise<boolean> {
  await initializeThumbnailCache();
  if (!repair && thumbnailFor(key)) return persist ? persistThumbnails() : true;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) {
      return false;
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (generation !== clearGeneration && !isPinnedThumbnail(key)) return false;
    if (!repair && thumbnailFor(key)) return persist ? persistThumbnails() : true;
    thumbnails.set(key, canvas.toDataURL("image/jpeg", 0.6));
    trimThumbnails();
    return persist ? persistThumbnails() : true;
  } catch {
    // Thumbnail generation is best-effort; the grid falls back to a placeholder
    return false;
  } finally {
    bitmap?.close();
  }
}

export async function ensureThumbnail(frame: { source: string; id: string }, persist = true): Promise<boolean> {
  await initializeThumbnailCache();
  const key = blobKey(frame.source, frame.id);
  if (thumbnailFor(key)) return persist ? persistThumbnails() : true;
  const generation = clearGeneration;
  return shareThumbnail(key, async () => {
    const blob = blobs.get(key)?.blob ?? (await getThumbnailBlob(frame.id, frame.source));
    return cacheThumbnail(key, blob, persist, generation);
  });
}

const borrowedUrls = new Map<string, number>();
const releasedWhileBorrowed = new Set<string>();
export function borrowBlobUrl(url: string): () => void {
  borrowedUrls.set(url, (borrowedUrls.get(url) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (borrowedUrls.get(url) ?? 1) - 1;
    if (remaining) borrowedUrls.set(url, remaining);
    else {
      borrowedUrls.delete(url);
      if (releasedWhileBorrowed.delete(url)) URL.revokeObjectURL(url);
    }
  };
}
export function releaseBlobUrl(url: string): void {
  if (borrowedUrls.has(url)) releasedWhileBorrowed.add(url);
  else URL.revokeObjectURL(url);
}

export function releaseAllBlobs(): void {
  for (const { url } of blobs.values()) releaseBlobUrl(url);
  blobs.clear();
}

export async function clearThumbnails(keep: readonly { source: string; id: string }[]): Promise<void> {
  clearGeneration++;
  const retained = new Set(keep.map(({ source, id }) => pendingThumbnailKey(blobKey(source, id))));
  retainedAfterClear = retained;
  await initializeThumbnailCache();
  for (const key of thumbnails.keys()) if (!retained.has(pendingThumbnailKey(key))) thumbnails.delete(key);
  await persistThumbnails();
}
