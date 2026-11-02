import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const image = "data:image/jpeg;base64,AA==";

// A disposable frame-cache module over a shared native double. Bytes live on the
// double's disk; the frontend only ever learns keys until a view asks for one.
async function harness(name, initial = {}) {
  const disk = new Map(Object.entries(initial));
  const reads = [];
  const saves = [];
  const gates = [];
  let blocked = false;
  const saveGates = [];
  let blockedSaves = false;
  let failReads = false;
  let network = 0;
  const document = new FakeDocument(ids);
  const createElement = document.createElement.bind(document);
  document.createElement = (tag) =>
    tag === "canvas"
      ? {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage() {
              /* Fake canvas */
            },
          }),
          toDataURL: () => image,
        }
      : createElement(tag);
  globalThis.document = document;
  globalThis.localStorage = new FakeStorage();
  globalThis.createImageBitmap = async () => ({
    width: 100,
    height: 100,
    close() {
      /* Fake bitmap */
    },
  });
  globalThis.window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "list_thumbnail_cache") return [...disk].map(([key, bytes]) => [key, bytes.length]);
        if (command === "read_thumbnail_cache") {
          reads.push(args.key);
          // The bytes are fixed when the read starts, as for a real in-flight file read.
          const bytes = disk.get(args.key);
          if (blocked) await new Promise((resolve) => gates.push(resolve));
          if (failReads) throw new Error("Disk read failed");
          return bytes ? `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` : null;
        }
        if (command === "save_thumbnail_cache") {
          if (blockedSaves) await new Promise((resolve) => saveGates.push(resolve));
          saves.push(structuredClone(args));
          for (const [key] of args.entries)
            if (!args.keep.includes(key)) throw new Error(`Thumbnail ${key} is not kept`);
          for (const [key, bytes] of args.entries) disk.set(key, bytes);
          for (const key of disk.keys()) if (!args.keep.includes(key)) disk.delete(key);
          return null;
        }
        assert.equal(command, "get_thumbnail_image");
        network++;
        return new Uint8Array([1]).buffer;
      },
    },
  });
  const cache = await import(`../dist/test-client/frame-cache.js?case=${name}`);
  const { state } = await import("../dist/test-client/viewer-state.js");
  state.favorites = [];
  return {
    cache,
    state,
    disk,
    reads,
    saves,
    image,
    networkCount: () => network,
    block() {
      blocked = true;
    },
    release() {
      blocked = false;
      for (const resolve of gates.splice(0)) resolve();
    },
    blockSaves() {
      blockedSaves = true;
    },
    releaseSaves() {
      blockedSaves = false;
      for (const resolve of saveGates.splice(0)) resolve();
    },
    failReads(value) {
      failReads = value;
    },
  };
}

test("startup lists a large cache without reading bytes; concurrent requests share one read", async () => {
  const initial = {};
  for (let i = 0; i < 10_000; i++) initial[`prntsc:${i.toString(36)}`] = [0];
  const h = await harness("concurrent", initial);
  // The large-library case is a pinned Saved cache, which is never evicted.
  h.state.favorites = Object.keys(initial).map((key) => ({ source: "prntsc", id: key.slice(7) }));
  await h.cache.initializeThumbnailCache();
  assert.equal(h.cache.thumbnails.size, 0, "no image bytes at startup");
  assert.deepEqual(h.reads, [], "no image file read at startup");

  h.block();
  const first = h.cache.ensureThumbnail({ source: "prntsc", id: "2" });
  const second = h.cache.ensureThumbnail({ source: "prntsc", id: "2" });
  await flush();
  assert.deepEqual(h.reads, ["prntsc:2"], "one disk read for concurrent requests");
  h.release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(h.cache.thumbnailFor("prntsc:2"), h.image);
  assert.equal(h.networkCount(), 0, "a disk hit never reaches the source");
});

