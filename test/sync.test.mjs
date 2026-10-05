import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const NOW = Date.now();
const KEY = "rf1-secret-recovery-key";

const unpaired = {
  supported: true,
  paired: false,
  state: "unpaired",
  lastSuccessAt: null,
  lastSuccessRevision: null,
  dirty: true,
  lastErrorCategory: null,
  snapshotSchemaVersion: 1,
  thisDeviceId: "aabbccdd",
  devices: [],
};
const thisDevice = {
  deviceId: "aabbccdd",
  displayName: "Studio laptop",
  platform: "linux",
  joinedAtMs: NOW - 86_400_000 * 9,
  lastSyncedAtMs: NOW - 60_000,
  thisDevice: true,
};
const phone = {
  deviceId: "11223344",
  displayName: "Pocket phone",
  platform: "android",
  joinedAtMs: NOW - 86_400_000 * 3,
  lastSyncedAtMs: NOW - 86_400_000,
  thisDevice: false,
};
const paired = {
  ...unpaired,
  paired: true,
  state: "idle",
  lastSuccessAt: NOW - 60_000,
  lastSuccessRevision: 4,
  dirty: false,
  snapshotSchemaVersion: 2,
  devices: [phone, thisDevice],
};

const document = new FakeDocument(ids);
const localStorage = new FakeStorage();
const names = ["document", "localStorage", "navigator", "window"];
const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const get = (id) => document.querySelector(`#${id}`);
const clipboard = { copied: [], fails: false };
const listeners = [];
let backend;
let calls;
let sync;
let stateModule;

function resetBackend() {
  backend = {
    current: structuredClone(unpaired),
    fail: null,
    statusFails: false,
    partial: null,
    activityTotal: 5,
    summary: {
      history: 3,
      historyRemovals: 0,
      favorites: 0,
      favoriteRemovals: 0,
      activityRemovals: 0,
      meaningful: true,
    },
    summaryFails: false,
    history: [{ source: "prntsc", id: "abc123", sourcePageUrl: "https://prnt.sc/abc123", viewedAt: 1 }],
    favorites: [],
    onJoin: null,
    onSyncNow: null,
  };
  calls = [];
  clipboard.copied = [];
  clipboard.fails = false;
}

before(async () => {
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        writeText: async (text) => {
          if (clipboard.fails) throw new Error("denied");
          clipboard.copied.push(text);
        },
      },
    },
  });
  // The fake DOM does not read the markup's hidden attributes.
  for (const id of [
    "sync-join-form",
    "sync-join-fresh",
    "sync-join-local",
    "sync-join-merge-deletions",
    "sync-leave-confirm",
    "sync-recovery",
    "sync-error",
    "sync-name-error",
  ])
    get(id).hidden = true;
  get("sync-join-restore").checked = false;
  resetBackend();
  globalThis.window = {
    setTimeout: () => 0,
    __TAURI_INTERNALS__: {
      transformCallback: (callback) => {
        listeners.push(callback);
        return `cb-${listeners.length}`;
      },
      async invoke(command, args) {
        if (command === "complete_state_imports") return null;
        if (command === "get_user_preferences" || command === "set_user_preferences")
          return { theme: null, historyPageSize: null };
        if (command === "import_session_history") return { history: backend.history, index: -1 };
        calls.push({ command, args });
        if (command === "plugin:event|listen") return 1;
        if (command === "get_sync_status") {
          if (backend.statusFails) throw { category: "timeout" };
          return structuredClone(backend.current);
        }
        if (command === "join_sync") backend.onJoin?.();
        if (backend.fail && command === backend.fail.command) throw backend.fail.error;
        if (command === "create_sync") {
          if (!backend.partial) backend.current = structuredClone(paired);
          return {
            recoveryKey: KEY,
            status: structuredClone(backend.current),
            localPairingError: backend.partial,
          };
        }
        if (command === "get_sync_join_summary") {
          if (backend.summaryFails) throw { category: "persistence" };
          return structuredClone(backend.summary);
        }
        if (command === "join_sync") {
          backend.current = structuredClone(paired);
          return structuredClone(backend.current);
        }
        if (command === "sync_now") {
          backend.onSyncNow?.();
          return structuredClone(backend.current);
        }
        if (command === "leave_sync") {
          backend.current = { ...structuredClone(unpaired), dirty: false };
          return structuredClone(backend.current);
        }
        if (command === "startup_sync") return structuredClone(backend.current);
        if (command === "set_sync_device_name") {
          const self = backend.current.devices.find((device) => device.thisDevice);
          if (self) self.displayName = args.name;
          backend.current.dirty = true;
          return null;
        }
        if (command === "get_sync_recovery_key") return KEY;
        if (command === "get_history") return { history: structuredClone(backend.history), index: -1 };
        if (command === "get_favorites") return structuredClone(backend.favorites);
        if (command === "get_exploration_stats") return { explored: 0, viewable: 0, unavailable: 0, unclassified: 0 };
        if (command === "get_viewing_activity")
          return { viewedTotal: backend.activityTotal, days: [], localViewTimes: [], frameViews: [] };
        throw new Error(`Unexpected command: ${command}`);
      },
    },
  };
  stateModule = await import("../dist/test-client/viewer-state.js");
  stateModule.state.loading = false;
  sync = await import("../dist/test-client/sync-dialog.js");
  const stats = await import("../dist/test-client/stats-dialog.js");
  sync.bindSyncDialogEvents();
  stats.bindStatsDialogEvents();
  await sync.runStartupSync();
});

