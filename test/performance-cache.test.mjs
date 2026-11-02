import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("thumbnail aliases use bounded lookups and unchanged persistence skips native I/O", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  let calls = 0;
  let fail = false;
  let failAfterWrite = false;
  const disk = new Map();
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "list_thumbnail_cache") return [];
        if (command === "read_thumbnail_cache") return null;
        assert.equal(command, "save_thumbnail_cache");
        calls++;
        if (fail) throw new Error("Disk full");
        for (const [key, bytes] of args.entries) {
          disk.set(key, bytes);
          if (failAfterWrite) throw new Error("Disk full after one write");
        }
        for (const key of disk.keys()) if (!args.keep.includes(key)) disk.delete(key);
      },
    },
  };
  const cache = await import("../dist/test-client/frame-cache.js");
  await cache.initializeThumbnailCache();
  cache.thumbnails.set("prntsc:000abc", "data:image/jpeg;base64,AA==");
  cache.thumbnails.set("prntsc:abc", "data:image/jpeg;base64,AQ==");
  assert.equal(cache.thumbnailFor("prntsc:abc"), "data:image/jpeg;base64,AQ==", "exact spelling wins");
  cache.thumbnails.delete("prntsc:abc");
  const iterate = cache.thumbnails[Symbol.iterator];
  cache.thumbnails[Symbol.iterator] = () => {
    throw new Error("Lookup must not scan the thumbnail cache");
  };
  assert.equal(cache.thumbnailFor("prntsc:0abc"), "data:image/jpeg;base64,AA==");
  assert.equal(cache.thumbnailFor("prntsc:0000000"), undefined);
  assert.equal(cache.thumbnailFor("prntsc:ABC"), undefined);
  assert.equal(cache.thumbnailFor("other:abc"), undefined);
  cache.thumbnails[Symbol.iterator] = iterate;
  assert.equal(await cache.persistThumbnails(), true);
  const saved = calls;
  await Promise.all([cache.persistThumbnails(), cache.persistThumbnails()]);
  assert.equal(calls, saved, "unchanged snapshots perform no IPC or filesystem pruning");
  cache.thumbnails.set("prntsc:abc", "data:image/jpeg;base64,AQ==");
  fail = true;
  assert.equal(await cache.persistThumbnails(), false);
  fail = false;
  assert.equal(await cache.persistThumbnails(), true, "failed writes remain retryable");
  cache.thumbnails.set("prntsc:abc", "data:image/jpeg;base64,Ag==");
  assert.equal(await cache.persistThumbnails(), true, "same-size repairs are persisted");
  assert.deepEqual(disk.get("prntsc:abc"), [2]);
  cache.discardThumbnail("prntsc:abc", "data:image/jpeg;base64,Ag==");
  assert.equal(await cache.persistThumbnails(), true);
  assert.equal(disk.has("prntsc:abc"), false, "discard-only writes still prune disk");
  await cache.clearThumbnails([]);
  assert.equal(disk.size, 0, "a deletion-only snapshot still prunes disk");
  const cleared = calls;
  await cache.persistThumbnails();
  assert.equal(calls, cleared);
  cache.thumbnails.set("prntsc:abc", "data:image/jpeg;base64,AA==");
  cache.thumbnails.set("prntsc:def", "data:image/jpeg;base64,AQ==");
  failAfterWrite = true;
  assert.equal(await cache.persistThumbnails(), false);
  assert.equal(disk.size, 1, "the native failure can leave partial writes");
  failAfterWrite = false;
  await cache.clearThumbnails([]);
  assert.equal(disk.size, 0, "clear reconciles disk after partial failure even from an empty saved snapshot");
  cache.thumbnails.set("prntsc:abc", "data:image/jpeg;base64,AA==");
  await cache.persistThumbnails();
  cache.thumbnails.set("prntsc:abc", "data:image/jpeg;base64,AQ==");
  failAfterWrite = true;
  assert.equal(await cache.persistThumbnails(), false);
  assert.deepEqual(disk.get("prntsc:abc"), [1]);
  cache.thumbnails.set("prntsc:abc", "data:image/jpeg;base64,AA==");
  failAfterWrite = false;
  await cache.persistThumbnails();
  assert.deepEqual(disk.get("prntsc:abc"), [0], "retry restores previous bytes after a partially written repair");
});