test("a vanished or unreadable file falls back to the source and is pruned", async () => {
  const h = await harness("vanished", { "prntsc:abc": [0] });
  await h.cache.initializeThumbnailCache();
  h.disk.delete("prntsc:abc"); // removed outside the app
  assert.equal(await h.cache.hydrateThumbnail("prntsc:abc"), false);
  assert.equal(h.reads.length, 1);
  assert.equal(h.networkCount(), 0, "disk-only hydration never fetches");
  await h.cache.persistThumbnails();
  assert.equal(h.saves.at(-1).keep.includes("prntsc:abc"), false, "the vanished key is pruned");
  assert.equal(h.disk.has("prntsc:abc"), false);

  const failed = await harness("read-error", { "prntsc:def": [0] });
  await failed.cache.initializeThumbnailCache();
  failed.failReads(true);
  assert.equal(await failed.cache.ensureThumbnail({ source: "prntsc", id: "def" }), true);
  assert.equal(failed.networkCount(), 1, "a read error does not block the source fallback");
});

test("clear prunes unloaded files, keeps pinned ones, and rejects stale in-flight reads", async () => {
  const h = await harness("clear", { "prntsc:keep": [0], "prntsc:drop": [0] });
  h.state.favorites = [{ source: "prntsc", id: "keep" }];
  await h.cache.initializeThumbnailCache();

  h.block();
  const stale = h.cache.hydrateThumbnail("prntsc:drop");
  await flush();
  await h.cache.clearThumbnails(h.state.favorites);
  h.release();
  assert.equal(await stale, false, "a pre-clear unpinned read cannot populate the new generation");
  assert.equal(h.cache.thumbnailFor("prntsc:drop"), undefined);
  assert.deepEqual([...h.disk.keys()], ["prntsc:keep"], "unloaded unpinned files are pruned");

  // The pinned file was never loaded, yet it survives and can still hydrate offline.
  assert.equal(h.cache.thumbnails.has("prntsc:keep"), false);
  assert.equal(await h.cache.hydrateThumbnail("prntsc:keep"), true);
  assert.equal(h.networkCount(), 0);
});

test("evicted thumbnails leave disk and can be hydrated again while cached", async () => {
  const h = await harness("evict");
  await h.cache.initializeThumbnailCache();
  for (let i = 0; i < 301; i++) {
    await h.cache.cacheEncodedThumbnail(`prntsc:${i}`, new Uint8Array([0]), false);
  }
  await h.cache.persistThumbnails();
  assert.equal(h.cache.thumbnails.has("prntsc:0"), false, "the oldest ordinary entry was evicted");
  assert.equal(h.disk.has("prntsc:0"), false, "eviction also prunes the file");
  assert.equal(await h.cache.hydrateThumbnail("prntsc:0"), false, "an evicted file is gone");

  h.cache.thumbnails.clear();
  assert.equal(await h.cache.hydrateThumbnail("prntsc:1"), true);
  assert.equal(h.cache.thumbnailFor("prntsc:1"), h.image);
});

test("showing a frame never rewrites an existing thumbnail", async () => {
  const h = await harness("reuse", { "prntsc:abc": [7] });
  await h.cache.initializeThumbnailCache();
  const blob = new Blob([new Uint8Array([0])], { type: "image/jpeg" });
  const writes = () => h.saves.flatMap((save) => save.entries).filter(([key]) => key === "prntsc:abc");
  h.cache.cacheThumbnailIfMissing("prntsc:abc", blob);
  await flush();
  assert.deepEqual(h.reads, [], "the stage neither reads nor regenerates an existing file");
  assert.deepEqual(writes(), []);
  // The Nearby anchor path holds the decoded frame; it reuses the stored bytes too.
  assert.equal(await h.cache.cacheThumbnail("prntsc:abc", blob), true);
  assert.equal(h.reads.length, 1);
  assert.equal(h.cache.thumbnailFor("prntsc:abc"), "data:image/jpeg;base64,Bw==");
  assert.deepEqual(writes(), []);
});

