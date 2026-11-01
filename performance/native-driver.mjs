import { invoke } from "@tauri-apps/api/core";
import { closeDialog } from "../src/client/dialogs.ts";
import { elements } from "../src/client/elements.ts";
import { operationKey } from "../src/client/favorites.ts";
import { blobKey, blobs, releaseAllBlobs } from "../src/client/frame-cache.ts";
import { goTo } from "../src/client/frame-loader.ts";
import { openHistory } from "../src/client/history-dialog.ts";
import { openNearby } from "../src/client/nearby-dialog.ts";
import { getViewState } from "../src/client/stage.ts";
import { refreshPersistedView, state } from "../src/client/viewer-state.ts";
import { assertNavigationSucceeded } from "./native-navigation.mjs";
import { retentionWorkload } from "./native-retention.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const paint = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
async function until(predicate, timeout = 30000) {
  const start = performance.now();
  while (!predicate()) {
    if (performance.now() - start > timeout) throw Error(`Native benchmark condition timed out: ${predicate}`);
    await sleep(10);
  }
}
const observations = {};
async function sample(name, action, count) {
  __rf.phase = name;
  const values = [];
  for (let i = 0; i < count + 3; i++) {
    const start = performance.now();
    await action(i);
    await paint();
    if (i >= 3) values.push(performance.now() - start);
    await sleep(30);
  }
  observations[name] = values;
}
const resources = [];
function checkpoint(name) {
  const blobBytes = [...blobs.values()].reduce((total, entry) => total + entry.blob.size, 0);
  if (blobs.size > 20 || blobBytes > 32 * 1024 * 1024 || __rf.urls.size > 22)
    throw Error(`Native retention bounds exceeded at ${name}`);
  resources.push({
    name,
    at: performance.now(),
    urls: __rf.urls.size,
    urlBytes: [...__rf.urls.values()].reduce((a, b) => a + b, 0),
    cachedBlobs: blobs.size,
    blobBytes,
  });
}
async function closeHistory() {
  closeDialog(elements.historyDialog);
  await until(() => !elements.historyDialog.open);
  await paint();
}
async function navigate(targetIndex) {
  await goTo(targetIndex);
  const target = state.history[targetIndex];
  await assertNavigationSucceeded(targetIndex, {
    state,
    elements,
    getViewState,
    expectedUrl: target && blobs.get(blobKey(target.source, target.id))?.url,
  });
}
async function run() {
  const config = await invoke("performance_config");
  const count = Number(config.samples);
  await until(
    () =>
      !state.loading &&
      state.history.length > 0 &&
      state.index >= 0 &&
      getViewState() === "image" &&
      !elements.imageZoom.hidden &&
      elements.image.src.startsWith("blob:") &&
      elements.image.complete &&
      elements.image.naturalWidth === 1920,
    180000,
  );
  await paint();
  const startup = {
    ...__rf.milestones,
    ready: performance.now(),
    launchToTimeOrigin: performance.timeOrigin - Number(config.launch),
    timeOrigin: performance.timeOrigin,
  };
  if (state.historyLoadFailed) throw Error("Native startup failed");
  if (!__rf.ipc.some((span) => span.name === "list_thumbnail_cache")) throw Error("IPC probe did not run");
  // Demand loading is the point of this build: readiness may read the restored frame's
  // thumbnail, but never the whole library.
  const startupReads = __rf.ipc.filter(
    (span) => span.name === "read_thumbnail_cache" && span.phase === "startup",
  ).length;
  if (startupReads > 2) throw Error(`Startup read ${startupReads} thumbnail files eagerly`);
  checkpoint("startup");
  if (config.mode === "retention") {
    const retention = await retentionWorkload();
    await invoke("performance_report", {
      payload: {
        startup,
        observations,
        retention,
        ipc: __rf.ipc,
        frames: __rf.frames,
        spans: __rf.spans,
        userAgent: navigator.userAgent,
        count: state.history.length,
        done: true,
      },
    });
    return;
  }
  await sleep(700);
  // The first actual thumbnail-consuming view is measured before the sampled loops,
  // because their warmups would otherwise hide its one-time cost.
  const firstOpen = async (tab) => {
    state.historyTab = tab;
    const start = performance.now();
    openHistory();
    await paint();
    const rendered = performance.now() - start;
    // Visible-tile completion: every on-screen skeleton resolved to an image or placeholder.
    const visibleTiles = () => {
      const body = elements.historyBody.getBoundingClientRect();
      return [...elements.historyGrid.querySelectorAll(".history-item")].filter((tile) => {
        const rect = tile.getBoundingClientRect();
        return rect.width > 0 && rect.bottom > body.top && rect.top < body.bottom;
      });
    };
    await until(() => {
      const tiles = visibleTiles();
      return tiles.length > 0 && tiles.every((tile) => !tile.hasAttribute("data-loading"));
    }, 30000);
    await paint();
    const ready = performance.now() - start;
    await closeHistory();
    return { rendered, ready };
  };
  __rf.phase = "firstThumbnailOpen";
  const firstHistory = await firstOpen("history");
  observations.firstHistoryOpen = [firstHistory.rendered];
  observations.firstHistoryReady = [firstHistory.ready];
  const firstSaved = await firstOpen("favourites");
  observations.firstSavedOpen = [firstSaved.rendered];
  observations.firstSavedReady = [firstSaved.ready];
  await sample(
    "historyOpen",
    async () => {
      state.historyTab = "history";
      const start = performance.now();
      openHistory();
      await paint();
      const duration = performance.now() - start;
      await closeHistory();
      // Store opening alone; close animation is deliberately outside that measurement.
      observations.historyOpenOnly ??= [];
      observations.historyOpenOnly.push(duration);
    },
    count,
  );
  await sample(
    "savedOpen",
    async () => {
      state.historyTab = "favourites";
      const start = performance.now();
      openHistory();
      await paint();
      observations.savedOpenOnly ??= [];
      observations.savedOpenOnly.push(performance.now() - start);
      await closeHistory();
    },
    count,
  );
  state.historyTab = "favourites";
  openHistory();
  await sleep(300);
  const collection = operationKey(state.library.memberships[0].collectionId);
  const choose = (value) => {
    elements.savedFilter.value = value;
    elements.savedFilter.dispatchEvent(new Event("change"));
  };
  await sample(
    "collectionSwitchPair",
    async () => {
      choose(collection);
      if (!elements.historyGrid.children.length) throw Error("Collection fixture must have visible members");
      await paint();
      choose("all");
    },
    count,
  );
  await sample(
    "paginationPair",
    async () => {
      elements.historyPageNext.click();
      await paint();
      elements.historyPagePrevious.click();
    },
    count,
  );
  await sample("persistedRefresh", () => refreshPersistedView(), Math.min(count, 10));
  __rf.phase = "scroll";
  for (let i = 0; i < 90; i++) {
    elements.historyBody.scrollTop = (i % 45) * 20;
    await new Promise(requestAnimationFrame);
  }
  await closeHistory();
  await sample(
    "navigationDecode",
    async (i) => {
      await navigate((i + 1) % state.history.length);
    },
    Math.min(count, 12),
  );
  checkpoint("afterNavigation");
  __rf.phase = "zoomPan";
  elements.imageZoom.click();
  await sleep(300);
  for (let i = 0; i < 60; i++) {
    if (i % 10 === 0) elements.lightboxZoomIn.click();
    elements.lightboxView.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: i % 2 ? 20 : -20,
        ctrlKey: true,
        clientX: 600,
        clientY: 400,
        bubbles: true,
        cancelable: true,
      }),
    );
    elements.lightboxDialog.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: i % 2 ? "ArrowLeft" : "ArrowRight",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await new Promise(requestAnimationFrame);
  }
  closeDialog(elements.lightboxDialog);
  await until(() => !elements.lightboxDialog.open);
  for (const phase of ["nearbyWarm", "nearbyProgressive"]) {
    // At the fixture's upper edge, four neighbours have neither history nor disk thumbnails.
    if (phase === "nearbyProgressive") await navigate(state.history.length - 1);
    __rf.phase = phase;
    const nearbyStart = performance.now();
    openNearby();
    await until(() => {
      const tiles = [...elements.nearbyGrid.querySelectorAll("[data-state]")];
      return (
        tiles.length === 9 &&
        tiles.every(
          (tile) =>
            tile.dataset.state === "ready" &&
            tile.querySelector("img")?.complete &&
            tile.querySelector("img").naturalWidth > 0,
        )
      );
    }, 45000);
    await paint();
    observations[phase] = [performance.now() - nearbyStart];
    await sleep(1000);
    closeDialog(elements.nearbyDialog);
    await until(() => !elements.nearbyDialog.open);
  }
  checkpoint("afterNearby");
  __rf.phase = "longNavigation";
  const end = performance.now() + Number(config.longMs);
  let navigations = 0;
  while (performance.now() < end) {
    await navigate((navigations + 30) % Math.min(state.history.length, 180));
    navigations++;
    await paint();
    if (navigations % 20 === 0) checkpoint(`navigation-${navigations}`);
  }
  observations.longNavigations = navigations;
  checkpoint("beforeIdle");
  __rf.phase = "idle";
  await sleep(Number(config.longMs) ? 15000 : 1000);
  checkpoint("afterIdle");
  releaseAllBlobs();
  __rf.phase = "released";
  await sleep(1000);
  checkpoint("afterRelease");
  if (blobs.size !== 0) throw Error("Blob cache did not clear");
  if (__rf.urls.size > 2) throw Error(`Unexpected live URLs after clear: ${__rf.urls.size}`);
  await invoke("performance_report", {
    payload: {
      startup,
      observations,
      resources,
      ipc: __rf.ipc,
      frames: __rf.frames,
      spans: __rf.spans,
      userAgent: navigator.userAgent,
      count: state.history.length,
      done: true,
    },
  });
}
run().catch(async (error) => {
  await invoke("performance_report", {
    payload: {
      error: String(error),
      stack: error.stack,
      ipc: __rf.ipc,
      spans: __rf.spans,
      resources,
      body: document.body.innerText.slice(-4000),
    },
  });
});