after(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
});

beforeEach(() => {
  for (const id of ["sync-dialog", "stats-dialog"]) if (get(id).open) get(id).close();
  resetBackend();
});

async function open(status = backend.current) {
  backend.current = structuredClone(status);
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-dialog").open, true);
}

const text = (id) => get(id).textContent;
const rowTexts = (row) => row.children.map((child) => child.textContent);
const submit = (id) => get(id).dispatchEvent(new Event("submit", { cancelable: true }));
const syncCalls = (command) => calls.filter((call) => call.command === command);

test("create and connect are separate flows that call their own commands", async () => {
  await open(unpaired);
  assert.equal(get("sync-unpaired").hidden, false);
  assert.equal(get("sync-paired").hidden, true);
  assert.equal(get("sync-join-form").hidden, true);
  assert.equal(text("sync-status"), "Sync is off");
  assert.equal(get("sync-last-synced").hidden, true);

  // Connecting needs the explicit key form; nothing runs until it is submitted.
  get("sync-show-join").click();
  assert.equal(get("sync-join-form").hidden, false);
  assert.equal(document.activeElement, get("sync-recovery-input"));
  assert.equal(syncCalls("create_sync").length + syncCalls("join_sync").length, 0);
  await flush();
  choose("restore");
  get("sync-recovery-input").value = `  ${KEY}  `;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(
    syncCalls("join_sync").map((call) => call.args),
    [{ recoveryKey: KEY, mode: "restore" }],
  );
  assert.equal(syncCalls("create_sync").length, 0);
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-recovery-input").value, "");
  assert.equal(document.activeElement, get("sync-now"));

  get("sync-leave").click();
  get("sync-leave-confirm-button").click();
  await flush();
  assert.equal(get("sync-unpaired").hidden, false);
  get("sync-enable").click();
  await flush();
  assert.equal(syncCalls("create_sync").length, 1);
  assert.equal(syncCalls("join_sync").length, 1);
});

test("Start a new Sync shows the recovery key, gates leaving on a confirmation, and clears it on close", async () => {
  await open(unpaired);
  get("sync-enable").click();
  await flush();
  assert.equal(text("sync-recovery-key"), KEY);
  assert.equal(get("sync-recovery").hidden, false);
  assert.equal(get("sync-key-confirm").hidden, false);
  assert.equal(get("sync-status").hidden, true);
  assert.equal(get("sync-error").hidden, true);
  assert.equal(document.activeElement, get("sync-key-saved"));
  assert.equal(get("sync-close").disabled, true);
  assert.equal(get("sync-done").getAttribute("aria-disabled"), "true");
  assert.equal(JSON.stringify(backend.current).includes(KEY), false);

  get("sync-copy-key").click();
  await flush();
  assert.deepEqual(clipboard.copied, [KEY]);
  get("sync-close").click();
  assert.equal(get("sync-dialog").open, true);
  get("sync-done").click();
  assert.equal(document.activeElement, get("sync-key-saved"));
  assert.equal(get("sync-dialog").open, true);

  get("sync-key-saved").checked = true;
  get("sync-key-saved").dispatchEvent(new Event("change"));
  assert.equal(get("sync-done").getAttribute("aria-disabled"), "false");
  get("sync-done").click();
  assert.equal(get("sync-dialog").open, false);
  assert.equal(text("sync-recovery-key"), "");
  assert.equal(get("sync-key-saved").checked, false);
  assert.equal(document.activeElement, get("sync-button"));
});