test("a discarded thumbnail that is re-added is written, not rejected", async () => {
  const h = await harness("readd", { "prntsc:abc": [7] });
  await h.cache.initializeThumbnailCache();
  assert.equal(await h.cache.hydrateThumbnail("prntsc:abc"), true);
  h.cache.discardThumbnail("prntsc:abc", h.cache.thumbnailFor("prntsc:abc"));
  assert.equal(await h.cache.cacheEncodedThumbnail("prntsc:abc", new Uint8Array([0]), false), true);
  assert.equal(await h.cache.persistThumbnails(), true, "the native save accepts the re-added entry");
  assert.deepEqual(h.disk.get("prntsc:abc"), [0]);
});

test("a pinned thumbnail survives a discarded decode", async () => {
  const h = await harness("pinned-discard", { "prntsc:abc": [7] });
  h.state.favorites = [{ source: "prntsc", id: "abc" }];
  await h.cache.initializeThumbnailCache();
  assert.equal(await h.cache.hydrateThumbnail("prntsc:abc"), true);
  h.cache.discardThumbnail("prntsc:abc", h.cache.thumbnailFor("prntsc:abc"));
  assert.equal(await h.cache.persistThumbnails(), true);
  assert.deepEqual(h.disk.get("prntsc:abc"), [7], "the offline copy is not deleted");
});

test("a disk-only hydrate never swallows the source fallback", async () => {
  const h = await harness("hydrate-ensure", { "prntsc:abc": [0] });
  await h.cache.initializeThumbnailCache();
  h.block();
  h.failReads(true);
  const hydrate = h.cache.hydrateThumbnail("prntsc:abc");
  await flush();
  const ensure = h.cache.ensureThumbnail({ source: "prntsc", id: "abc" });
  await flush();
  h.release();
  assert.equal(await hydrate, false);
  assert.equal(await ensure, true, "the source fallback still runs");
  assert.equal(h.networkCount(), 1);
});

test("a clear during an in-flight save still prunes", async () => {
  const h = await harness("inflight-clear", { "prntsc:a": [0], "prntsc:b": [0] });
  await h.cache.initializeThumbnailCache();
  h.blockSaves();
  const saving = h.cache.persistThumbnails();
  await flush();
  const clearing = h.cache.clearThumbnails([]);
  await flush();
  h.releaseSaves();
  assert.equal(await saving, true);
  await clearing;
  assert.deepEqual([...h.disk.keys()], [], "cleared files are not resurrected");
});

test("hydrating a page never evicts the thumbnail it just read", async () => {
  const initial = {};
  for (let i = 0; i < 400; i++) initial[`prntsc:${i}`] = [0];
  const h = await harness("self-evict", initial);
  await h.cache.initializeThumbnailCache();
  assert.equal(await h.cache.hydrateThumbnail("prntsc:0"), true);
  assert.equal(await h.cache.persistThumbnails(), true);
  assert.equal(h.cache.thumbnailFor("prntsc:0"), h.image, "the loaded entry survives trimming");
  assert.ok(h.disk.has("prntsc:0"));
  assert.equal(h.disk.size, 300, "ordinary disk entries stay bounded");
});

test("a leftover legacy thumbnail never overrides an existing file", async () => {
  const h = await harness("legacy", { "prntsc:abc": [7] });
  globalThis.localStorage.setItem(
    "prntsc-gallery-thumbnails",
    JSON.stringify({ "prntsc:abc": "data:image/jpeg;base64,AA==" }),
  );
  await h.cache.initializeThumbnailCache();
  assert.equal(await h.cache.hydrateThumbnail("prntsc:abc"), true);
  assert.equal(h.cache.thumbnailFor("prntsc:abc"), "data:image/jpeg;base64,Bw==");
});

test("hydrating many pages keeps the in-memory cache bounded", async () => {
  const initial = {};
  for (let i = 0; i < 1000; i++) initial[`prntsc:${i}`] = [0];
  const h = await harness("hydrate-bound", initial);
  await h.cache.initializeThumbnailCache();
  for (let i = 0; i < 1000; i++) assert.equal(await h.cache.hydrateThumbnail(`prntsc:${i}`), true);
  assert.ok(h.cache.thumbnails.size <= 300, `hydrated cache stays bounded: ${h.cache.thumbnails.size}`);
  assert.equal(h.cache.thumbnailFor("prntsc:999"), h.image, "the newest hydration survives");
});

