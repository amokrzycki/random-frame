import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, fakeThumbnailCache, ids } from "./dom-fakes.mjs";

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
  const native = fakeThumbnailCache();
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      if (command === "complete_state_imports") return null;
      if (command === "get_user_preferences" || command === "set_user_preferences")
        return { theme: null, historyPageSize: null };
      if (command === "import_session_history") return window.__TAURI_INTERNALS__.invoke("get_history");
      if (command === "load_thumbnail_cache" || command === "save_thumbnail_cache") return native.invoke(command, args);
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
  const stored = () => native.stored();
  await cache.initializeThumbnailCache();
  state.favorites = [frame("old"), ...Array.from({ length: 49 }, (_, i) => frame(`fav${i}`))];
  cache.thumbnails.set(key("old"), image);
  for (let i = 0; i < 49; i++) cache.thumbnails.set(key(`fav${i}`), image);
  for (let i = 0; i < 300; i++) cache.thumbnails.set(key(`history${i}`), image);
  assert.equal(await cache.persistThumbnails(), true);
  assert.equal(Object.keys(stored()).length, 350);
  cache.thumbnails.set(key("new"), image);
  await cache.persistThumbnails();
  assert.equal(stored()[key("old")], image);
  assert.equal(stored()[key("history0")], undefined);
  assert.equal(Object.keys(stored()).length, 350);

  // Promotion changes only the favourites list; the same physical entry survives overflow.
  state.favorites.push(frame("history1"));
  cache.thumbnails.set(key("newer"), image);
  cache.thumbnails.set(key("newer2"), image);
  await cache.persistThumbnails();
  assert.equal(stored()[key("history1")], image);
  assert.equal(Object.keys(stored()).filter((entry) => entry === key("history1")).length, 1);
  assert.equal(stored()[key("history2")], undefined);

  // Demotion makes the old entry eligible for the next ordinary eviction.
  state.favorites = state.favorites.filter(({ id }) => id !== "old");
  cache.thumbnails.set(key("newest"), image);
  await cache.persistThumbnails();
  assert.equal(stored()[key("old")], undefined);
  assert.equal(stored()[key("history1")], image);

  const restarted = await import(`../dist/test-client/frame-cache.js?restart=${Date.now()}`);
  await restarted.initializeThumbnailCache();
  assert.equal(restarted.thumbnails.get(key("history1")), image);
  await restarted.clearThumbnails(state.favorites);
  assert.equal(stored()[key("history1")], image);
  assert.equal(stored()[key("newest")], undefined);

  // A failed file write leaves saved favourites intact and retries the new entry.
  const nativeInvoke = window.__TAURI_INTERNALS__.invoke;
  state.favorites.push(frame("quota"));
  restarted.thumbnails.set(key("quota"), image);
  window.__TAURI_INTERNALS__.invoke = async (command, args) => {
    if (command === "save_thumbnail_cache") throw new Error("Disk full");
    return nativeInvoke(command, args);
  };
  assert.equal(await restarted.persistThumbnails(), false);
  assert.equal(stored()[key("history1")], image);
  assert.equal(stored()[key("quota")], undefined);
  window.__TAURI_INTERNALS__.invoke = nativeInvoke;
  assert.equal(await restarted.persistThumbnails(), true);
  assert.equal(stored()[key("quota")], image);

  // Two requests for one missing favourite share one fetch, including after a clear.
  const missing = frame("imported");
  state.favorites.push(missing);
  const first = restarted.ensureThumbnail(missing);
  const second = restarted.ensureThumbnail(missing);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  await restarted.clearThumbnails(state.favorites);
  release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(stored()[key("imported")], image);

  // A favourite added while its request is pending is pinned at commit time.
  const racing = frame("racing");
  const download = restarted.ensureThumbnail(racing);
  await new Promise((resolve) => setImmediate(resolve));
  state.favorites.push(racing);
  release();
  assert.equal(await download, true);
  for (let i = 0; i < 301; i++) restarted.thumbnails.set(key(`later${i}`), image);
  await restarted.persistThumbnails();
  assert.equal(stored()[key("racing")], image);

  const cleared = frame("cleared");
  const obsolete = restarted.ensureThumbnail(cleared);
  await new Promise((resolve) => setImmediate(resolve));
  await restarted.clearThumbnails(state.favorites);
  release();
  assert.equal(await obsolete, false);
  assert.equal(stored()[key("cleared")], undefined);
});
