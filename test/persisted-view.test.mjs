import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { FakeDocument, FakeStorage, ids, libraryOf } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const item = (id) => ({ source: "prntsc", id, sourcePageUrl: `https://prnt.sc/${id}`, viewedAt: 1 });
const document = new FakeDocument(ids);
const get = (id) => document.querySelector(`#${id}`);
const originals = new Map(
  ["document", "localStorage", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
const listeners = [];
const holds = new Map();
let backend;
let calls = [];
let viewer;
let stage;
let loader;
let sync;
let actions;
let cache;
let refreshed;

// Capture the native result when the command runs, then explicitly choose when IPC returns it.
function hold(command) {
  const entered = deferred();
  const released = deferred();
  holds.set(command, { entered, released });
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    fail: () => released.reject(new Error("Load failed")),
  };
}

before(async () => {
  Object.assign(globalThis, {
    document,
    localStorage: new FakeStorage(),
    window: {
      setTimeout: () => 0,
      addEventListener: () => undefined,
      __TAURI_INTERNALS__: {
        transformCallback: (callback) => {
          listeners.push(callback);
          return listeners.length;
        },
        async invoke(command, args) {
          calls.push(command);
          let result;
          if (command === "get_history") {
            if (backend.failHistory) throw new Error("Read failed");
            result = backend.history;
          } else if (command === "get_saved_library") result = libraryOf(backend.favorites);
          else if (command === "get_user_preferences") result = backend.preferences;
          else if (command === "set_user_preferences") result = Object.assign(backend.preferences, args.preferences);
          else if (["get_sync_status", "startup_sync", "sync_now"].includes(command)) result = backend.status;
          else if (command === "get_sync_recovery_key") result = "rf1-test-key";
          else if (command === "plugin:event|listen") result = 1;
          else if (command === "get_frame_by_id") result = { ...item(args.id), mimeType: "image/png" };
          else if (command === "get_random_frame") result = { ...item("ccc333"), mimeType: "image/png" };
          else if (command === "get_frame_image") result = new Uint8Array([1]).buffer;
          else if (command === "select_history_item") {
            backend.history.index = args.index;
            result = backend.history;
          } else if (command === "record_history_item") {
            backend.history.history.push(args.item);
            backend.history.index = backend.history.history.length - 1;
            result = backend.history;
          } else if (command === "save_frame") {
            const index = backend.favorites.findIndex(({ id }) => id === args.item.id);
            if (index < 0) backend.favorites.push(args.item);
            result = libraryOf(backend.favorites);
          } else throw new Error(`Unexpected command: ${command}`);
          result = structuredClone(result);
          const gate = holds.get(command);
          if (gate) {
            holds.delete(command);
            gate.entered.resolve();
            await gate.released.promise;
          }
          return result;
        },
      },
    },
  });
  viewer = await import("../dist/test-client/viewer-state.js");
  stage = await import("../dist/test-client/stage.js");
  loader = await import("../dist/test-client/frame-loader.js");
  sync = await import("../dist/test-client/sync-dialog.js");
  actions = await import("../dist/test-client/frame-actions.js");
  cache = await import("../dist/test-client/frame-cache.js");
  stage.bindStageEvents();
  sync.bindSyncDialogEvents();
  document.addEventListener("persisted-view-refreshed", () => refreshed++);
});

beforeEach(() => {
  calls = [];
  refreshed = 0;
  backend = {
    history: { history: [item("aaa111"), item("bbb222")], index: 0 },
    favorites: [],
    preferences: { theme: null, historyPageSize: null },
    status: {
      supported: true,
      paired: true,
      state: "idle",
      dirty: false,
      lastSuccessAt: null,
      lastSuccessRevision: null,
      lastErrorCategory: null,
      snapshotSchemaVersion: 2,
      thisDeviceId: null,
      devices: [],
      groupState: null,
      membershipState: null,
      masterMemberId: null,
      thisMemberId: null,
      credentialVersion: null,
      keyEpoch: null,
      controlVerifiedAt: null,
      legacySourceId: null,
    },
    failHistory: false,
  };
  viewer.state.loading = false;
  viewer.state.historyLoadFailed = false;
  viewer.state.navigationMode = "history";
  viewer.applyHistory(structuredClone(backend.history));
  viewer.applySavedLibrary(libraryOf());
  cache.releaseAllBlobs();
  get("image-zoom").hidden = true;
  get("sync-dialog").open = false;
  stage.showFrame("prntsc", "aaa111", new Blob(["a"]), URL.createObjectURL(new Blob(["a"])));
  stage.showFrame("prntsc", "bbb222", new Blob(["b"]), URL.createObjectURL(new Blob(["b"])));
  stage.swapImage(cache.blobs.get("prntsc:aaa111").url, "aaa111");
  stage.syncControls();
});

after(() => {
  cache.releaseAllBlobs();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

function assertShown(id) {
  assert.equal(viewer.state.history[viewer.state.index]?.id, id);
  assert.match(get("image").alt, new RegExp(id));
  assert.equal(get("image-id-value").textContent, id);
  assert.equal(get("source-link").href, `https://prnt.sc/${id}`);
}

for (const trigger of ["foreground", "event", "manual"]) {
  test(`${trigger} sync during a draw refreshes saved views after loading finishes`, async () => {
    const draw = hold("get_random_frame");
    const loading = loader.loadRandom();
    await draw.entered;
    backend.favorites = [{ ...item("bbb222"), addedAt: 2 }];
    backend.preferences = { theme: "dark", historyPageSize: 50 };
    let completion;
    if (trigger === "foreground") completion = sync.runStartupSync();
    else if (trigger === "event") listeners.at(-1)({ payload: null });
    else {
      get("sync-button").click();
      await flush();
      get("sync-now").click();
    }
    await flush();
    assert.equal(viewer.state.loading, true);
    assert.equal(refreshed, 0);
    draw.release();
    await loading;
    await completion;
    await flush();
    assertShown("ccc333");
    assert.equal(viewer.isFavorite(item("bbb222")), true);
    assert.equal(viewer.state.pageSize, 50);
    assert.equal(refreshed, 1);
  });
}

test("busy refresh requests coalesce and complete after cancellation", async () => {
  const draw = hold("get_random_frame");
  const loading = loader.loadRandom();
  await draw.entered;
  backend.favorites = [{ ...item("bbb222"), addedAt: 2 }];
  const requests = [viewer.refreshPersistedView(), viewer.refreshPersistedView(), viewer.refreshPersistedView()];
  await flush();
  const refreshedWhileBusy = refreshed;
  assert.equal(loader.cancelDraw(), true);
  await Promise.all(requests);
  draw.release();
  await loading;
  assert.equal(refreshedWhileBusy, 0);
  assertShown("aaa111");
  assert.equal(viewer.isFavorite(item("bbb222")), true);
  assert.equal(calls.filter((command) => command === "get_history").length, 1);
  assert.equal(refreshed, 1);
});

for (const operation of ["navigation", "draw"]) {
  test(`a persisted response overtaken by ${operation} preserves the new frame and valid remote updates`, async () => {
    backend.favorites = [{ ...item("bbb222"), addedAt: 2 }];
    backend.preferences = { theme: "dark", historyPageSize: 50 };
    const read = hold("get_history");
    const refresh = viewer.refreshPersistedView();
    await read.entered;
    if (operation === "navigation") await loader.goTo(1);
    else await loader.loadRandom();
    read.release();
    await refresh;
    assertShown(operation === "navigation" ? "bbb222" : "ccc333");
    assert.equal(viewer.isFavorite(item("bbb222")), true);
    assert.equal(viewer.state.pageSize, 50);
    assert.equal(get("favorite-button").hasAttribute("data-saved"), operation === "navigation");
  });
}

test("a local favorite change overtakes a refresh without losing remote history or preferences", async () => {
  backend.history.history.unshift(item("remote"));
  backend.preferences = { theme: "dark", historyPageSize: 50 };
  const read = hold("get_saved_library");
  const refresh = viewer.refreshPersistedView();
  await read.entered;
  await actions.toggleCurrentFavorite();
  read.release();
  await refresh;
  assertShown("aaa111");
  assert.equal(viewer.isFavorite(item("aaa111")), true);
  assert.equal(get("favorite-button").hasAttribute("data-saved"), true);
  assert.equal(viewer.state.history[0].id, "remote");
  assert.equal(viewer.state.pageSize, 50);
});

test("failed refresh stops and an explicit retry succeeds", async () => {
  backend.failHistory = true;
  await assert.rejects(viewer.refreshPersistedView(), /Read failed/);
  await flush();
  assert.equal(calls.filter((command) => command === "get_history").length, 1);
  assert.equal(refreshed, 0);
  assertShown("aaa111");
  backend.failHistory = false;
  await viewer.refreshPersistedView();
  assert.equal(refreshed, 1);
});

test("a response during navigation applies valid remote domains and defers history until selection commits", async () => {
  backend.favorites = [{ ...item("bbb222"), addedAt: 2 }];
  backend.preferences = { theme: "dark", historyPageSize: 50 };
  const read = hold("get_history");
  const refresh = viewer.refreshPersistedView();
  await read.entered;
  const select = hold("select_history_item");
  const navigating = loader.goTo(1);
  await select.entered;
  read.release();
  await flush();
  assert.equal(viewer.state.loading, true);
  assert.equal(viewer.isFavorite(item("bbb222")), true);
  assert.equal(viewer.state.pageSize, 50);
  select.release();
  await navigating;
  await refresh;
  assertShown("bbb222");
  assert.equal(get("favorite-button").hasAttribute("data-saved"), true);
});

for (const operation of ["navigation", "draw"]) {
  test(`deferred refresh completes after a failed ${operation} without retrying the load`, async () => {
    if (operation === "navigation") cache.blobs.delete("prntsc:bbb222");
    const frame = hold(operation === "navigation" ? "get_frame_by_id" : "get_random_frame");
    const loading = operation === "navigation" ? loader.goTo(1) : loader.loadRandom();
    await frame.entered;
    backend.favorites = [{ ...item("aaa111"), addedAt: 2 }];
    const refresh = viewer.refreshPersistedView();
    frame.fail();
    await loading;
    await refresh;
    assertShown("aaa111");
    assert.equal(viewer.isFavorite(item("aaa111")), true);
    assert.equal(stage.getViewState(), "error");
    assert.equal(calls.filter((command) => command === "get_history").length, 1);
  });
}

test("requests arriving during a read coalesce into one subsequent read of the latest remote state", async () => {
  const read = hold("get_history");
  const refresh = viewer.refreshPersistedView();
  await read.entered;
  backend.history.history.unshift(item("remote"));
  backend.favorites = [{ ...item("aaa111"), addedAt: 2 }];
  const requests = [viewer.refreshPersistedView(), viewer.refreshPersistedView(), viewer.refreshPersistedView()];
  read.release();
  await Promise.all([refresh, ...requests]);
  assertShown("aaa111");
  assert.equal(viewer.state.index, 1);
  assert.equal(viewer.isFavorite(item("aaa111")), true);
  assert.equal(calls.filter((command) => command === "get_history").length, 2);
});

test("identity-preserving refresh retains favorites navigation when history positions shift", async () => {
  backend.favorites = ["bbb222", "aaa111"].map((id) => ({ ...item(id), addedAt: 2 }));
  viewer.applySavedLibrary(libraryOf(backend.favorites));
  viewer.state.navigationMode = "favourites";
  backend.history.history.unshift(item("remote"));
  await viewer.refreshPersistedView();
  assertShown("aaa111");
  assert.equal(viewer.state.index, 1);
  assert.equal(viewer.state.navigationMode, "favourites");
  assert.equal(get("frame-count-current").textContent, "1");
  assert.equal(get("frame-count-total").textContent, "2");
});

test("a remote removal keeps the existing unselected view contract and disables frame actions", async () => {
  backend.history.history.shift();
  await viewer.refreshPersistedView();
  assert.equal(viewer.state.index, -1);
  assert.equal(get("favorite-button").disabled, true);
  assert.equal(get("copy-link-button").disabled, true);
  assert.equal(get("save-button").disabled, true);
  assert.equal(get("frame-count-current").textContent, "0");
  assert.match(get("image").alt, /aaa111/);
});

test("repeated local favorite interactions do not starve remote history or preference updates", async () => {
  const first = hold("get_saved_library");
  const refresh = viewer.refreshPersistedView();
  await first.entered;
  await actions.toggleCurrentFavorite();
  backend.history.history.unshift(item("remote"));
  backend.preferences = { theme: "dark", historyPageSize: 50 };
  const second = hold("get_saved_library");
  first.release();
  await second.entered;
  await viewer.mutateSavedLibrary(async () => {
    backend.favorites = [];
    viewer.applySavedLibrary(libraryOf());
  });
  const third = hold("get_saved_library");
  second.release();
  await third.entered;
  assertShown("aaa111");
  assert.equal(viewer.state.history[0].id, "remote");
  assert.equal(viewer.state.pageSize, 50);
  assert.equal(viewer.isFavorite(item("aaa111")), false);
  third.release();
  await refresh;
  assert.equal(calls.filter((command) => command === "get_history").length, 3);
});

test("manual refresh failure retains its visible retry and does not repeat sync", async () => {
  get("sync-button").click();
  await flush();
  backend.failHistory = true;
  get("sync-now").click();
  await flush();
  assert.equal(get("sync-error").hidden, false);
  assert.match(get("sync-error-message").textContent, /saved data could not be reloaded/);
  assert.equal(get("sync-retry").hidden, false);
  assert.equal(calls.filter((command) => command === "get_history").length, 1);
  backend.failHistory = false;
  get("sync-retry").click();
  await flush();
  assert.equal(get("sync-error").hidden, true);
  assert.equal(calls.filter((command) => command === "sync_now").length, 1);
  assertShown("aaa111");
});

for (const followUpFails of [false, true]) {
  test(`a newer request survives a failed in-flight read${followUpFails ? " and stops after its own failure" : ""}`, async () => {
    const read = hold("get_history");
    const older = viewer.refreshPersistedView();
    await read.entered;
    backend.favorites = [{ ...item("aaa111"), addedAt: 2 }];
    backend.failHistory = followUpFails;
    const newer = viewer.refreshPersistedView();
    read.fail();
    const results = await Promise.allSettled([older, newer]);
    await flush();
    assert.equal(calls.filter((command) => command === "get_history").length, 2);
    assert.deepEqual(
      results.map(({ status }) => status),
      followUpFails ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
    );
    assert.equal(viewer.isFavorite(item("aaa111")), !followUpFails);
    assertShown("aaa111");
  });
}

test("a sync event during a read-only Sync dialog action still refreshes persisted views", async () => {
  get("sync-button").click();
  await flush();
  const key = hold("get_sync_recovery_key");
  get("sync-show-key").click();
  await key.entered;
  backend.favorites = [{ ...item("aaa111"), addedAt: 2 }];
  listeners.at(-1)({ payload: null });
  await flush();
  key.release();
  await flush();
  assert.equal(viewer.isFavorite(item("aaa111")), true);
  assertShown("aaa111");
});