test("a clipboard failure keeps the key on screen for manual copying", async () => {
  await open(unpaired);
  get("sync-enable").click();
  await flush();
  clipboard.fails = true;
  get("sync-copy-key").click();
  await flush();
  assert.equal(get("sync-error").hidden, false);
  assert.match(text("sync-error-message"), /copy it by hand/);
  assert.equal(get("sync-retry").hidden, true);
  assert.equal(text("sync-recovery-key"), KEY);
});

test("a created Sync whose local pairing failed keeps the key and explains what is left to do", async () => {
  backend.partial = { category: "secure_storage" };
  await open(unpaired);
  get("sync-enable").click();
  await flush();
  assert.equal(text("sync-recovery-key"), KEY);
  assert.equal(get("sync-error").hidden, false);
  assert.match(text("sync-error-message"), /Your Sync was created/);
  assert.match(text("sync-error-message"), /secure storage/);
  assert.match(text("sync-error-message"), /connect this device/);
  assert.equal(get("sync-retry").hidden, true);
  // Still gated: the only copy of the key is on this screen.
  assert.equal(get("sync-close").disabled, true);
  get("sync-key-saved").checked = true;
  get("sync-key-saved").dispatchEvent(new Event("change"));
  get("sync-done").click();
  assert.equal(get("sync-dialog").open, false);
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-unpaired").hidden, false);
  assert.equal(get("sync-error").hidden, true);
});

test("every status has its own headline and the last sync time comes only from the status", async () => {
  const cases = [
    [{ ...unpaired }, "Sync is off"],
    [{ ...paired, state: "syncing" }, "Syncing…"],
    [{ ...paired, dirty: true }, "Changes waiting to sync"],
    [{ ...paired }, "Sync completed"],
    [{ ...paired, state: "offline", lastErrorCategory: "offline" }, "Sync couldn’t connect"],
    [{ ...paired, state: "error", lastErrorCategory: "timeout" }, "Sync couldn’t connect"],
    [{ ...paired, state: "error", lastErrorCategory: "secure_storage" }, "Sync needs attention"],
    [{ ...paired, state: "error", lastErrorCategory: "unsupported_version" }, "Sync needs attention"],
    [{ ...paired, supported: false, paired: false, state: "unpaired" }, "Sync isn’t available on this device"],
  ];
  for (const [status, headline] of cases) {
    await open(status);
    assert.equal(text("sync-status"), headline);
    get("sync-dialog").close();
  }

  await open({ ...paired, lastSuccessAt: null, dirty: true });
  assert.equal(text("sync-last-synced"), "Last synced on this device: Never");
  assert.equal(text("sync-status"), "Changes waiting to sync");
  // The headline already says it; the extra line only covers states that hide it.
  assert.equal(get("sync-dirty").hidden, true);
  get("sync-dialog").close();

  await open({ ...paired, state: "offline", lastErrorCategory: "offline", dirty: true });
  assert.equal(get("sync-dirty").hidden, false);
  assert.match(text("sync-status-detail"), /offline/);
  get("sync-dialog").close();

  await open({ ...paired });
  const shown = text("sync-last-synced");
  assert.match(shown, /^Last synced on this device: Today, /);
  // Refreshing status or failing a sync neither writes nor changes the time; Rust owns it.
  get("sync-button").click();
  await flush();
  backend.fail = { command: "sync_now", error: { category: "offline" } };
  get("sync-now").click();
  await flush();
  assert.equal(text("sync-last-synced"), shown);
  assert.equal(
    [...localStorage.values.keys()].some((key) => /sync/i.test(key)),
    false,
  );
});

test("the status says what Sync covers and what recovery doesn’t bring back", async () => {
  await open(unpaired);
  assert.equal(get("sync-scope").hidden, false);
  get("sync-dialog").close();
  await open(paired);
  assert.equal(get("sync-scope").hidden, false);
});

test("the roster marks this device, shows missing dates, renders names as text, and offers no revocation", async () => {
  const hostile = { ...phone, displayName: "<img src=x onerror=alert(1)>", joinedAtMs: 0, lastSyncedAtMs: null };
  await open({ ...paired, devices: [hostile, thisDevice] });
  const rows = get("sync-devices").children;
  assert.equal(rows.length, 2);
  // This device leads, whatever order the roster arrives in.
  assert.deepEqual(rowTexts(rows[0]).slice(0, 2), ["Studio laptop", "This device"]);
  assert.match(rowTexts(rows[0]).at(-1), /^Linux · First joined: .+ · Last synced: .+/);
  assert.deepEqual(rowTexts(rows[1]), [
    "<img src=x onerror=alert(1)>",
    "Android · First joined: Not yet recorded · Last synced: Not yet recorded",
  ]);
  assert.equal(rows.filter((row) => row.dataset.thisDevice !== undefined).length, 1);
  const shown = rows.flatMap(rowTexts).join(" ");
  assert.doesNotMatch(shown, /online|active|connected|remove|revoke/i);
  assert.equal(
    rows.every((row) => row.children.every((child) => child.children.length === 0)),
    true,
  );
});

