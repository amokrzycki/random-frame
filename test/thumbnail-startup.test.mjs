import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("startup accepts encoded native thumbnails without changing bytes, aliases, or first pruning", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  const image = "data:image/jpeg;base64,AP+A";
  const saves = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "load_thumbnail_cache") return [["prntsc:000abc", image]];
        assert.equal(command, "save_thumbnail_cache");
        saves.push(structuredClone(args));
      },
    },
  };
  const cache = await import("../dist/test-client/frame-cache.js");
  assert.equal(await cache.initializeThumbnailCache(), true);
  assert.equal(cache.thumbnailFor("prntsc:abc"), image);
  assert.equal(await cache.persistThumbnails(), true);
  assert.deepEqual(
    saves,
    [{ entries: [], keep: ["prntsc:000abc"] }],
    "first reconciliation still prunes crash artifacts",
  );
  await cache.persistThumbnails();
  assert.equal(saves.length, 1);
  cache.thumbnails.set("prntsc:000abc", "data:image/jpeg;base64,/wCA");
  await cache.persistThumbnails();
  assert.deepEqual(saves.at(-1).entries, [["prntsc:000abc", [255, 0, 128]]]);
});