test("a pinned discarded thumbnail is not re-read until replaced", async () => {
  const h = await harness("pinned-discard-read", { "prntsc:abc": [7] });
  h.state.favorites = [{ source: "prntsc", id: "abc" }];
  await h.cache.initializeThumbnailCache();
  assert.equal(await h.cache.hydrateThumbnail("prntsc:abc"), true);
  h.cache.discardThumbnail("prntsc:abc", h.cache.thumbnailFor("prntsc:abc"));
  assert.equal(await h.cache.hydrateThumbnail("prntsc:abc"), false, "the rejected bytes are not resurrected");
  assert.equal(await h.cache.cacheEncodedThumbnail("prntsc:abc", new Uint8Array([0]), false), true);
  assert.equal(h.cache.thumbnailFor("prntsc:abc"), h.image, "fresh bytes are accepted");
});

test("leading-zero disk aliases survive saves and clear", async () => {
  const h = await harness("alias", { "prntsc:0abc123": [0] });
  h.state.favorites = [{ source: "prntsc", id: "0abc123" }];
  await h.cache.initializeThumbnailCache();
  assert.equal(await h.cache.hydrateThumbnail("prntsc:abc123"), true);
  assert.deepEqual(h.reads, ["prntsc:0abc123"], "the stored alias filename is read, not a canonical one");
  assert.equal(h.cache.thumbnailFor("prntsc:abc123"), h.image);
  await h.cache.persistThumbnails();
  assert.deepEqual([...h.disk.keys()], ["prntsc:0abc123"], "the alias filename is preserved");
  await h.cache.clearThumbnails(h.state.favorites);
  assert.deepEqual([...h.disk.keys()], ["prntsc:0abc123"]);
});

// --- Bounded in-memory retention -------------------------------------------------------
// Pinned Saved thumbnails are durable on disk, not resident in memory: a clean entry may
// leave memory, and a later view reads it back. These tests pin every such rule.

const pinnedLibrary = (count, bytes = [0]) => {
  const initial = {};
  for (let i = 0; i < count; i++) initial[`prntsc:${i.toString(36)}`] = bytes;
  return initial;
};
const pin = (h, initial) => {
  h.state.favorites = Object.keys(initial).map((key) => ({ source: "prntsc", id: key.slice(7) }));
};

test("visiting a large pinned library stays bounded while every file stays kept and offline", async () => {
  const initial = pinnedLibrary(1000);
  const h = await harness("bounded-traversal", initial);
  pin(h, initial);
  await h.cache.initializeThumbnailCache();
  let peak = 0;
  for (const key of Object.keys(initial)) {
    assert.equal(await h.cache.hydrateThumbnail(key), true);
    peak = Math.max(peak, h.cache.thumbnails.size);
  }
  assert.ok(peak <= 300, `memory is bounded by the cache, not the library: ${peak}`);
  assert.equal(h.cache.thumbnailFor("prntsc:rr"), h.image, "the newest visit is resident");
  assert.equal(h.cache.thumbnailFor("prntsc:0"), undefined, "an old visit left memory");
  assert.equal(h.networkCount(), 0);

  // Evicting memory never deletes: a save that changes something still keeps all 1,000.
  await h.cache.cacheEncodedThumbnail("prntsc:ordinary", new Uint8Array([0]), false);
  assert.equal(await h.cache.persistThumbnails(), true);
  assert.deepEqual(new Set(h.saves.at(-1).keep).size, 1001);
  assert.equal(h.disk.size, 1001);

  // Revisit: the evicted pinned file hydrates again from disk, never from the source.
  const reads = h.reads.length;
  assert.equal(await h.cache.hydrateThumbnail("prntsc:0"), true);
  assert.equal(h.reads.length, reads + 1);
  assert.equal(h.cache.thumbnailFor("prntsc:0"), h.image);
  assert.equal(h.networkCount(), 0, "offline revisit never reaches the source");
});