test("renaming works offline, trims, validates, and survives a status refresh while editing", async () => {
  await open({ ...paired, state: "offline", lastErrorCategory: "offline", dirty: false });
  assert.equal(get("sync-name-input").value, "Studio laptop");

  get("sync-name-input").value = "  Desk  ";
  get("sync-name-input").dispatchEvent(new Event("input"));
  // A status event while typing must not overwrite the edit.
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-name-input").value, "  Desk  ");
  submit("sync-name-form");
  await flush();
  assert.deepEqual(
    syncCalls("set_sync_device_name").map((call) => call.args),
    [{ name: "Desk" }],
  );
  assert.equal(get("sync-name-error").hidden, true);
  assert.equal(get("sync-name-input").value, "Desk");
  assert.equal(rowTexts(get("sync-devices").children[0])[0], "Desk");
  assert.equal(get("sync-dirty").hidden, false);
  assert.equal(syncCalls("sync_now").length, 0);
  assert.equal(document.activeElement, get("sync-name-input"));

  for (const [value, expected] of [
    ["   ", /Enter a name/],
    ["x".repeat(129), /128 characters/],
    ["bad\u0007name", /control characters/],
  ]) {
    get("sync-name-input").value = value;
    get("sync-name-input").dispatchEvent(new Event("input"));
    submit("sync-name-form");
    await flush();
    assert.equal(get("sync-name-error").hidden, false);
    assert.match(text("sync-name-error"), expected);
    assert.equal(get("sync-name-input").getAttribute("aria-invalid"), "true");
    assert.equal(document.activeElement, get("sync-name-input"));
  }
  assert.equal(syncCalls("set_sync_device_name").length, 1);
  get("sync-name-input").dispatchEvent(new Event("input"));
  assert.equal(get("sync-name-error").hidden, true);

  backend.fail = { command: "set_sync_device_name", error: { category: "persistence" } };
  get("sync-name-input").value = "Kitchen";
  submit("sync-name-form");
  await flush();
  assert.match(text("sync-name-error"), /could not be saved/);
  assert.match(text("sync-name-error"), /name was not changed/);
});

test("Show recovery key is an explicit action and the key leaves the page when hidden or closed", async () => {
  await open(paired);
  assert.equal(text("sync-recovery-key"), "");
  assert.equal(syncCalls("get_sync_recovery_key").length, 0);
  get("sync-show-key").click();
  await flush();
  assert.equal(syncCalls("get_sync_recovery_key").length, 1);
  assert.equal(text("sync-recovery-key"), KEY);
  assert.equal(get("sync-recovery").hidden, false);
  assert.equal(get("sync-paired").hidden, true);
  // Viewing a key already saved needs no confirmation checkbox, and nothing blocks leaving.
  assert.equal(get("sync-key-confirm").hidden, true);
  assert.equal(get("sync-close").disabled, false);
  assert.equal(document.activeElement, get("sync-copy-key"));
  assert.equal(JSON.stringify(backend.current).includes(KEY), false);
  assert.equal(
    [...localStorage.values.values()].some((value) => value.includes(KEY)),
    false,
  );

  get("sync-done").click();
  assert.equal(text("sync-recovery-key"), "");
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(document.activeElement, get("sync-show-key"));

  get("sync-show-key").click();
  await flush();
  assert.equal(text("sync-recovery-key"), KEY);
  get("sync-close").click();
  assert.equal(get("sync-dialog").open, false);
  assert.equal(text("sync-recovery-key"), "");
  get("sync-button").click();
  await flush();
  assert.equal(text("sync-recovery-key"), "");
  assert.equal(get("sync-recovery").hidden, true);
});

test("a failed key read shows an error, no key, and returns focus to the button", async () => {
  await open(paired);
  backend.fail = { command: "get_sync_recovery_key", error: { category: "secure_storage" } };
  get("sync-show-key").click();
  await flush();
  assert.equal(text("sync-recovery-key"), "");
  assert.match(text("sync-error-message"), /secure storage/);
  assert.equal(document.activeElement, get("sync-show-key"));
});

