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
