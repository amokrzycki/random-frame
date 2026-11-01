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
// Small JPEG files; only non-favourites count toward this on-disk budget.
const THUMBNAIL_LIMIT = 300;
// Thumbnail byte budget: 8MB balances cache density with storage limits.
const THUMBNAIL_BYTE_LIMIT = 8 * 1024 * 1024;
// In-memory bound over every evictable (already saved) thumbnail, Saved or not. Evicting from memory never
// deletes a file: the entry is read from disk again on demand. 300 entries cover two
// 100-tile pages plus a 84-thumbnail Stats page; the byte cap still admits 128
// entries at the 128 KiB per-file maximum.
const MEMORY_LIMIT = 300;
const MEMORY_BYTE_LIMIT = 16 * 1024 * 1024;
let clearGeneration = 0;
const pendingThumbnails = new Map<string, Promise<boolean>>();
// Keys known to be on disk with their file size. Bytes stay there until a view asks.
let diskKeys = new Map<string, number>();
// Keys removed since the last successful save; the native save prunes anything not kept.
const deletedKeys = new Set<string>();
// Keys whose bytes failed to decode this session. They are not read again until replaced.
const discardedKeys = new Set<string>();
// One native read per key, shared by every view that wants the same file right now.
const pendingReads = new Map<string, Promise<string | null>>();

export const blobs = new Map<string, CachedBlob>();
const FRAME_BYTE_LIMIT = 32 * 1024 * 1024;
const FRAME_LIMIT = 20;

export function cacheBlob(key: string, image: CachedBlob): void {
  const previous = blobs.get(key);
  blobs.delete(key);
  blobs.set(key, image);
  if (previous && previous.url !== image.url) releaseBlobUrl(previous.url);
  let bytes = [...blobs.values()].reduce((total, entry) => total + entry.blob.size, 0);
  for (const [candidate, entry] of blobs) {
    if (blobs.size <= FRAME_LIMIT && bytes <= FRAME_BYTE_LIMIT) break;
    if (candidate === key) continue;
    blobs.delete(candidate);
    bytes -= entry.blob.size;
    releaseBlobUrl(entry.url);
  }
}
// Blob keys saved to disk this session, so revisiting a saved frame still shows its check.
export const savedFrames = new Set<string>();

export function blobKey(source: string, id: string): string {
  return `${source}:${id}`;
}