test("errors are specific, retry only when retrying can help, and never offer to overwrite the remote", async () => {
  await open(paired);
  const failWith = async (category) => {
    backend.fail = { command: "sync_now", error: { category } };
    get("sync-now").click();
    await flush();
    return { message: text("sync-error-message"), retry: !get("sync-retry").hidden };
  };

  const conflict = await failWith("conflict");
  assert.match(conflict.message, /kept changing/);
  assert.match(conflict.message, /safe/);
  assert.equal(conflict.retry, true);

  const newer = await failWith("unsupported_version");
  assert.match(newer.message, /Update the app/);
  assert.equal(newer.retry, false);

  for (const category of ["invalid_remote_data", "schema_downgrade", "rollback_detected", "server_rollback_detected"]) {
    const result = await failWith(category);
    assert.match(result.message, /not applied/);
    assert.equal(result.retry, false);
    assert.doesNotMatch(result.message, /repair|overwrite|replace/i);
  }

  // Retry repeats the failed action and clears the error when it works.
  await failWith("offline");
  backend.fail = null;
  get("sync-retry").click();
  await flush();
  assert.equal(get("sync-error").hidden, true);
  assert.deepEqual(
    [...new Set(calls.map((call) => call.command))].filter((command) => /overwrite|repair|reset/.test(command)),
    [],
  );
  assert.equal(get("sync-paired").hidden, false);
});

test("an unsupported platform is a stated condition, not an unknown command", async () => {
  await open({ ...unpaired, supported: false });
  assert.equal(text("sync-status"), "Sync isn’t available on this device");
  assert.equal(get("sync-enable").disabled, true);
  assert.equal(get("sync-join").disabled, true);
  backend.current = structuredClone(paired);
  backend.fail = { command: "get_sync_recovery_key", error: { category: "unsupported_platform" } };
  await open(paired);
  get("sync-show-key").click();
  await flush();
  assert.match(text("sync-error-message"), /isn’t available on this device/);
});

test("a rejected recovery key keeps the text for fixing and returns focus to the field", async () => {
  await open(unpaired);
  get("sync-show-join").click();
  await flush();
  choose("restore");
  backend.fail = { command: "join_sync", error: { category: "invalid_recovery_key", details: "private" } };
  get("sync-recovery-input").value = "rf1-typo";
  submit("sync-join-form");
  await flush();
  assert.match(text("sync-error-message"), /isn’t valid/);
  assert.doesNotMatch(text("sync-error-message"), /private/);
  assert.equal(get("sync-recovery-input").value, "rf1-typo");
  assert.equal(get("sync-retry").hidden, true);
  assert.equal(document.activeElement, get("sync-recovery-input"));
  assert.equal(get("sync-paired").hidden, true);

  backend.fail = { command: "join_sync", error: { category: "missing_chain" } };
  submit("sync-join-form");
  await flush();
  assert.match(text("sync-error-message"), /No Sync was found/);
  get("sync-join-cancel").click();
  assert.equal(get("sync-join-form").hidden, true);
  assert.equal(get("sync-recovery-input").value, "");
  assert.equal(get("sync-error").hidden, true);
  assert.equal(document.activeElement, get("sync-show-join"));
});

test("disconnecting works offline, keeps saved data, and manages focus", async () => {
  await open(paired);
  get("sync-leave").click();
  assert.equal(get("sync-leave-confirm").hidden, false);
  assert.equal(get("sync-paired").hidden, true);
  assert.equal(document.activeElement, get("sync-leave-cancel"));
  get("sync-leave-cancel").click();
  assert.equal(get("sync-leave-confirm").hidden, true);
  assert.equal(document.activeElement, get("sync-leave"));

  backend.fail = { command: "leave_sync", error: { category: "secure_storage" } };
  get("sync-leave").click();
  get("sync-leave-confirm-button").click();
  await flush();
  assert.equal(get("sync-leave-confirm").hidden, false);
  assert.match(text("sync-error-message"), /secure storage/);
  assert.equal(document.activeElement, get("sync-leave-confirm-button"));

  backend.fail = null;
  backend.onSyncNow = () => assert.fail("disconnecting must not need the server");
  get("sync-leave-confirm-button").click();
  await flush();
  assert.equal(get("sync-unpaired").hidden, false);
  assert.equal(text("sync-status"), "Sync is off");
  assert.equal(document.activeElement, get("sync-enable"));
  // Only the local command ran; the saved frame is still in the view.
  assert.equal(syncCalls("sync_now").length, 0);
  assert.equal(stateModule.state.history.length, 1);
});

test("a status failure is an error with a retry, never a status stuck on Checking", async () => {
  backend.statusFails = true;
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-error").hidden, false);
  assert.match(text("sync-error-message"), /took too long/);
  assert.equal(get("sync-retry").hidden, false);
  backend.statusFails = false;
  get("sync-retry").click();
  await flush();
  assert.equal(get("sync-error").hidden, true);
  assert.doesNotMatch(text("sync-status"), /Checking/);
});

