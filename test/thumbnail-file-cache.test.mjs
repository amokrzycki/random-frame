import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("migrates thumbnail storage and writes only changed files, with retry and eviction", async () => {
  const legacyKey = "prntsc-gallery-thumbnails";
  const image = "data:image/jpeg;base64,AA==";
  const storage = new FakeStorage();
  storage.setItem(legacyKey, JSON.stringify({ "prntsc:old": image }));
  const disk = new Map();
  const saves = [];
  let fail = true;
  globalThis.localStorage = storage;
  globalThis.document = new FakeDocument(ids);
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "load_thumbnail_cache") return [...disk];
        assert.equal(command, "save_thumbnail_cache");
        saves.push(structuredClone(args));
        if (fail) throw new Error("Disk full");
        for (const [key, bytes] of args.entries) disk.set(key, bytes);
        for (const key of disk.keys()) if (!args.keep.includes(key)) disk.delete(key);
      },
    },
  };
  const { state } = await import("../dist/test-client/viewer-state.js");
  const cache = await import("../dist/test-client/frame-cache.js");
  assert.equal(await cache.initializeThumbnailCache(), false);
  assert.ok(storage.getItem(legacyKey), "failed migration keeps the original");
  fail = false;
  assert.equal(await cache.initializeThumbnailCache(), true);
  assert.equal(storage.getItem(legacyKey), null);
  assert.deepEqual(disk.get("prntsc:old"), [0]);
  await cache.persistThumbnails();
  assert.deepEqual(saves.at(-1).entries, [], "saved files are not rewritten");
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
  );
  await cache.clearThumbnails(state.favorites);
  assert.deepEqual([...disk.keys()], ["prntsc:old"]);
  assert.equal(storage.getItem(legacyKey), null);

  // Retrying a failed migration must not bring back thumbnails cleared meanwhile.
  storage.setItem(legacyKey, JSON.stringify({ "prntsc:old": image, "prntsc:obsolete": image }));
  const restarted = await import(`../dist/test-client/frame-cache.js?restart=${Date.now()}`);
  fail = true;
  assert.equal(await restarted.initializeThumbnailCache(), false);
  await restarted.clearThumbnails(state.favorites);
  fail = false;
  assert.equal(await restarted.persistThumbnails(), true);
  assert.deepEqual([...disk.keys()], ["prntsc:old"]);
  assert.equal(restarted.thumbnails.has("prntsc:obsolete"), false);
  assert.equal(storage.getItem(legacyKey), null);
});
