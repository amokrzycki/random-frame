import assert from "node:assert/strict";
import { resolveObjectURL } from "node:buffer";
import { after, test } from "node:test";
import { FakeDocument, FakeStorage, ids, libraryOf } from "./dom-fakes.mjs";

const document = new FakeDocument(ids);
Object.assign(globalThis, {
  document,
  localStorage: new FakeStorage(),
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command) => (command === "load_thumbnail_cache" ? [] : undefined),
    },
  },
});
const viewer = await import("../dist/test-client/viewer-state.js");
const stage = await import("../dist/test-client/stage.js");
const cache = await import("../dist/test-client/frame-cache.js");
stage.bindStageEvents();
after(() => {
  document.querySelector("#image-ghost").dispatchEvent(new Event("animationend"));
  cache.releaseAllBlobs();
});
const item = (index) => ({
  source: "prntsc",
  id: index.toString(36),
  sourcePageUrl: `https://prnt.sc/${index.toString(36)}`,
  viewedAt: 1,
});

test("large History and Saved projections preserve their arrays without argument limits", () => {
  const history = Array.from({ length: 150_000 }, (_, index) => item(index));
  const originalHistory = viewer.state.history;
  const originalSaved = viewer.state.favorites;
  viewer.applyHistory({ history, index: 149_999 });
  viewer.applySavedLibrary(libraryOf(history));
  assert.equal(viewer.state.history, originalHistory);
  assert.equal(viewer.state.favorites, originalSaved);
  assert.equal(viewer.state.history.length, 150_000);
  assert.equal(viewer.state.favorites.length, 150_000);
  assert.equal(viewer.state.history[149_999].id, "37qn");
  viewer.applyHistory({ history: [], index: -1 });
  viewer.applySavedLibrary(libraryOf());
});

test("full images are bounded while transitions and borrowed previews remain readable", () => {
  viewer.state.loading = false;
  const frame = (index, bytes) => {
    const current = item(index);
    viewer.applyHistory({ history: [current], index: 0 });
    const blob = new Blob([new Uint8Array(bytes)]);
    const url = URL.createObjectURL(blob);
    stage.showFrame(current.source, current.id, blob, url);
    return url;
  };
  const borrowed = frame(0, 8 * 1024 * 1024);
  const release = cache.borrowBlobUrl(borrowed);
  for (let index = 1; index < 12; index++) frame(index, 8 * 1024 * 1024);
  assert.ok([...cache.blobs.values()].reduce((bytes, entry) => bytes + entry.blob.size, 0) <= 32 * 1024 * 1024);
  assert.ok(cache.blobs.has("prntsc:b"));
  assert.equal(cache.blobs.has("prntsc:0"), false);
  assert.equal(resolveObjectURL(borrowed).size, 8 * 1024 * 1024);
  release();
  assert.equal(resolveObjectURL(borrowed), undefined);
  const outgoing = frame(20, 15_000_000);
  frame(21, 15_000_000);
  frame(22, 15_000_000);
  const ghost = document.querySelector("#image-ghost");
  const transitioning = ghost.src;
  assert.ok(resolveObjectURL(transitioning));
  assert.equal(resolveObjectURL(outgoing), undefined);
  ghost.dispatchEvent(new Event("animationend"));
  for (let index = 30; index < 130; index++) frame(index, 1);
  assert.ok(cache.blobs.size <= 20);
});