// Probe the at-most-seven spellings of one base-36 ID instead of scanning a large cache.
function probe<T>(lookup: (key: string) => T | undefined, key: string): T | undefined {
  const exact = lookup(key);
  if (exact) return exact;
  const id = key.startsWith("prntsc:") ? key.slice(7) : "";
  if (!PRNTSC_ID_PATTERN.test(id)) return undefined;
  let alias = Number.parseInt(id, 36).toString(36);
  // Leading zeros are the only aliases in the one-to-seven-character ID namespace.
  while (alias.length <= 7) {
    const found = lookup(`prntsc:${alias}`);
    if (found) return found;
    alias = `0${alias}`;
  }
  return undefined;
}
export function thumbnailFor(key: string): string | undefined {
  return probe((candidate) => {
    const image = thumbnails.get(candidate);
    // Reinsert on use so Map order is recency: visible tiles are evicted last.
    if (image !== undefined) {
      thumbnails.delete(candidate);
      thumbnails.set(candidate, image);
    }
    return image;
  }, key);
}
function storedThumbnailKey(key: string): string | undefined {
  return probe((candidate) => (diskKeys.has(candidate) ? candidate : undefined), key);
}
function pendingThumbnailKey(key: string): string {
  const id = key.startsWith("prntsc:") ? key.slice(7) : "";
  return PRNTSC_ID_PATTERN.test(id) ? `prntsc:${Number.parseInt(id, 36).toString(36)}` : key;
}
export function discardThumbnail(key: string, expected: string): void {
  for (const [candidate, image] of thumbnails)
    if (image === expected && pendingThumbnailKey(candidate) === pendingThumbnailKey(key)) {
      dropLoaded(candidate);
      discardedKeys.add(candidate);
      // A pinned file is the offline copy; keep it until a replacement is written.
      if (!isPinnedThumbnail(candidate)) {
        diskKeys.delete(candidate);
        deletedKeys.add(candidate);
      }
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
// Subset of `thumbnails` whose exact bytes are on disk. It shares the strings, so it
// must shrink together with `thumbnails` or evicting would free nothing.
const savedThumbnails = new Map<string, string>();
function dropLoaded(key: string): void {
  thumbnails.delete(key);
  savedThumbnails.delete(key);
}
let initializing: Promise<boolean> | undefined;
let initialized = false;
let persisted = false;
let retainedAfterClear: Set<string> | undefined;
let saveQueue: Promise<boolean> = Promise.resolve(true);

function thumbnailBytes(image: string): number[] {
  return Array.from(atob(image.slice(image.indexOf(",") + 1)), (character) => character.charCodeAt(0));
}

// Everything that must survive a save: unloaded disk entries stay untouched, and
// entries evicted or discarded since the last save are pruned.
function keepKeys(): string[] {
  const keep = new Map(diskKeys);
  for (const [key, image] of thumbnails) if (!keep.has(key)) keep.set(key, encodedSize(image));
  // A key that was re-added after deletion must be kept, or the native save rejects it.
  for (const key of deletedKeys) if (!thumbnails.has(key)) keep.delete(key);
  return [...keep.keys()];
}

function setDiskKeys(keep: readonly string[]): void {
  const sizes = new Map<string, number>();
  for (const key of keep) {
    // Keys deleted while a save was in flight must not reappear on disk.
    if (deletedKeys.has(key) && !thumbnails.has(key)) continue;
    const image = thumbnails.get(key);
    sizes.set(key, image === undefined ? (diskKeys.get(key) ?? 0) : encodedSize(image));
  }
  diskKeys = sizes;
}

export function initializeThumbnailCache(): Promise<boolean> {
  if (initialized) return Promise.resolve(true);
  if (initializing) return initializing;
  initializing = (async () => {
    try {
      // Only the filenames are loaded; image bytes are read on demand by a visible view.
      const keys = await invoke<[string, number][]>("list_thumbnail_cache");
      const allowed = keys.filter(([key]) => !retainedAfterClear || retainedAfterClear.has(pendingThumbnailKey(key)));
      diskKeys = new Map(allowed);
      for (const [key] of keys) if (!diskKeys.has(key)) deletedKeys.add(key);
      const legacy = loadThumbnails();
      for (const [key, image] of legacy)
        if (
          (!retainedAfterClear || retainedAfterClear.has(pendingThumbnailKey(key))) &&
          !thumbnails.has(key) &&
          // An existing file is newer than a leftover legacy value.
          !storedThumbnailKey(key)
        )
          thumbnails.set(key, image);
      if (legacy.size) {
        const entries = [...thumbnails].filter(([key, image]) => savedThumbnails.get(key) !== image);
        const pruned = new Set(deletedKeys);
        const keep = keepKeys();
        await invoke("save_thumbnail_cache", {
          entries: entries.map(([key, image]) => [key, thumbnailBytes(image)]),
          keep,
        });
        for (const [key, image] of entries) savedThumbnails.set(key, image);
        for (const key of pruned) deletedKeys.delete(key);
        setDiskKeys(keep);
        persisted = true;
        trimLoadedThumbnails();
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
// Memory bound for hydrated and saved thumbnails, pinned or not. Only a clean entry (its
// exact bytes are known to be on disk) may leave memory, oldest use first, so only clean
// entries count toward the bound: unsaved ones cannot be evicted and must not push out the
// clean entries a view just hydrated. Nothing here touches diskKeys or deletedKeys, so the
// file stays and the next save still keeps it. `fresh` is the entry a caller is about to
// read and is never its own victim.
function trimLoadedThumbnails(fresh?: string): void {
  const evictable = (key: string, image: string) => savedThumbnails.get(key) === image && diskKeys.has(key);
  let bytes = 0;
  let count = 0;
  for (const [key, image] of thumbnails)
    if (evictable(key, image)) {
      bytes += encodedSize(image);
      count++;
    }
  for (const [key, image] of thumbnails) {
    if (count <= MEMORY_LIMIT && bytes <= MEMORY_BYTE_LIMIT) break;
    if (key === fresh || !evictable(key, image)) continue;
    bytes -= encodedSize(image);
    count--;
    dropLoaded(key);
  }
}

function trimThumbnails(): void {
  const pinned = new Set(state.favorites.map(({ source, id }) => pendingThumbnailKey(blobKey(source, id))));
  // Unloaded disk files are oldest, then loaded entries: a just-read thumbnail is
  // never the first eviction candidate.
  const ordinary: [string, number][] = [];
  for (const [key, bytes] of diskKeys) {
    if (thumbnails.has(key) || pinned.has(pendingThumbnailKey(key))) continue;
    ordinary.push([key, bytes]);
  }
  for (const [key, image] of thumbnails) {
    if (pinned.has(pendingThumbnailKey(key))) continue;
    ordinary.push([key, encodedSize(image)]);
  }
  let bytes = ordinary.reduce((sum, [, size]) => sum + size, 0);
  let count = ordinary.length;
  for (const [key, size] of ordinary) {
    if (count <= THUMBNAIL_LIMIT && bytes <= THUMBNAIL_BYTE_LIMIT) break;
    bytes -= size;
    count--;
    dropLoaded(key);
    diskKeys.delete(key);
    deletedKeys.add(key);
  }
}

export function persistThumbnails(): Promise<boolean> {
  // Serialize writes and pruning so a delayed save cannot undo a later clear.
  saveQueue = saveQueue.then(async () => {
    if (!(await initializeThumbnailCache())) return false;
    trimThumbnails();
    const entries = [...thumbnails].filter(([key, image]) => savedThumbnails.get(key) !== image);
    // Only the deletions this save covers may be cleared; a clear that lands while
    // the write is in flight must stay pending for the next save.
    const pruned = new Set(deletedKeys);
    const keep = keepKeys();
    if (persisted && !entries.length && !pruned.size) return true;
    try {
      await invoke("save_thumbnail_cache", {
        entries: entries.map(([key, image]) => [key, thumbnailBytes(image)]),
        keep,
      });
      const retained = new Set(keep);
      for (const key of savedThumbnails.keys()) if (!retained.has(key)) savedThumbnails.delete(key);
      // An entry that left memory during the write must not leave a stale copy behind.
      for (const [key, image] of entries) if (thumbnails.get(key) === image) savedThumbnails.set(key, image);
      for (const key of pruned) deletedKeys.delete(key);
      setDiskKeys(keep);
      persisted = true;
      // Entries that were dirty are clean now and may leave memory.
      trimLoadedThumbnails();
      return true;
    } catch {
      persisted = false;
      // Files of this call may be half written; those entries are resent. Entries not in
      // the call were not touched, and keeping them clean keeps them evictable.
      for (const [key] of entries) savedThumbnails.delete(key);
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
    deletedKeys.delete(key);
    discardedKeys.delete(key);
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
  // A saved file is already the exact thumbnail; never regenerate and rewrite it.
  if (!repair && (await loadStoredThumbnail(key, generation))) return persist ? persistThumbnails() : true;
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
    deletedKeys.delete(key);
    discardedKeys.delete(key);
    trimThumbnails();
    return persist ? persistThumbnails() : true;
  } catch {
    // Thumbnail generation is best-effort; the grid falls back to a placeholder
    return false;
  } finally {
    bitmap?.close();
  }
}

// Showing a frame needs a thumbnail only when neither memory nor disk already has one;
// an existing file stays put until a view asks for it.
export function cacheThumbnailIfMissing(key: string, blob: Blob): void {
  const generation = clearGeneration;
  void initializeThumbnailCache().then(() => {
    if (thumbnailFor(key) || storedThumbnailKey(key)) return;
    void cacheThumbnail(key, blob, true, generation);
  });
}

// Reads an already-encoded thumbnail from disk and never touches the network, so
// offline Saved/History views and Stats strips stay local.
async function loadStoredThumbnail(key: string, generation: number): Promise<boolean> {
  const stored = storedThumbnailKey(key);
  if (!stored || deletedKeys.has(stored) || discardedKeys.has(stored)) return false;
  let image: string | null;
  try {
    image = await readStoredThumbnail(stored);
  } catch {
    return false;
  }
  if (!image) {
    diskKeys.delete(stored);
    return false;
  }
  if (generation !== clearGeneration && !isPinnedThumbnail(key)) return false;
  // The file may have been pruned or discarded while the read was in flight.
  if (!diskKeys.has(stored) || deletedKeys.has(stored) || discardedKeys.has(stored)) return false;
  // A newer in-memory value, or a concurrent reader's identical one, already won.
  if (thumbnails.has(stored)) return true;
  thumbnails.set(stored, image);
  savedThumbnails.set(stored, image);
  trimLoadedThumbnails(stored);
  return true;
}

function readStoredThumbnail(key: string): Promise<string | null> {
  const pending = pendingReads.get(key);
  if (pending) return pending;
  const read = invoke<string | null>("read_thumbnail_cache", { key }).finally(() => {
    if (pendingReads.get(key) === read) pendingReads.delete(key);
  });
  pendingReads.set(key, read);
  return read;
}

export async function ensureThumbnail(frame: { source: string; id: string }, persist = true): Promise<boolean> {
  await initializeThumbnailCache();
  const key = blobKey(frame.source, frame.id);
  if (thumbnailFor(key)) return persist ? persistThumbnails() : true;
  const generation = clearGeneration;
  return shareThumbnail(key, async () => {
    if (await loadStoredThumbnail(key, generation)) return true;
    const blob = blobs.get(key)?.blob ?? (await getThumbnailBlob(frame.id, frame.source));
    return cacheThumbnail(key, blob, persist, generation);
  });
}

// Disk-only hydration for views that must not start a source request. It does not
// join ensureThumbnail's pending map, so a disk miss still falls through to the source.
export async function hydrateThumbnail(key: string): Promise<boolean> {
  await initializeThumbnailCache();
  if (thumbnailFor(key)) return true;
  return loadStoredThumbnail(key, clearGeneration);
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
  for (const key of [...thumbnails.keys()])
    if (!retained.has(pendingThumbnailKey(key))) {
      dropLoaded(key);
      deletedKeys.add(key);
    }
  // Unloaded disk entries are pruned too; retained ones stay untouched on disk.
  for (const key of diskKeys.keys())
    if (!retained.has(pendingThumbnailKey(key))) {
      diskKeys.delete(key);
      deletedKeys.add(key);
    }
  if (await persistThumbnails()) retainedAfterClear = undefined;
}