test("an evicted entry is dirty again if the same value is re-added", async () => {
  const initial = pinnedLibrary(310);
  const h = await harness("evict-forgets-saved", initial);
  pin(h, initial);
  await h.cache.initializeThumbnailCache();
  for (const key of Object.keys(initial)) await h.cache.hydrateThumbnail(key);
  assert.equal(h.cache.thumbnails.has("prntsc:0"), false);
  // If eviction left a record of the old copy, an equal value would look already saved.
  h.cache.thumbnails.set("prntsc:0", h.image);
  assert.equal(await h.cache.persistThumbnails(), true);
  assert.ok(
    h.saves.at(-1).entries.some(([key]) => key === "prntsc:0"),
    "re-added entry is written again",
  );
});

test("memory bound also counts bytes, and keeps room for a Stats page of 84", async () => {
  const large = new Array(128 * 1024).fill(0);
  const initial = pinnedLibrary(200, large);
  const h = await harness("bounded-bytes", initial);
  pin(h, initial);
  await h.cache.initializeThumbnailCache();
  for (const key of Object.keys(initial)) await h.cache.hydrateThumbnail(key);
  assert.ok(
    h.cache.thumbnails.size <= 128,
    `byte budget binds at the 128 KiB file maximum: ${h.cache.thumbnails.size}`,
  );
  assert.ok(h.cache.thumbnails.size >= 84, "a Stats page still fits");

  const small = pinnedLibrary(500);
  const s = await harness("stats-page", small);
  pin(s, small);
  await s.cache.initializeThumbnailCache();
  for (const key of Object.keys(small).slice(0, 290)) await s.cache.hydrateThumbnail(key);
  const page = Object.keys(small).slice(300, 384);
  await Promise.all(page.map((key) => s.cache.hydrateThumbnail(key)));
  assert.ok(
    page.every((key) => s.cache.thumbnailFor(key) === s.image),
    "every thumbnail of the page is readable after the batch resolves",
  );
});

test("recently used thumbnails are evicted last", async () => {
  const initial = pinnedLibrary(400);
  const h = await harness("lru", initial);
  pin(h, initial);
  await h.cache.initializeThumbnailCache();
  const keys = Object.keys(initial);
  for (const key of keys.slice(0, 300)) await h.cache.hydrateThumbnail(key);
  assert.ok(h.cache.thumbnailFor(keys[0]), "touching the oldest entry makes it the newest");
  await h.cache.hydrateThumbnail(keys[300]);
  assert.equal(h.cache.thumbnails.has(keys[0]), true, "the touched entry survived");
  assert.equal(h.cache.thumbnails.has(keys[1]), false, "the least recently used entry left");
});

test("concurrent views share one disk read per file", async () => {
  const h = await harness("share-read", { "prntsc:abc": [0] });
  await h.cache.initializeThumbnailCache();
  h.block();
  const results = Promise.all([
    h.cache.hydrateThumbnail("prntsc:abc"),
    h.cache.hydrateThumbnail("prntsc:abc"),
    h.cache.ensureThumbnail({ source: "prntsc", id: "abc" }),
    h.cache.ensureThumbnail({ source: "prntsc", id: "abc" }),
  ]);
  await flush();
  assert.deepEqual(h.reads, ["prntsc:abc"], "one native read for four concurrent requests");
  h.release();
  assert.deepEqual(await results, [true, true, true, true]);
  assert.equal(h.networkCount(), 0);
});

