import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

test("writes only changed files, with retry and eviction", async () => {
  const image = "data:image/jpeg;base64,AA==";
  const disk = new Map();
  const saves = [];
  let fail = true;
  globalThis.document = new FakeDocument(ids);
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "get_user_preferences" || command === "set_user_preferences")
          return { theme: null, historyPageSize: null };
        if (command === "list_thumbnail_cache") return [...disk].map(([key, bytes]) => [key, bytes.length]);
        if (command === "read_thumbnail_cache") {
          const bytes = disk.get(args.key);
          return bytes ? `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}` : null;
        }
        assert.equal(command, "save_thumbnail_cache");
        saves.push(structuredClone(args));
        if (fail) throw new Error("Disk full");
        for (const [key] of args.entries) if (!args.keep.includes(key)) throw new Error(`Thumbnail ${key} is not kept`);
        for (const [key, bytes] of args.entries) disk.set(key, bytes);
        for (const key of disk.keys()) if (!args.keep.includes(key)) disk.delete(key);
      },
    },
  };
  const { state } = await import("../dist/test-client/viewer-state.js");
  const cache = await import("../dist/test-client/frame-cache.js");
  cache.thumbnails.set("prntsc:old", image);
  assert.equal(await cache.persistThumbnails(), false);
  assert.equal(disk.size, 0, "a failed native save leaves no file behind");
  fail = false;
  assert.equal(await cache.persistThumbnails(), true);
  assert.deepEqual(disk.get("prntsc:old"), [0]);
  const savedSaves = saves.length;
  await cache.persistThumbnails();
  assert.equal(saves.length, savedSaves, "unchanged saved files need no native call");
  state.favorites = [{ source: "prntsc", id: "old" }];
  for (let i = 0; i < 301; i++) cache.thumbnails.set(`prntsc:new${i}`, image);
  assert.equal(await cache.persistThumbnails(), true);
  assert.equal(disk.size, 301);
  assert.ok(disk.has("prntsc:old"));
  assert.ok(!disk.has("prntsc:new0"));
  assert.equal(saves.at(-1).entries.length, 300);
  cache.thumbnails.set("prntsc:latest", image);
  fail = true;
  assert.equal(await cache.persistThumbnails(), false);
  fail = false;
  assert.equal(await cache.persistThumbnails(), true);
  assert.deepEqual(
    saves.at(-1).entries.map(([key]) => key),
    ["prntsc:latest"],
    "a failed native save may have partially written its own files, so retry resends exactly those entries",
  );
  await cache.clearThumbnails(state.favorites);
  assert.deepEqual([...disk.keys()], ["prntsc:old"]);
});

test("encoded Nearby JPEGs share pending keys and obey byte budget while Saved stays on disk", async () => {
  const cache = await import("../dist/test-client/frame-cache.js");
  const { state } = await import("../dist/test-client/viewer-state.js");
  cache.thumbnails.clear();
  state.favorites = [{ source: "prntsc", id: "pinned" }];
  const bytes = new Uint8Array(128 * 1024);
  assert.equal(await cache.cacheEncodedThumbnail("prntsc:pinned", bytes, false), true);
  for (let i = 0; i < 70; i++) await cache.cacheEncodedThumbnail(`prntsc:${i}`, bytes, false);
  await cache.persistThumbnails();
  assert.ok(cache.thumbnails.has("prntsc:pinned"));
  assert.equal(cache.thumbnails.size, 65);
});

test("canonical Nearby keys reuse leading-zero aliases and borrowed viewer URLs survive a clear", async () => {
  const cache = await import("../dist/test-client/frame-cache.js");
  const jpeg = "data:image/jpeg;base64,AQ==";
  cache.thumbnails.set("prntsc:0abc123", jpeg);
  assert.equal(cache.thumbnailFor("prntsc:abc123"), jpeg);
  const url = URL.createObjectURL(new Blob([new Uint8Array([1])]));
  cache.blobs.set("prntsc:abc123", { url, blob: new Blob([new Uint8Array([1])]) });
  const release = cache.borrowBlobUrl(url);
  cache.releaseAllBlobs();
  const { resolveObjectURL } = await import("node:buffer");
  assert.equal(resolveObjectURL(url).size, 1);
  release();
  release();
  assert.equal(resolveObjectURL(url), undefined);
});

test("Saved leading-zero aliases pin canonical Nearby previews through eviction and clear", async () => {
  const cache = await import("../dist/test-client/frame-cache.js");
  const { state } = await import("../dist/test-client/viewer-state.js");
  cache.thumbnails.clear();
  state.favorites = [{ source: "prntsc", id: "0abc123" }];
  const bytes = new Uint8Array(128 * 1024);
  await cache.cacheEncodedThumbnail("prntsc:abc123", bytes, false);
  for (let i = 0; i < 70; i++) await cache.cacheEncodedThumbnail(`prntsc:${i}`, bytes, false);
  assert.ok(cache.thumbnails.has("prntsc:abc123"), "canonical Saved preview survives pressure");
  const generation = cache.thumbnailGeneration();
  await cache.clearThumbnails(state.favorites);
  assert.deepEqual([...cache.thumbnails.keys()], ["prntsc:abc123"]);
  cache.thumbnails.clear();
  assert.equal(await cache.cacheEncodedThumbnail("prntsc:abc123", bytes, false, generation), true);
  assert.ok(cache.thumbnails.has("prntsc:abc123"), "in-flight Saved alias survives a clear");
});
