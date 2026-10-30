import { operationKey } from "../src/client/favorites.ts";
import * as cache from "../src/client/frame-cache.ts";
import { bindHistoryDialogEvents, openHistory } from "../src/client/history-dialog.ts";
import { state } from "../src/client/viewer-state.ts";

let ipc = 0;
window.__TAURI_INTERNALS__ = {
  async invoke(command) {
    if (command === "load_thumbnail_cache") return [];
    if (command === "save_thumbnail_cache") {
      ipc++;
      return;
    }
    throw new Error(`Unexpected benchmark IPC: ${command}`);
  },
};
const get = (id) => document.getElementById(id);
const operationId = (i) => Array.from({ length: 16 }, (_, byte) => (byte === 0 ? i & 255 : byte === 1 ? i >> 8 : 0));
bindHistoryDialogEvents();
state.loading = false;
state.pageSize = 50;
get("entry-dialog").close();
window.runPerformanceBenchmark = async () => {
  await cache.initializeThumbnailCache();
  const results = [];
  async function measure(name, size, work) {
    for (let i = 0; i < 5; i++) {
      await work();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const samples = [];
    for (let i = 0; i < 40; i++) {
      const start = performance.now();
      await work();
      samples.push(performance.now() - start);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    samples.sort((a, b) => a - b);
    results.push({ name, size, medianMs: samples[20], p95Ms: samples[37] });
  }
  for (const size of [100, 1000, 10000]) {
    state.savedFilter = "all";
    state.history = Array.from({ length: size }, (_, i) => ({
      source: "prntsc",
      id: (i + 100000).toString(36),
      sourcePageUrl: "",
      viewedAt: 1700000000000 + i * 1000,
    }));
    state.index = size - 1;
    state.favorites = state.history.map((item, i) => ({
      ...item,
      addedAt: item.viewedAt,
      saveOperationIds: [operationId(i)],
    }));
    state.library = { items: state.favorites, collections: [], memberships: [] };
    cache.thumbnails.clear();
    // Valid 1px JPEG generated locally; every tile stays off the network.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const image = canvas.toDataURL("image/jpeg");
    for (const item of state.history) cache.thumbnails.set(`prntsc:${item.id}`, image);
    for (const tab of ["history", "favourites"]) {
      state.historyTab = tab;
      await measure(`${tab}-open-layout`, size, () => {
        openHistory();
        get("history-grid").getBoundingClientRect();
        // Native close skips the intentional exit animation between samples.
        get("history-dialog").close();
      });
    }
    openHistory();
    await measure("saved-page-layout", size, () => {
      get("history-page-next").click();
      get("history-grid").getBoundingClientRect();
      get("history-page-previous").click();
      get("history-grid").getBoundingClientRect();
    });
    get("history-dialog").close();
    await measure("thumbnail-miss-100", size, () => {
      for (let i = 0; i < 100; i++) cache.thumbnailFor("prntsc:zzzzzz");
    });
    await cache.persistThumbnails();
    const before = ipc;
    await measure("thumbnail-unchanged-save", size, () => cache.persistThumbnails());
    results.push({ name: "unchanged-save-ipc-calls", size, calls: ipc - before, requests: 45 });
    state.library.collections = Array.from({ length: 10 }, (_, i) => ({
      collectionId: operationId(i + 20000),
      name: `Collection ${i}`,
    }));
    state.library.memberships = state.favorites
      .filter((_, i) => i % 5 !== 0)
      .map((item, i) => ({
        operationId: operationId(i + 30000),
        collectionId: state.library.collections[i % 10].collectionId,
        favoriteOperationId: item.saveOperationIds[0],
      }));
    openHistory();
    await measure("collection-switch-layout", size, () => {
      for (const collection of state.library.collections.slice(0, 2)) {
        get("saved-filter").value = operationKey(collection.collectionId);
        get("saved-filter").dispatchEvent(new Event("change"));
        get("history-grid").getBoundingClientRect();
      }
    });
    get("history-dialog").close();
  }
  const report = { userAgent: navigator.userAgent, results };
  window.performanceResult = report;
  document.title = "Benchmark complete";
  return report;
};
if (new URL(location.href).searchParams.has("autorun")) {
  window.runPerformanceBenchmark().catch((error) => {
    window.performanceResult = { error: String(error), stack: error.stack };
  });
}
