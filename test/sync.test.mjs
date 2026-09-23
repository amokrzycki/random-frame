import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const unpaired = { paired: false, state: "unpaired", lastSuccessRevision: null, dirty: true, lastErrorCategory: null };
const paired = { paired: true, state: "idle", lastSuccessRevision: 1, dirty: false, lastErrorCategory: null };

test("Sync dialog handles pairing, status, manual sync, leave, and recovery-key lifecycle", async (t) => {
  const document = new FakeDocument(ids);
  const original = new Map(
    ["document", "navigator"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const copied = [];
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
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
  const calls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        calls.push({ command, args });
        if (command === "get_sync_status") return structuredClone(current);
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
        throw new Error(`Unexpected command: ${command}`);
      },
    },
  };
  t.after(() => delete globalThis.window);
  const { bindSyncDialogEvents, runStartupSync } = await import("../dist/test-client/sync-dialog.js");
  bindSyncDialogEvents();

  get("sync-button").click();
  await flush();
  assert.equal(get("sync-dialog").open, true);
  assert.equal(get("sync-unpaired").hidden, false);
  assert.equal(get("sync-enable").hidden, false);
  assert.equal(get("sync-show-join").hidden, false);

  fail = { command: "create_sync", error: { category: "invalid_endpoint" } };
  get("sync-enable").click();
  await flush();
  assert.match(get("sync-error").textContent, /not configured/);
  assert.equal(get("sync-unpaired").hidden, false);
  fail = null;
  get("sync-enable").click();
  await flush();
  assert.equal(get("sync-recovery-key").textContent, "test-recovery-key");
  assert.equal(get("sync-recovery").hidden, false);
  assert.equal("recoveryKey" in current, false);
  get("sync-copy-key").click();
  await flush();
  assert.deepEqual(copied, ["test-recovery-key"]);
  get("sync-close").click();
  assert.equal(get("sync-recovery-key").textContent, "");
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-recovery").hidden, true);
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-status").textContent, "Synced");

  current.dirty = true;
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-status").textContent, "Local changes waiting to sync");
  assert.equal(get("sync-dirty").textContent, "Local changes pending: yes");
  current.state = "syncing";
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-status").textContent, "Syncing…");
  current.state = "offline";
  current.lastErrorCategory = "offline";
  get("sync-button").click();
  await flush();
  assert.match(get("sync-status").textContent, /Offline/);
  for (const [category, expected] of [
    ["rollback_detected", /older/],
    ["secure_storage", /Secure credential/],
  ]) {
    current.state = "error";
    current.lastErrorCategory = category;
    get("sync-button").click();
    await flush();
    assert.match(get("sync-status").textContent, expected);
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
  assert.ok(calls.filter(({ command }) => command === "get_sync_status").length > 1);

  fail = {
    command: "sync_now",
    error: { category: "server_rollback_detected", details: { local_revision: 9, remote_revision: 3 } },
  };
  get("sync-now").click();
  await flush();
  assert.match(get("sync-error").textContent, /older/);
  assert.doesNotMatch(get("sync-error").textContent, /9|3/);
  fail = null;

  get("sync-leave").click();
  assert.equal(get("sync-leave-confirm").hidden, false);
  fail = { command: "leave_sync", error: { category: "secure_storage" } };
  get("sync-leave-confirm-button").click();
  await flush();
  assert.equal(get("sync-paired").hidden, true);
  assert.equal(get("sync-leave-confirm").hidden, false);
  assert.match(get("sync-error").textContent, /Secure credential/);
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
  assert.match(get("sync-error").textContent, /not valid/);
  assert.doesNotMatch(get("sync-error").textContent, /private/);
  fail = null;
  get("sync-join-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-recovery-input").value, "");

  await runStartupSync();
  assert.equal(calls.at(-1).command, "get_sync_status");
});
