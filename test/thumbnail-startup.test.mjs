import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("startup lists thumbnail keys without reading bytes, then hydrates one on demand", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  const image = "data:image/jpeg;base64,AP+A";
  const reads = [];
  const saves = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "list_thumbnail_cache")
          return [
            ["prntsc:000abc", 3],
            ["prntsc:def", 2],
          ];
        if (command === "read_thumbnail_cache") {
          reads.push(args.key);
          return image;
        }
        assert.equal(command, "save_thumbnail_cache");
        saves.push(structuredClone(args));
      },
    },
  };
  const cache = await import("../dist/test-client/frame-cache.js");
  assert.equal(await cache.initializeThumbnailCache(), true);
  assert.equal(cache.thumbnails.size, 0, "startup keeps image bytes on disk");
  assert.deepEqual(reads, [], "startup reads no thumbnail files");
  assert.equal(await cache.persistThumbnails(), true);
  assert.deepEqual(
    saves,
    [{ entries: [], keep: ["prntsc:000abc", "prntsc:def"] }],
    "the first reconciliation keeps unloaded files and prunes crash artifacts",
  );
  assert.equal(await cache.hydrateThumbnail("prntsc:abc"), true);
  assert.deepEqual(reads, ["prntsc:000abc"], "a leading-zero alias reads the stored file");
  assert.equal(cache.thumbnailFor("prntsc:abc"), image);
  await cache.persistThumbnails();
  assert.equal(saves.length, 1, "a disk hit needs no write");
  cache.thumbnails.set("prntsc:000abc", "data:image/jpeg;base64,/wCA");
  await cache.persistThumbnails();
  assert.deepEqual(saves.at(-1).entries, [["prntsc:000abc", [255, 0, 128]]]);
});