test("a read that lands after its file was pruned does not resurrect the entry", async () => {
  const h = await harness("stale-read", pinnedLibrary(400));
  await h.cache.initializeThumbnailCache();
  h.block();
  const stale = h.cache.hydrateThumbnail("prntsc:0");
  await flush();
  // The ordinary-cache budget prunes the oldest file while its read is in flight.
  await h.cache.persistThumbnails();
  assert.equal(h.disk.has("prntsc:0"), false);
  h.release();
  assert.equal(await stale, false, "a stale read is discarded");
  assert.equal(h.cache.thumbnails.has("prntsc:0"), false);
  await h.cache.cacheEncodedThumbnail("prntsc:other", new Uint8Array([0]), false);
  await h.cache.persistThumbnails();
  assert.equal(h.disk.has("prntsc:0"), false, "the pruned file stays pruned");
});

test("a newer in-memory value wins over an older read that lands later", async () => {
  const h = await harness("newer-wins", { "prntsc:abc": [7] });
  h.state.favorites = [{ source: "prntsc", id: "abc" }];
  await h.cache.initializeThumbnailCache();
  h.block();
  const read = h.cache.hydrateThumbnail("prntsc:abc");
  await flush();
  await h.cache.cacheEncodedThumbnail("prntsc:abc", new Uint8Array([9]), false);
  h.release();
  assert.equal(await read, true);
  assert.equal(h.cache.thumbnailFor("prntsc:abc"), "data:image/jpeg;base64,CQ==", "the fresh bytes are kept");
  assert.equal(await h.cache.persistThumbnails(), true);
  assert.deepEqual(h.disk.get("prntsc:abc"), [9], "and are the ones written, not clobbered by the older read");
});

test("unsaved pinned thumbnails are never evicted, then leave memory once written", async () => {
  const disk = pinnedLibrary(120);
  const h = await harness("dirty-pinned", disk);
  await h.cache.initializeThumbnailCache();
  const ids = Array.from({ length: 350 }, (_, i) => `d${i}`);
  h.state.favorites = [...ids, ...Object.keys(disk).map((key) => key.slice(7))].map((id) => ({ source: "prntsc", id }));
  for (const id of ids) await h.cache.cacheEncodedThumbnail(`prntsc:${id}`, new Uint8Array([1]), false);
  assert.equal(h.cache.thumbnails.size, 350, "the only copy of an unsaved entry stays in memory");
  // Hydrating runs the memory trim while 350 entries are unsaved: none may be evicted,
  // and they must not push out the clean entries a view just read.
  for (const key of Object.keys(disk)) assert.equal(await h.cache.hydrateThumbnail(key), true);
  assert.ok(
    ids.every((id) => h.cache.thumbnails.has(`prntsc:${id}`)),
    "unsaved entries survive the trim",
  );
  assert.ok(
    Object.keys(disk).every((key) => h.cache.thumbnails.has(key)),
    "clean entries are not squeezed out by them",
  );
  assert.equal(await h.cache.persistThumbnails(), true);
  assert.ok(h.cache.thumbnails.size <= 300, "written entries may leave memory");
  assert.equal(h.disk.size, 470, "all of them are on disk");
  assert.equal(await h.cache.hydrateThumbnail("prntsc:d0"), true, "an evicted new entry reads back");
});

test("a failed save retries only its own entries and keeps clean ones evictable", async () => {
  const initial = pinnedLibrary(320);
  const h = await harness("failed-save", initial);
  pin(h, initial);
  await h.cache.initializeThumbnailCache();
  for (const key of Object.keys(initial)) await h.cache.hydrateThumbnail(key);
  await h.cache.cacheEncodedThumbnail("prntsc:new", new Uint8Array([9]), false);
  const invoke = globalThis.window.__TAURI_INTERNALS__.invoke;
  globalThis.window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "save_thumbnail_cache") throw new Error("Disk full");
    return invoke(command, args);
  };
  assert.equal(await h.cache.persistThumbnails(), false);
  // Keys 0-4 left memory earlier; reading them runs the trim while the save is failing.
  assert.equal(h.cache.thumbnails.has("prntsc:0"), false);
  for (const key of Object.keys(initial).slice(0, 5)) assert.equal(await h.cache.hydrateThumbnail(key), true);
  assert.ok(h.cache.thumbnails.size <= 301, `a failing disk does not unbound memory: ${h.cache.thumbnails.size}`);
  assert.ok(h.cache.thumbnails.has("prntsc:new"), "the unsaved entry is kept");
  globalThis.window.__TAURI_INTERNALS__.invoke = invoke;
  assert.equal(await h.cache.persistThumbnails(), true);
  assert.deepEqual(
    h.saves.at(-1).entries.map(([key]) => key),
    ["prntsc:new"],
    "retry rewrites the failed call's entry",
  );
  assert.equal(h.disk.size, 321);
});