test("Sync now and the Sync event reload the history, favorites, and an open Stats dialog", async () => {
  await open(paired);
  get("stats-button").click();
  await flush();
  assert.equal(text("stats-total"), "5");

  backend.activityTotal = 9;
  backend.history = [...backend.history, { ...backend.history[0], id: "def456" }];
  get("sync-now").click();
  await flush();
  assert.equal(text("stats-total"), "9");
  assert.equal(stateModule.state.history.length, 2);
  assert.equal(document.activeElement, get("sync-now"));

  // A sync that finishes elsewhere (startup, another trigger) arrives as an event.
  backend.activityTotal = 12;
  backend.history = [...backend.history, { ...backend.history[0], id: "ghi789" }];
  const handler = listeners.at(-1);
  handler({ event: "sync-state-changed", id: 1, payload: null });
  await flush();
  assert.equal(text("stats-total"), "12");
  assert.equal(stateModule.state.history.length, 3);
});

test("startup sync does not toast and a failing startup leaves the dialog quiet", async () => {
  const toastCount = () => document.body.children[0]?.children.length ?? 0;
  const before = toastCount();
  await sync.runStartupSync();
  assert.equal(syncCalls("startup_sync").length, 1);
  backend.fail = { command: "startup_sync", error: { category: "offline" } };
  await sync.runStartupSync();
  assert.equal(toastCount(), before);
  assert.equal(get("tools-menu-button").dataset.sync, undefined);
});

// --- first-join modes -------------------------------------------------------------------------

const count = (n) => n.toLocaleString();
const restoreOption = () => get("sync-join-restore");
const mergeOption = () => get("sync-join-merge");
const choose = (mode) => {
  restoreOption().checked = mode === "restore";
  mergeOption().checked = mode === "merge";
  (mode === "restore" ? restoreOption() : mergeOption()).dispatchEvent(new Event("change"));
};
const joinCalls = () => syncCalls("join_sync").map((call) => call.args);

async function openJoin(summary) {
  if (summary) backend.summary = { ...backend.summary, ...summary };
  await open(unpaired);
  get("sync-show-join").click();
  await flush();
}

test("meaningful state starts neutral; explicitly choosing Restore enables joining", async () => {
  await openJoin();
  assert.equal(syncCalls("get_sync_join_summary").length, 1);
  assert.equal(restoreOption().checked, false);
  assert.equal(mergeOption().checked, false);
  assert.equal(text("sync-join"), "Connect this device");
  assert.equal(get("sync-join-modes").hidden, false);
  assert.equal(get("sync-join-fresh").hidden, true);
  assert.equal(get("sync-join").disabled, true);
  choose("restore");
  assert.equal(restoreOption().checked, true);
  assert.equal(get("sync-join").disabled, false);
  get("sync-recovery-input").value = KEY;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls(), [{ recoveryKey: KEY, mode: "restore" }]);
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-join-form").hidden, true);
});

test("choosing Merge sends merge, and the label never decides the mode", async () => {
  await openJoin();
  choose("merge");
  assert.equal(get("sync-join").disabled, false);
  assert.equal(text("sync-join"), "Merge this device");
  get("sync-recovery-input").value = KEY;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls(), [{ recoveryKey: KEY, mode: "merge" }]);

  // A relabelled button cannot change what Restore means.
  backend.current = structuredClone(unpaired);
  await open(unpaired);
  get("sync-show-join").click();
  await flush();
  assert.equal(restoreOption().checked, false);
  choose("restore");
  get("sync-join").textContent = "Merge this device";
  get("sync-recovery-input").value = KEY;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls().at(-1), { recoveryKey: KEY, mode: "restore" });
});

test("Enter/form submission without a choice cannot Restore or Merge, regardless of button text", async () => {
  await openJoin();
  assert.equal(restoreOption().checked, false);
  assert.equal(mergeOption().checked, false);
  assert.equal(get("sync-join").disabled, true);
  get("sync-join").textContent = "Restore this device";
  get("sync-recovery-input").value = KEY;
  submit("sync-join-form");
  await flush();
  assert.equal(syncCalls("join_sync").length, 0);
  assert.match(text("sync-error-message"), /Choose how this device should join/);
  assert.equal(document.activeElement, restoreOption());
  assert.equal(get("sync-recovery-input").value, KEY);
});

