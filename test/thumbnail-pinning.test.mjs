import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("favourite thumbnails share the cache but never consume its eviction budget", async (t) => {
  const names = ["document", "localStorage", "window", "createImageBitmap"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
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
          toDataURL: () => "data:image/jpeg;base64,AA==",
        }
      : createElement(tag);
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  let requests = 0;
  let release;
  window.__TAURI_INTERNALS__ = {
    async invoke(command) {
      assert.equal(command, "get_thumbnail_image");
      requests++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return new Uint8Array([1]).buffer;
    },
  };
  Object.assign(globalThis, {
    document,
    localStorage,
    window,
    createImageBitmap: async () => ({
      width: 100,
      height: 100,
      close() {
        /* Fake bitmap */
      },
    }),
  });

  const { state } = await import("../dist/test-client/viewer-state.js");
  const cache = await import("../dist/test-client/frame-cache.js");
  const frame = (id) => ({ source: "prntsc", id });
  const key = (id) => cache.blobKey("prntsc", id);
  const image = "data:image/jpeg;base64,AA==";
  const stored = () => JSON.parse(localStorage.getItem("prntsc-gallery-thumbnails"));
  state.favorites = [frame("old"), ...Array.from({ length: 49 }, (_, i) => frame(`fav${i}`))];
  cache.thumbnails.set(key("old"), image);
  for (let i = 0; i < 49; i++) cache.thumbnails.set(key(`fav${i}`), image);
  for (let i = 0; i < 300; i++) cache.thumbnails.set(key(`history${i}`), image);
  assert.equal(cache.persistThumbnails(), true);
  assert.equal(Object.keys(stored()).length, 350);
  cache.thumbnails.set(key("new"), image);
  cache.persistThumbnails();
  assert.equal(stored()[key("old")], image);
  assert.equal(stored()[key("history0")], undefined);
  assert.equal(Object.keys(stored()).length, 350);

  // Promotion changes only the favourites list; the same physical entry survives overflow.
  state.favorites.push(frame("history1"));
  cache.thumbnails.set(key("newer"), image);
  cache.thumbnails.set(key("newer2"), image);
  cache.persistThumbnails();
  assert.equal(stored()[key("history1")], image);
  assert.equal(Object.keys(stored()).filter((entry) => entry === key("history1")).length, 1);
  assert.equal(stored()[key("history2")], undefined);

  // Demotion makes the old entry eligible for the next ordinary eviction.
  state.favorites = state.favorites.filter(({ id }) => id !== "old");
  cache.thumbnails.set(key("newest"), image);
  cache.persistThumbnails();
  assert.equal(stored()[key("old")], undefined);
  assert.equal(stored()[key("history1")], image);

  const restarted = await import(`../dist/test-client/frame-cache.js?restart=${Date.now()}`);
  assert.equal(restarted.thumbnails.get(key("history1")), image);
  restarted.clearThumbnails(state.favorites);
  assert.equal(stored()[key("history1")], image);
  assert.equal(stored()[key("newest")], undefined);

  // A quota failure first clears ordinary entries and leaves saved favourites intact.
  restarted.thumbnails.set(key("prequota"), image);
  restarted.persistThumbnails();
  const originalSetItem = localStorage.setItem.bind(localStorage);
  const writes = [];
  localStorage.setItem = (name, value) => {
    if (name === "prntsc-gallery-thumbnails") {
      const keys = Object.keys(JSON.parse(value));
      writes.push(keys);
      if (keys.some((entry) => entry === key("quota"))) throw new DOMException("Full", "QuotaExceededError");
    }
    originalSetItem(name, value);
  };
  state.favorites.push(frame("quota"));
  restarted.thumbnails.set(key("ordinary"), image);
  restarted.thumbnails.set(key("quota"), image);
  assert.equal(restarted.persistThumbnails(), false);
  assert.equal(
    writes.at(-1).some((entry) => entry === key("ordinary")),
    false,
  );
  assert.equal(stored()[key("history1")], image);
  assert.equal(stored()[key("prequota")], undefined);
  assert.equal(
    state.favorites.some(({ id }) => id === "quota"),
    true,
  );
  localStorage.setItem = originalSetItem;

  localStorage.setItem = (name, value) => {
    if (name === "prntsc-gallery-thumbnails" && Object.keys(JSON.parse(value)).includes(key("ordinary")))
      throw new DOMException("Full", "QuotaExceededError");
    originalSetItem(name, value);
  };
  restarted.thumbnails.set(key("ordinary"), image);
  assert.equal(restarted.persistThumbnails(), true);
  assert.equal(stored()[key("ordinary")], undefined);
  assert.equal(stored()[key("quota")], image);
  localStorage.setItem = originalSetItem;

  // Two requests for one missing favourite share one fetch, including after a clear.
  const missing = frame("imported");
  state.favorites.push(missing);
  const first = restarted.ensureThumbnail(missing);
  const second = restarted.ensureThumbnail(missing);
  await Promise.resolve();
  assert.equal(requests, 1);
  restarted.clearThumbnails(state.favorites);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(stored()[key("imported")], image);

  // A favourite added while its request is pending is pinned at commit time.
  const racing = frame("racing");
  const download = restarted.ensureThumbnail(racing);
  await Promise.resolve();
  state.favorites.push(racing);
  release();
  assert.equal(await download, true);
  for (let i = 0; i < 301; i++) restarted.thumbnails.set(key(`later${i}`), image);
  restarted.persistThumbnails();
  assert.equal(stored()[key("racing")], image);

  const cleared = frame("cleared");
  const obsolete = restarted.ensureThumbnail(cleared);
  await Promise.resolve();
  restarted.clearThumbnails(state.favorites);
  release();
  assert.equal(await obsolete, false);
  assert.equal(stored()[key("cleared")], undefined);
});