test("Saved removal and clear prune evicted files without resurrecting them", async () => {
  const initial = pinnedLibrary(400);
  const h = await harness("evicted-clear", initial);
  pin(h, initial);
  await h.cache.initializeThumbnailCache();
  for (const key of Object.keys(initial)) await h.cache.hydrateThumbnail(key);
  assert.equal(h.cache.thumbnails.has("prntsc:0"), false, "the first entry is evicted");
  const removed = h.state.favorites.shift();
  h.block();
  const stale = h.cache.hydrateThumbnail(`prntsc:${removed.id}`);
  await flush();
  await h.cache.clearThumbnails(h.state.favorites);
  h.release();
  assert.equal(await stale, false);
  assert.equal(h.disk.has("prntsc:0"), false, "the removed Saved file is pruned");
  assert.equal(h.disk.size, 399, "every other Saved file is still on disk");
  assert.equal(h.cache.thumbnailFor("prntsc:0"), undefined);
  assert.equal(await h.cache.hydrateThumbnail("prntsc:1"), true);
});

test("legacy migration of a large library also ends bounded", async () => {
  const h = await harness("legacy-bound");
  const stored = {};
  for (let i = 0; i < 400; i++) stored[`prntsc:m${i}`] = h.image;
  globalThis.localStorage.setItem("prntsc-gallery-thumbnails", JSON.stringify(stored));
  h.state.favorites = Object.keys(stored).map((key) => ({ source: "prntsc", id: key.slice(7) }));
  assert.equal(await h.cache.initializeThumbnailCache(), true);
  assert.equal(h.disk.size, 400, "every migrated file is on disk");
  assert.ok(h.cache.thumbnails.size <= 300, `migration leaves a bounded cache: ${h.cache.thumbnails.size}`);
});

test("a cleared entry re-added with the same bytes after an in-flight save is written again", async () => {
  const h = await harness("cleared-mid-save");
  await h.cache.initializeThumbnailCache();
  await h.cache.cacheEncodedThumbnail("prntsc:k", new Uint8Array([5]), false);
  h.blockSaves();
  const saving = h.cache.persistThumbnails();
  await flush();
  const clearing = h.cache.clearThumbnails([]);
  await flush();
  h.releaseSaves();
  await Promise.all([saving, clearing]);
  assert.equal(h.disk.has("prntsc:k"), false);
  // Same bytes again: a stale "saved" record would make this look unchanged and skip the write.
  await h.cache.cacheEncodedThumbnail("prntsc:k", new Uint8Array([5]), false);
  assert.equal(await h.cache.persistThumbnails(), true);
  assert.deepEqual(h.disk.get("prntsc:k"), [5], "the re-added entry is written");
});

test("a Stats page hydrates fully while hundreds of unsaved entries are held", async () => {
  const disk = pinnedLibrary(120);
  const h = await harness("stats-dirty", disk);
  await h.cache.initializeThumbnailCache();
  const ids = Array.from({ length: 320 }, (_, i) => `u${i}`);
  h.state.favorites = [...ids, ...Object.keys(disk).map((key) => key.slice(7))].map((id) => ({ source: "prntsc", id }));
  for (const id of ids) await h.cache.cacheEncodedThumbnail(`prntsc:${id}`, new Uint8Array([1]), false);
  const page = Object.keys(disk).slice(0, 84);
  await Promise.all(page.map((key) => h.cache.hydrateThumbnail(key)));
  assert.ok(
    page.every((key) => h.cache.thumbnailFor(key) === h.image),
    "the whole page is readable afterwards",
  );
});