test("a submit while the summary is still loading cannot join even with a selected radio", async () => {
  await open(unpaired);
  get("sync-show-join").click();
  choose("restore");
  get("sync-recovery-input").value = KEY;
  assert.equal(get("sync-join").disabled, true);
  submit("sync-join-form");
  await flush();
  assert.equal(joinCalls().length, 0);
});

test("the local summary is aggregate counts and the Merge warning names previous deletions", async () => {
  await openJoin({ history: 3, historyRemovals: 1214, favorites: 1, favoriteRemovals: 2, activityRemovals: 1 });
  assert.equal(get("sync-join-local").hidden, false);
  assert.equal(
    text("sync-join-local"),
    `This device currently has 3 history items, 1 favorite, ${count(1217)} previous deletions.`,
  );
  assert.equal(get("sync-join-merge-deletions").hidden, false);
  assert.equal(
    text("sync-join-merge-deletions"),
    `This device has ${count(1217)} previous deletions that will also be merged.`,
  );
  const visible = [text("sync-join-local"), text("sync-join-merge-deletions")].join(" ");
  assert.doesNotMatch(visible, /[0-9a-f]{16}|operation|tombstone|CRDT|snapshot|revision/i);
  // Deletion warnings never select a mode.
  assert.equal(restoreOption().checked, false);
  get("sync-join-cancel").click();
  assert.equal(text("sync-join-local"), "");
  assert.equal(get("sync-join-merge-deletions").hidden, true);
});

test("a device with only deletions is not treated as empty", async () => {
  await openJoin({ history: 0, historyRemovals: 5, meaningful: true });
  assert.equal(get("sync-join-modes").hidden, false);
  assert.equal(get("sync-join-fresh").hidden, true);
  assert.equal(text("sync-join-local"), "This device currently has 5 previous deletions.");
  assert.match(text("sync-join-merge-deletions"), /5 previous deletions that will also be merged/);
  assert.equal(restoreOption().checked, false);
  assert.equal(mergeOption().checked, false);
  assert.equal(get("sync-join").disabled, true);
  // Without any deletions the Merge line stays quiet.
  get("sync-join-cancel").click();
  await openJoin({ history: 2, historyRemovals: 0, meaningful: true });
  assert.equal(get("sync-join-merge-deletions").hidden, true);
});

test("a device with nothing synced streamlines to Restore, and says so", async () => {
  await openJoin({ history: 0, favorites: 0, meaningful: false });
  assert.equal(get("sync-join-modes").hidden, true);
  assert.equal(get("sync-join-fresh").hidden, false);
  assert.equal(get("sync-join-local").hidden, true);
  assert.equal(text("sync-join"), "Restore this device");
  get("sync-recovery-input").value = KEY;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls(), [{ recoveryKey: KEY, mode: "restore" }]);
  assert.equal(get("sync-paired").hidden, false);
});

test("an unreadable summary keeps both choices instead of assuming the device is empty", async () => {
  backend.summaryFails = true;
  await openJoin();
  assert.equal(get("sync-join-modes").hidden, false);
  assert.equal(get("sync-join-fresh").hidden, true);
  assert.equal(get("sync-join-local").hidden, true);
  assert.equal(get("sync-join").disabled, true);
  choose("merge");
  get("sync-recovery-input").value = KEY;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls(), [{ recoveryKey: KEY, mode: "merge" }]);
});

test("a failed join preserves either explicit choice for retry, then success resets to neutral", async () => {
  for (const mode of ["restore", "merge"]) {
    const start = joinCalls().length;
    await openJoin();
    choose(mode);
    get("sync-recovery-input").value = KEY;
    backend.fail = { command: "join_sync", error: { category: "timeout" } };
    submit("sync-join-form");
    await flush();
    assert.equal(get("sync-join-form").hidden, false);
    assert.equal(mergeOption().checked, mode === "merge");
    assert.equal(restoreOption().checked, mode === "restore");
    assert.equal(get("sync-join").disabled, false);
    assert.equal(get("sync-recovery-input").value, KEY);
    assert.equal(get("sync-retry").hidden, false);
    backend.fail = null;
    get("sync-retry").click();
    await flush();
    assert.deepEqual(joinCalls().slice(start), [
      { recoveryKey: KEY, mode },
      { recoveryKey: KEY, mode },
    ]);
    assert.equal(get("sync-paired").hidden, false);
    assert.equal(restoreOption().checked, false);
    assert.equal(mergeOption().checked, false);
  }
});

