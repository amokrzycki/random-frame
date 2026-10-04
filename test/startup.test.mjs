import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const unpairedStatus = {
  supported: true,
  paired: false,
  state: "unpaired",
  lastSuccessAt: null,
  lastSuccessRevision: null,
  dirty: false,
  lastErrorCategory: null,
  snapshotSchemaVersion: 1,
  thisDeviceId: null,
  devices: [],
};
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("a failed startup load says so and Try again re-runs the load", async (t) => {
  const document = new FakeDocument(ids);
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  window.setTimeout = () => 0;
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  Object.assign(globalThis, {
    document,
    localStorage,
    performance: { getEntriesByType: () => [{ type: "back_forward" }] },
    sessionStorage: new FakeStorage(),
    window,
  });
  const originalError = console.error;
  console.error = () => {
    // The unknown-error path logs; keep test output quiet.
  };
  let failing = true;
  const invocations = [];
  window.__TAURI_INTERNALS__ = {
    async invoke(command) {
      if (command === "complete_state_imports") return null;
      if (command === "get_user_preferences" || command === "set_user_preferences")
        return { theme: null, historyPageSize: null };
      if (command === "import_session_history") return window.__TAURI_INTERNALS__.invoke("get_history");
      invocations.push(command);
      if (command === "get_history") {
        if (failing) throw { kind: "persistence" };
        return { history: [], index: -1 };
      }
      if (command === "get_favorites") return [];
      if (command === "startup_sync") return unpairedStatus;
      if (command === "get_sync_status") return unpairedStatus;
      return null;
    },
  };
  t.after(() => {
    console.error = originalError;
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  await import(`../dist/test-client/app.js?test=${Date.now()}`);
  await flush();
  const get = (id) => document.querySelector(`#${id}`);
  assert.equal(get("error-state").hidden, false);
  assert.equal(get("error-title").textContent, "Your history couldn’t be loaded.");
  assert.doesNotMatch(get("error-message").textContent, /source|Prnt\.sc/);
  assert.equal(get("retry-button").textContent, "Try again");

  assert.equal(get("draw-button").getAttribute("aria-disabled"), "true");
  get("draw-button").click();
  await flush();
  assert.equal(invocations.includes("get_random_frame"), false);

  failing = false;
  get("retry-button").click();
  await flush();
  await flush();
  assert.equal(get("error-state").hidden, true);
  assert.equal(get("empty-state").hidden, false);
  assert.equal(get("draw-button").getAttribute("aria-disabled"), "false");
  assert.equal(get("draw-button").getAttribute("data-invite"), "");
  assert.equal(invocations.filter((command) => command === "startup_sync").length, 1);
});
