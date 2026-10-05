import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("preference refresh cannot overwrite a newer local choice", async (t) => {
  const originals = new Map(
    ["document", "localStorage", "window", "CustomEvent"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const document = new FakeDocument(ids);
  const storage = new FakeStorage();
  let resolveRefresh;
  const pendingRefresh = new Promise((resolve) => {
    resolveRefresh = resolve;
  });
  Object.assign(globalThis, {
    document,
    localStorage: storage,
    CustomEvent: class extends Event {
      constructor(type, options) {
        super(type);
        this.detail = options.detail;
      }
    },
    window: {
      __TAURI_INTERNALS__: {
        invoke: (command) =>
          command === "get_user_preferences"
            ? pendingRefresh
            : Promise.resolve({ theme: "dark", historyPageSize: null }),
      },
    },
  });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const prefs = await import(`../dist/test-client/user-preferences.js?test=${Date.now()}`);
  const refresh = prefs.refreshUserPreferences();
  await prefs.updateUserPreferences({ theme: "dark" });
  resolveRefresh({ theme: "light", historyPageSize: null });
  await refresh;
  assert.equal(storage.getItem("random-frame-theme"), "dark");
});

test("authoritative absent preferences clear caches and restore presentation defaults", async (t) => {
  const names = ["document", "localStorage", "window", "CustomEvent", "matchMedia"];
  const originals = new Map(names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const document = new FakeDocument(ids);
  const storage = new FakeStorage();
  storage.setItem("random-frame-theme", "dark");
  storage.setItem("random-frame-history-page-size", "100");
  const system = new EventTarget();
  system.matches = false;
  const commands = [];
  Object.assign(globalThis, {
    document,
    localStorage: storage,
    matchMedia: () => system,
    CustomEvent: class extends Event {
      constructor(type, options) {
        super(type);
        this.detail = options.detail;
      }
    },
    window: {
      __TAURI_INTERNALS__: {
        invoke: async (command) => {
          commands.push(command);
          return { theme: null, historyPageSize: null };
        },
      },
    },
  });
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const prefs = await import(`../dist/test-client/user-preferences.js?defaults=${Date.now()}`);
  const { state } = await import("../dist/test-client/viewer-state.js");
  await import("../dist/test-client/theme.js");
  assert.equal(state.pageSize, 100);
  assert.equal(document.documentElement.dataset.theme, "dark");
  await prefs.refreshUserPreferences();
  assert.equal(storage.getItem("random-frame-theme"), null);
  assert.equal(storage.getItem("random-frame-history-page-size"), null);
  assert.equal(state.pageSize, 25);
  assert.equal(document.documentElement.dataset.theme, "light");
  system.matches = true;
  system.dispatchEvent(new Event("change"));
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.deepEqual(commands, ["get_user_preferences"], "presentation defaults must not create synced registers");
});