test("Restore reloads replaced views when final local pairing fails", async () => {
  for (const category of ["secure_storage", "persistence"]) {
    const oldItem = { source: "prntsc", id: "oldlocal", sourcePageUrl: "https://prnt.sc/oldlocal", viewedAt: 1 };
    stateModule.applyHistory({ history: [oldItem], index: 0 });
    stateModule.applyFavorites([{ ...oldItem, addedAt: 1 }]);
    await openJoin();
    choose("restore");
    get("sync-recovery-input").value = KEY;
    // Native Restore replaces the stores before saving credentials and sync-config.
    backend.onJoin = () => {
      backend.history = [];
      backend.favorites = [];
    };
    backend.fail = { command: "join_sync", error: { category } };
    submit("sync-join-form");
    await flush();
    assert.deepEqual(stateModule.state.history, []);
    assert.deepEqual(stateModule.state.favorites, []);
    assert.equal(stateModule.state.index, -1);
    assert.equal(get("favorite-button").disabled, true);
    assert.equal(get("sync-retry").hidden, false);
    assert.match(text("sync-error-message"), category === "secure_storage" ? /secure storage/ : /could not be saved/);
    assert.equal(get("sync-recovery-input").value, KEY);
    assert.equal(restoreOption().checked, true);
    backend.fail = null;
    get("sync-retry").click();
    await flush();
    assert.equal(get("sync-paired").hidden, false);
  }
});

test("cancelling a join returns to neutral and forgets the key and the summary", async () => {
  await openJoin({ historyRemovals: 9 });
  choose("merge");
  get("sync-recovery-input").value = KEY;
  get("sync-join-cancel").click();
  assert.equal(get("sync-join-form").hidden, true);
  assert.equal(get("sync-recovery-input").value, "");
  assert.equal(restoreOption().checked, false);
  assert.equal(mergeOption().checked, false);
  assert.equal(syncCalls("join_sync").length, 0);
});

test("the options are native radios with labelled consequences for assistive technology", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const form = html.split('id="sync-join-form"')[1].split("</form>")[0];
  assert.match(form, /<fieldset[^>]*id="sync-join-modes"/);
  assert.match(form, /<legend>How should this device join\?<\/legend>/);
  for (const [option, value] of [
    ["sync-join-restore", "restore"],
    ["sync-join-merge", "merge"],
  ]) {
    const input = form.match(new RegExp(`<input[^>]*id="${option}"[^>]*>`))?.[0] ?? "";
    assert.match(input, /type="radio"/);
    assert.match(input, /name="sync-join-mode"/);
    assert.match(input, new RegExp(`value="${value}"`));
    assert.match(form, new RegExp(`<label[^>]*for="${option}"`));
    for (const described of input.match(/aria-describedby="([^"]+)"/)[1].split(" "))
      assert.match(form, new RegExp(`id="${described}"`), described);
  }
  // Fake DOM cannot exercise native arrow keys or implicit Enter submission.
  // Assert native grouping and neutral markup; form-handler tests cover submission safety.
  assert.doesNotMatch(form.match(/<input[^>]*id="sync-join-restore"[^>]*>/)[0], /\bchecked\b/);
  assert.doesNotMatch(form.match(/<input[^>]*id="sync-join-merge"[^>]*>/)[0], /\bchecked\b/);
  const css = await readFile(new URL("../dist/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.sync-join__option:has\(input:focus-visible\)/);
});

test("join copy is concrete, avoids vague promises, and keeps developer terms out", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const form = html.split('id="sync-connect-title"')[1].split('id="sync-recovery"')[0];
  const copy = form.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const phrase of [
    "Enter your recovery key, then choose how this device should join your Sync.",
    "Restore this device from Sync",
    "Replace this device’s synced data with the copy already in Sync. Best for a new installation or another computer.",
    "Local history, favorites and their previous deletions will not be added to Sync.",
    "If your Sync was saved by an older app, data it could not save is kept from this device.",
    "Merge this device with Sync",
    "Combine this device’s existing synced data with the copy already in Sync.",
    "Previous deletions on this device are included. They may remove items that still exist on your other devices.",
  ])
    assert.ok(copy.includes(phrase), phrase);
  assert.doesNotMatch(
    copy,
    /keep local data|combine safely|nothing will be lost|tombstone|CRDT|operation|revision|snapshot/i,
  );
});

test("the roster renders the Rust serialization contract fixture", async () => {
  const device = JSON.parse(await readFile(new URL("./fixtures/sync-device-summary.json", import.meta.url), "utf8"));
  await open({ ...paired, devices: [device] });
  const format = (at) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  assert.equal(
    rowTexts(get("sync-devices").children[0]).at(-1),
    `Linux · First joined: ${format(1700000000000)} · Last synced: ${format(1700000060000)}`,
  );
});
