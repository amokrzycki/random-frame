import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { FakeDocument, FakeStorage, ids, libraryOf } from "../test/dom-fakes.mjs";

// Run after npm run build:test. DOM doubles measure JS work, not layout or paint.
globalThis.document = new FakeDocument(ids);
globalThis.localStorage = new FakeStorage();
globalThis.window = new EventTarget();
let saves = 0;
window.__TAURI_INTERNALS__ = {
  async invoke(command) {
    if (command === "list_thumbnail_cache" || command === "load_thumbnail_cache") return [];
    if (command === "read_thumbnail_cache") return null;
    assert.equal(command, "save_thumbnail_cache");
    saves++;
  },
};
const { state } = await import("../dist/test-client/viewer-state.js");
const cache = await import("../dist/test-client/frame-cache.js");
const { bindHistoryDialogEvents, openHistory } = await import("../dist/test-client/history-dialog.js");
bindHistoryDialogEvents();
assert.equal(await cache.initializeThumbnailCache(), true, "Thumbnail cache initialization failed");
state.loading = false;
state.pageSize = 50;
const get = (id) => document.querySelector(`#${id}`);
const results = [];
async function measure(name, size, work, iterations = 40) {
  for (let i = 0; i < 5; i++) await work();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await work();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  results.push({
    name,
    size,
    medianMs: samples[Math.floor(samples.length / 2)],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
  });
}
for (const size of [100, 1000, 10000]) {
  state.history = Array.from({ length: size }, (_, i) => ({
    source: "prntsc",
    id: (i + 100000).toString(36),
    sourcePageUrl: "",
    viewedAt: 1700000000000 + i * 1000,
  }));
  state.index = size - 1;
  state.library = libraryOf(state.history.map((item) => ({ ...item, addedAt: item.viewedAt })));
  state.favorites = state.library.items;
  cache.thumbnails.clear();
  for (const item of state.history) cache.thumbnails.set(`prntsc:${item.id}`, "data:image/jpeg;base64,AA==");
  state.historyTab = "history";
  await measure("history-open-js", size, () => {
    openHistory();
    get("history-close-button").click();
  });
  state.historyTab = "favourites";
  await measure("saved-open-js", size, () => {
    openHistory();
    get("history-close-button").click();
  });
  openHistory();
  await measure("saved-page-js", size, () => {
    get("history-page-next").click();
    get("history-page-previous").click();
  });
  get("history-close-button").click();
  await measure("thumbnail-alias-hit-100", size, () => {
    for (let i = 0; i < 100; i++) assert.ok(cache.thumbnailFor(`prntsc:0${state.history[size - 1].id}`));
  });
  await measure("thumbnail-miss-100", size, () => {
    for (let i = 0; i < 100; i++) assert.equal(cache.thumbnailFor("prntsc:zzzzzz"), undefined);
  });
  assert.equal(await cache.persistThumbnails(), true, "Thumbnail cache persistence failed");
  const before = saves;
  await measure(
    "thumbnail-unchanged-save",
    size,
    async () => {
      assert.equal(await cache.persistThumbnails(), true, "Thumbnail cache persistence failed");
    },
    20,
  );
  results.push({ name: "unchanged-save-ipc-calls", size, calls: saves - before, requests: 25 });
}
process.stdout.write(`${JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2)}\n`);
