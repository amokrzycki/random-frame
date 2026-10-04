import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const unpaired = { paired: false, state: "unpaired", lastSuccessRevision: null, dirty: true, lastErrorCategory: null };
const paired = { paired: true, state: "idle", lastSuccessRevision: 1, dirty: false, lastErrorCategory: null };

test("Sync dialog handles pairing, status, manual sync, leave, and recovery-key lifecycle", async (t) => {
  const document = new FakeDocument(ids);
  const original = new Map(
    ["document", "localStorage", "navigator"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const copied = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new FakeStorage() });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { clipboard: { writeText: async (text) => copied.push(text) } },
  });
  t.after(() => {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const get = (id) => document.querySelector(`#${id}`);
  let current = structuredClone(unpaired);
  let fail = null;
  let pending = null;
  let statusFails = false;
  const calls = [];
  globalThis.window = {
    setTimeout: () => 0,
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === "complete_state_imports") return null;
        if (command === "get_user_preferences" || command === "set_user_preferences")
          return { theme: null, historyPageSize: null };
        if (command === "import_session_history") return window.__TAURI_INTERNALS__.invoke("get_history");
        calls.push({ command, args });
        if (command === "get_sync_status") {
          if (statusFails) throw { category: "timeout" };
          return structuredClone(current);
        }
        if (fail && command === fail.command) throw fail.error;
        if (command === "create_sync") {
          current = structuredClone(paired);
          return { recoveryKey: "test-recovery-key", status: structuredClone(current), localPairingError: null };
        }
        if (command === "join_sync") {
          current = structuredClone(paired);
          return structuredClone(current);
        }
        if (command === "sync_now") {
          if (pending) return pending;
          return structuredClone(current);
        }
        if (command === "leave_sync") {
          current = structuredClone(unpaired);
          return structuredClone(current);
        }
        if (command === "startup_sync") return structuredClone(current);
        if (command === "get_history") return { history: [], index: -1 };
        if (command === "get_favorites") return [];
        throw new Error(`Unexpected command: ${command}`);
      },
    },
  };
  t.after(() => delete globalThis.window);
  const { bindSyncDialogEvents, runStartupSync } = await import("../dist/test-client/sync-dialog.js");
  bindSyncDialogEvents();
  await runStartupSync();
  assert.equal(document.body.children.length, 0);

  get("sync-button").click();
  await flush();
  assert.equal(get("sync-dialog").open, true);
  assert.equal(get("sync-unpaired").hidden, false);
  assert.equal(get("sync-enable").hidden, false);
  assert.equal(get("sync-show-join").hidden, false);

  fail = { command: "create_sync", error: { category: "invalid_endpoint" } };
  get("sync-enable").click();
  await flush();
  assert.match(get("sync-error-message").textContent, /no server is set up/);
  assert.equal(get("sync-unpaired").hidden, false);
  // Nothing to retry until the server is configured, and the message is not repeated in the status line.
  assert.equal(get("sync-retry").hidden, true);
  assert.equal(get("sync-status").hidden, true);
  fail = { command: "create_sync", error: { category: "offline" } };
  get("sync-enable").click();
  await flush();
  assert.match(get("sync-error-message").textContent, /offline/);
  assert.equal(get("sync-retry").hidden, false);
  fail = null;
  get("sync-retry").click();
  await flush();
  assert.equal(get("sync-error").hidden, true);
  // The status line stays out of the recovery-key screen.
  assert.equal(get("sync-status").hidden, true);
  assert.equal(get("sync-recovery-key").textContent, "test-recovery-key");
  assert.equal(get("sync-recovery").hidden, false);
  assert.equal(get("sync-close").disabled, true);
  assert.equal("recoveryKey" in current, false);
  get("sync-copy-key").click();
  await flush();
  assert.deepEqual(copied, ["test-recovery-key"]);
  get("sync-close").click();
  assert.equal(get("sync-dialog").open, true);
  get("sync-key-saved").checked = true;
  get("sync-key-saved").dispatchEvent(new Event("change"));
  assert.equal(get("sync-close").disabled, false);
  get("sync-close").click();
  assert.equal(get("sync-recovery-key").textContent, "");
  assert.equal(get("sync-key-saved").checked, false);
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-recovery").hidden, true);
  assert.equal(get("sync-paired").hidden, false);
  assert.match(get("sync-status").textContent, /^Up to date/);

  current.dirty = true;
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-status").textContent, "Changes waiting to sync");
  assert.equal(get("sync-dirty").textContent, "");
  current.state = "syncing";
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-status").textContent, "Syncing…");
  current.state = "offline";
  current.lastErrorCategory = "offline";
  get("sync-button").click();
  await flush();
  assert.match(get("sync-status").textContent, /offline/);
  for (const [category, expected] of [
    ["rollback_detected", /older/],
    ["secure_storage", /secure storage/],
  ]) {
    current.state = "error";
    current.lastErrorCategory = category;
    get("sync-button").click();
    await flush();
    assert.match(get("sync-status").textContent, expected);
    assert.equal(get("tools-menu-button").dataset.sync, "attention");
  }

  current = structuredClone(paired);
  pending = new Promise((resolve) => {
    get("sync-now").resolve = resolve;
  });
  get("sync-now").click();
  assert.equal(get("sync-now").disabled, true);
  assert.equal(get("sync-status").textContent, "Syncing…");
  get("sync-now").resolve(structuredClone(current));
  pending = null;
  await flush();
  assert.equal(get("sync-now").disabled, false);
  assert.equal(get("tools-menu-button").dataset.sync, undefined);
  assert.ok(calls.filter(({ command }) => command === "get_sync_status").length > 1);

  fail = {
    command: "sync_now",
    error: { category: "server_rollback_detected", details: { local_revision: 9, remote_revision: 3 } },
  };
  get("sync-now").click();
  await flush();
  assert.match(get("sync-error-message").textContent, /older/);
  assert.doesNotMatch(get("sync-error-message").textContent, /9|3/);
  fail = null;

  get("sync-leave").click();
  assert.equal(get("sync-leave-confirm").hidden, false);
  assert.equal(document.activeElement, get("sync-leave-cancel"));
  fail = { command: "leave_sync", error: { category: "secure_storage" } };
  get("sync-leave-confirm-button").click();
  await flush();
  assert.equal(get("sync-paired").hidden, true);
  assert.equal(get("sync-leave-confirm").hidden, false);
  assert.match(get("sync-error-message").textContent, /secure storage/);
  fail = null;
  get("sync-leave-confirm-button").click();
  await flush();
  assert.equal(get("sync-unpaired").hidden, false);

  get("sync-show-join").click();
  assert.equal(document.activeElement, get("sync-recovery-input"));
  get("sync-join-cancel").click();
  assert.equal(get("sync-join-form").hidden, true);
  assert.equal(document.activeElement, get("sync-show-join"));
  get("sync-show-join").click();
  fail = { command: "join_sync", error: { category: "invalid_recovery_key", details: "private" } };
  get("sync-recovery-input").value = "bad";
  get("sync-join-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.match(get("sync-error-message").textContent, /not valid/);
  assert.doesNotMatch(get("sync-error-message").textContent, /private/);
  fail = null;
  get("sync-join-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-recovery-input").value, "");

  const { state } = await import("../dist/test-client/viewer-state.js");
  state.loading = false;
  state.history = [{ source: "prntsc", id: "abc123", sourcePageUrl: "https://prnt.sc/abc123", viewedAt: 1 }];
  state.index = 0;
  get("sync-now").click();
  await flush();
  assert.equal(get("frame-count-total").textContent, "0");
  assert.equal(get("favorite-button").disabled, true);

  // The earlier key copy raised its own toast; startup sync must not add another.
  const toastCount = () => document.body.children[0]?.children.length ?? 0;
  const toastsBefore = toastCount();
  await runStartupSync();
  assert.equal(calls.at(-1).command, "get_sync_status");
  assert.equal(toastCount(), toastsBefore);
  fail = { command: "startup_sync", error: { category: "offline" } };
  await runStartupSync();
  assert.equal(toastCount(), toastsBefore);

  // A failed status check is an error with a retry, never a status line stuck on "Checking".
  statusFails = true;
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-error").hidden, false);
  assert.equal(get("sync-status").hidden, true);
  assert.match(get("sync-error-message").textContent, /took too long/);
  assert.equal(get("sync-retry").hidden, false);
  statusFails = false;
  get("sync-retry").click();
  await flush();
  assert.equal(get("sync-error").hidden, true);
  assert.doesNotMatch(get("sync-status").textContent, /Checking/);
});
