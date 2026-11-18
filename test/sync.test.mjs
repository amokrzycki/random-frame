import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { FakeDocument, FakeStorage, ids, libraryOf } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const NOW = Date.now();
const WORDS =
  "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual".split(
    " ",
  );
const CODE = WORDS.join(" ");
const NEW_CODE = [...WORDS.slice(1), "adapt"].join(" ");
const REKEYED_CODE = [...WORDS.slice(2), "adapt", "add"].join(" ");
const TYPED_CODE = `  ${WORDS.slice(0, 12)
  .map((word) => word.toUpperCase())
  .join(" ")}\n${WORDS.slice(12).join("   ")}  \n`;

const unpaired = {
  supported: true,
  paired: false,
  state: "unpaired",
  lastSuccessAt: null,
  lastSuccessRevision: null,
  dirty: true,
  lastErrorCategory: null,
  thisDeviceId: "aabbccdd",
  devices: [],
  groupState: null,
  membershipState: null,
  masterMemberId: null,
  thisMemberId: null,
  credentialVersion: null,
  keyEpoch: null,
  controlVerifiedAt: null,
  codeReady: false,
};
const thisDevice = {
  deviceId: "aabbccdd",
  displayName: "Studio laptop",
  platform: "linux",
  joinedAtMs: NOW - 86_400_000 * 9,
  lastSyncedAtMs: NOW - 60_000,
  thisDevice: true,
  memberId: null,
  status: null,
  isMaster: false,
};
const phone = {
  deviceId: "11223344",
  displayName: "Pocket phone",
  platform: "android",
  joinedAtMs: NOW - 86_400_000 * 3,
  lastSyncedAtMs: NOW - 86_400_000,
  thisDevice: false,
  memberId: null,
  status: null,
  isMaster: false,
};
const paired = {
  ...unpaired,
  paired: true,
  state: "idle",
  lastSuccessAt: NOW - 60_000,
  lastSuccessRevision: 4,
  dirty: false,
  devices: [phone, thisDevice],
};

const masterStatus = {
  ...paired,
  groupState: "active",
  membershipState: "active",
  masterMemberId: "master123456",
  thisMemberId: "master123456",
  credentialVersion: 1,
  keyEpoch: 1,
  controlVerifiedAt: NOW,
  codeReady: true,
  devices: [
    { ...thisDevice, memberId: "master123456", status: "active", isMaster: true },
    { ...phone, memberId: "member123456", status: "active", isMaster: false },
  ],
};
const memberStatus = {
  ...masterStatus,
  thisMemberId: "member123456",
  codeReady: false,
  devices: masterStatus.devices.map((d) => ({ ...d, thisDevice: d.memberId === "member123456" })),
};
const ended = (membershipState) => ({
  ...unpaired,
  state: "error",
  groupState: membershipState === "closed" ? "closed" : "active",
  membershipState,
  lastErrorCategory: membershipState,
  thisMemberId: "member123456",
});

const document = new FakeDocument(ids);
const disclosureToggle = document.createElement("button");
const disclosureBody = document.createElement("div");
const disclosureInput = document.createElement("input");
disclosureToggle.setAttribute("aria-expanded", "false");
disclosureBody.inert = true;
disclosureBody.append(disclosureInput);
disclosureToggle.nextElementSibling = disclosureBody;
const syncDialog = document.querySelector("#sync-dialog");
const queryDialog = syncDialog.querySelectorAll.bind(syncDialog);
syncDialog.querySelectorAll = (selector) =>
  selector === ".sync-disclosure__toggle" ? [disclosureToggle] : queryDialog(selector);
const localStorage = new FakeStorage();
const names = ["document", "localStorage", "navigator", "window"];
const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
const get = (id) => document.querySelector(`#${id}`);
const clipboard = { copied: [], fails: false };
const listeners = [];
const windowEvents = new EventTarget();
const everyCommand = new Set();
let backend;
let calls;
let sync;
let stateModule;

function resetBackend() {
  backend = {
    current: structuredClone(unpaired),
    code: null,
    createWithoutCode: false,
    fail: null,
    statusFails: false,
    statusFailCategory: null,

    activityTotal: 5,
    summary: {
      history: 3,
      historyRemovals: 0,
      favorites: 0,
      favoriteRemovals: 0,
      activityRemovals: 0,
      collections: 0,
      collectionRemovals: 0,
      memberships: 0,
      membershipRemovals: 0,
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
  // The WebView clipboard is not used: on Android it needs a user gesture the IPC round trip loses.
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  // The fake DOM does not read the markup's hidden attributes.
  for (const id of [
    "sync-join-form",
    "sync-join-fresh",
    "sync-join-local",
    "sync-join-merge-deletions",
    "sync-leave-confirm",
    "sync-error",
    "sync-code-error",
    "sync-remove-confirm",
    "sync-dissolve-confirm",
    "sync-newcode-confirm",
  ])
    get(id).hidden = true;
  get("sync-join-restore").checked = false;
  resetBackend();
  globalThis.window = {
    setTimeout: () => 0,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
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
        everyCommand.add(command);
        if (command === "plugin:event|listen") return 1;
        if (command === "plugin:clipboard-manager|write_text") {
          if (clipboard.fails) throw new Error("denied");
          clipboard.copied.push(args.text);
          return null;
        }
        if (command === "get_sync_status") {
          if (backend.statusFails) throw { category: backend.statusFailCategory ?? "timeout" };
          return structuredClone(backend.current);
        }
        if (command === "join_sync") backend.onJoin?.();
        if (backend.fail && command === backend.fail.command) throw backend.fail.error;
        if (command === "create_sync") {
          backend.current = structuredClone(masterStatus);
          backend.current.codeReady = !backend.createWithoutCode;
          backend.code = backend.createWithoutCode ? null : CODE;
          return { code: backend.code, status: structuredClone(backend.current) };
        }
        if (command === "get_sync_code") {
          if (!backend.code) throw { category: "no_code" };
          return backend.code;
        }
        if (command === "new_sync_code") {
          backend.code = NEW_CODE;
          backend.current.codeReady = true;
          return NEW_CODE;
        }
        if (command === "remove_sync_device") {
          backend.current.devices = backend.current.devices.map((d) =>
            d.memberId === args.memberId ? { ...d, status: "revoked" } : d,
          );
          backend.code = REKEYED_CODE;
          backend.current.codeReady = true;
          return structuredClone(backend.current);
        }
        if (command === "dissolve_sync") {
          backend.current = { ...ended("closed"), thisMemberId: "master123456" };
          backend.code = null;
          return structuredClone(backend.current);
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
          backend.current = backend.current.paired ? ended("left") : structuredClone(unpaired);
          return structuredClone(backend.current);
        }
        if (command === "startup_sync") return structuredClone(backend.current);
        if (command === "get_history") return { history: structuredClone(backend.history), index: -1 };
        if (command === "get_saved_library") return libraryOf(structuredClone(backend.favorites));
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
  const stage = await import("../dist/test-client/stage.js");
  stage.bindStageEvents();
  sync.bindSyncDialogEvents();
  stats.bindStatsDialogEvents();
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
  if (status.codeReady) backend.code = CODE;
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-dialog").open, true);
}

const text = (id) => get(id).textContent;
const rowTexts = (row) => row.children.map((child) => child.textContent);
const submit = (id) => get(id).dispatchEvent(new Event("submit", { cancelable: true }));
const syncCalls = (command) => calls.filter((call) => call.command === command);

test("an initial failed status read ends checking and offers retry without inventing Sync history", async () => {
  backend.statusFails = true;
  await open();
  assert.equal(text("sync-status"), "Could not check Sync status");
  assert.equal(get("sync-last-synced").hidden, true);
  assert.equal(get("sync-retry").hidden, false);
  assert.equal(get("sync-status").dataset.state, "error");
  backend.statusFails = false;
  get("sync-retry").click();
  await flush();
  assert.equal(text("sync-status"), "Sync is off");
});

test("failed status checks replace current success while retaining reliable history and retry", async () => {
  await open(paired);
  const last = text("sync-last-synced");
  const devices = get("sync-devices").children;
  backend.statusFails = true;
  get("sync-button").click();
  await flush();
  assert.equal(text("sync-status"), "Could not check Sync status");
  assert.equal(text("sync-last-synced"), last);
  assert.deepEqual(get("sync-devices").children, devices);
  assert.equal(get("sync-retry").hidden, false);
  assert.equal(get("sync-status").dataset.state, "error");
  backend.statusFails = false;
  get("sync-retry").click();
  await flush();
  assert.equal(text("sync-status"), "Sync completed");
});

test("a shrinking join viewport keeps the already focused code field in its scroll region", async () => {
  await open();
  get("sync-show-join").click();
  await flush();
  const input = get("sync-code-input");
  const scrolled = [];
  input.scrollIntoView = (options) => scrolled.push(options);
  input.focus();
  windowEvents.dispatchEvent(new Event("resize"));
  assert.deepEqual(scrolled, [{ block: "nearest" }]);
  get("sync-join-cancel").click();
  windowEvents.dispatchEvent(new Event("resize"));
  assert.equal(scrolled.length, 1, "other controls do not jump on viewport changes");
});

test("Start a new Sync shows the administrator view with the code, and the code leaves the page on hide or close", async () => {
  await open(unpaired);
  assert.equal(get("sync-unpaired").hidden, false);
  assert.equal(get("sync-paired").hidden, true);
  get("sync-enable").click();
  await flush();
  assert.equal(syncCalls("create_sync").length, 1);
  assert.equal(get("sync-unpaired").hidden, true);
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-code-panel").hidden, false);
  assert.equal(text("sync-code"), CODE);
  assert.equal(get("sync-code").hidden, false);
  assert.equal(get("sync-code-missing").hidden, true);
  assert.equal(get("sync-copy-code").hidden, false);
  assert.equal(text("sync-show-code"), "Hide code");
  assert.equal(get("sync-leave").hidden, true);
  assert.equal(get("sync-dissolve").hidden, false);
  assert.equal(get("sync-error").hidden, true);
  assert.equal(document.activeElement, get("sync-copy-code"));
  assert.equal(get("sync-close").disabled, false);
  assert.ok(rowTexts(get("sync-devices").children[0]).includes("Administrator"));
  assert.equal(JSON.stringify(backend.current).includes(CODE), false);
  assert.equal(
    [...localStorage.values.values()].some((value) => value.includes(WORDS[0])),
    false,
  );

  get("sync-copy-code").click();
  await flush();
  assert.deepEqual(clipboard.copied, [CODE]);

  get("sync-show-code").click();
  assert.equal(text("sync-code"), "");
  assert.equal(get("sync-code").hidden, true);
  assert.equal(get("sync-copy-code").hidden, true);
  assert.equal(text("sync-show-code"), "Show code");
  assert.equal(syncCalls("get_sync_code").length, 0);

  get("sync-show-code").click();
  await flush();
  assert.equal(syncCalls("get_sync_code").length, 1);
  assert.equal(text("sync-code"), CODE);
  assert.equal(document.activeElement, get("sync-copy-code"));

  get("sync-close").click();
  assert.equal(get("sync-dialog").open, false);
  assert.equal(text("sync-code"), "");
  get("sync-button").click();
  await flush();
  assert.equal(text("sync-code"), "");
  assert.equal(text("sync-show-code"), "Show code");
});

test("a status refresh or Sync event neither hides nor rewrites a shown code", async () => {
  await open(masterStatus);
  get("sync-show-code").click();
  await flush();
  get("sync-button").click();
  await flush();
  listeners.at(-1)({ event: "sync-state-changed", id: 1, payload: null });
  await flush();
  assert.equal(text("sync-code"), CODE);
});

test("damaged local Sync state offers a reset instead of a dead end", async () => {
  backend.statusFails = true;
  backend.statusFailCategory = "corrupt_local_state";
  await open();
  assert.equal(get("sync-retry").hidden, false);
  assert.equal(text("sync-retry"), "Reset Sync on this device");
  backend.statusFails = false;
  get("sync-retry").click();
  await flush();
  assert.equal(syncCalls("leave_sync").length, 1);
  assert.equal(get("sync-unpaired").hidden, false);
});

test("a new code or a removal clears the old code even when the request fails", async () => {
  await open(masterStatus);
  get("sync-show-code").click();
  await flush();
  assert.equal(text("sync-code"), CODE);
  backend.fail = { command: "new_sync_code", error: { category: "timeout" } };
  get("sync-new-code").click();
  get("sync-newcode-submit").click();
  await flush();
  assert.equal(text("sync-code"), "");
  assert.equal(get("sync-copy-code").hidden, true);
});

test("a status that reports the code as not ready does not hide a code already on screen", async () => {
  await open(masterStatus);
  get("sync-show-code").click();
  await flush();
  backend.current.codeReady = false;
  get("sync-now").click();
  await flush();
  assert.equal(text("sync-code"), CODE);
  assert.equal(get("sync-code-missing").hidden, true);
});

test("a clipboard failure keeps the code on screen for manual copying", async () => {
  await open(unpaired);
  get("sync-enable").click();
  await flush();
  clipboard.fails = true;
  get("sync-copy-code").click();
  await flush();
  assert.equal(get("sync-error").hidden, false);
  assert.match(text("sync-error-message"), /copy it by hand/);
  assert.equal(get("sync-retry").hidden, true);
  assert.equal(text("sync-code"), CODE);
});

test("create failure retains a retry instead of exposing an unstored code", async () => {
  backend.fail = { command: "create_sync", error: { category: "timeout" } };
  await open(unpaired);
  get("sync-enable").click();
  await flush();
  assert.equal(text("sync-code"), "");
  assert.equal(get("sync-retry").hidden, false);
  backend.fail = null;
  get("sync-retry").click();
  await flush();
  assert.equal(text("sync-code"), CODE);
  assert.equal(get("sync-paired").hidden, false);
});

test("a Sync created without a registered code says so and offers New code as the first action", async () => {
  backend.createWithoutCode = true;
  await open(unpaired);
  get("sync-enable").click();
  await flush();
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-code-panel").hidden, false);
  assert.equal(get("sync-code-missing").hidden, false);
  assert.equal(get("sync-code-about").hidden, true);
  assert.equal(get("sync-code").hidden, true);
  assert.equal(get("sync-show-code").hidden, true);
  assert.equal(get("sync-new-code").className, "primary-action");
  assert.equal(document.activeElement, get("sync-new-code"));

  get("sync-new-code").click();
  assert.equal(get("sync-newcode-confirm").hidden, false);
  assert.equal(syncCalls("new_sync_code").length, 0);
  get("sync-newcode-submit").click();
  await flush();
  assert.equal(syncCalls("new_sync_code").length, 1);
  assert.equal(get("sync-newcode-confirm").hidden, true);
  assert.equal(text("sync-code"), NEW_CODE);
  assert.equal(get("sync-code-missing").hidden, true);
  assert.equal(get("sync-new-code").className, "sync-dialog__button");
});

test("Show code without a registered code ends in the same New code state", async () => {
  await open(masterStatus);
  backend.code = null;
  get("sync-show-code").click();
  await flush();
  assert.equal(text("sync-code"), "");
  assert.match(text("sync-error-message"), /no code yet/i);
  assert.equal(get("sync-retry").hidden, true);
  backend.current.codeReady = false;
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-code-missing").hidden, false);
  assert.equal(get("sync-new-code").className, "primary-action");
});

test("every status has its own headline and the last sync time comes only from the status", async () => {
  const cases = [
    [{ ...unpaired }, "Sync is off"],
    [{ ...paired, state: "syncing" }, "Syncing…"],
    [{ ...paired, state: "updating_key" }, "Updating the key automatically…"],
    [{ ...paired, dirty: true }, "Changes waiting to sync"],
    [{ ...paired }, "Sync completed"],
    [{ ...paired, state: "offline", lastErrorCategory: "offline" }, "Sync couldn’t connect"],
    [{ ...paired, state: "error", lastErrorCategory: "timeout" }, "Sync couldn’t connect"],
    [{ ...paired, state: "error", lastErrorCategory: "secure_storage" }, "Sync needs attention"],
    [{ ...paired, supported: false, paired: false, state: "unpaired" }, "Sync isn’t available on this device"],
    [ended("revoked"), "This device is no longer syncing"],
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

test("the status says what Sync covers", async () => {
  await open(unpaired);
  assert.equal(get("sync-scope").hidden, false);
  get("sync-dialog").close();
  await open(paired);
  assert.equal(get("sync-scope").hidden, false);
});

test("the roster marks this device, shows missing dates, renders names as text, and offers no removal to a member", async () => {
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

test("a device that is not the administrator sees no code, remove or New code, and can leave", async () => {
  await open(memberStatus);
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-code-panel").hidden, true);
  assert.equal(text("sync-code"), "");
  assert.equal(get("sync-dissolve").hidden, true);
  assert.equal(get("sync-leave").hidden, false);
  const rows = get("sync-devices").children;
  assert.equal(rows.length, 2);
  assert.equal(
    rows.flatMap((row) => row.children).some((child) => child.textContent === "Remove"),
    false,
  );
  assert.ok(rows.flatMap(rowTexts).includes("Administrator"));
  assert.equal(syncCalls("get_sync_code").length, 0);
  assert.equal(syncCalls("new_sync_code").length, 0);
});

test("the administrator sees the code controls, a Remove action for other active devices, and End Sync instead of Leave", async () => {
  await open(masterStatus);
  assert.equal(get("sync-code-panel").hidden, false);
  assert.equal(get("sync-code").hidden, true);
  assert.equal(text("sync-show-code"), "Show code");
  assert.equal(get("sync-leave").hidden, true);
  assert.equal(get("sync-dissolve").hidden, false);
  const removable = get("sync-devices")
    .children.flatMap((row) => row.children)
    .filter((child) => child.textContent === "Remove");
  assert.equal(removable.length, 1);
  assert.match(removable[0].getAttribute("aria-label"), /^Remove Pocket phone/);
  const own = get("sync-devices").children[0];
  assert.ok(rowTexts(own).includes("Administrator"));
  assert.ok(rowTexts(own).includes("This device"));
  assert.equal(syncCalls("get_sync_code").length, 0);
});

test("New code asks first, explains who is affected, and shows the replacement code", async () => {
  await open(masterStatus);
  get("sync-show-code").click();
  await flush();
  assert.equal(text("sync-code"), CODE);
  get("sync-new-code").click();
  assert.equal(get("sync-newcode-confirm").hidden, false);
  assert.equal(get("sync-paired").hidden, true);
  assert.equal(document.activeElement, get("sync-newcode-cancel"));
  assert.equal(syncCalls("new_sync_code").length, 0);

  get("sync-newcode-cancel").click();
  assert.equal(get("sync-newcode-confirm").hidden, true);
  assert.equal(document.activeElement, get("sync-new-code"));
  assert.equal(syncCalls("new_sync_code").length, 0);
  assert.equal(text("sync-code"), CODE);

  backend.fail = { command: "new_sync_code", error: { category: "offline" } };
  get("sync-new-code").click();
  get("sync-newcode-submit").click();
  await flush();
  assert.equal(get("sync-newcode-confirm").hidden, false);
  assert.match(text("sync-error-message"), /offline/);
  assert.equal(text("sync-code"), "", "a code that may already be replaced is no longer shown");
  assert.equal(document.activeElement, get("sync-newcode-submit"));

  backend.fail = null;
  get("sync-retry").click();
  await flush();
  assert.equal(syncCalls("new_sync_code").length, 2);
  assert.equal(get("sync-newcode-confirm").hidden, true);
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(text("sync-code"), NEW_CODE);
});

test("removing a device confirms the exact device, then rotates the key and drops the stale code", async () => {
  await open(masterStatus);
  get("sync-show-code").click();
  await flush();
  const remove = get("sync-devices")
    .children.flatMap((row) => row.children)
    .find((child) => child.textContent === "Remove");
  remove.click();
  assert.equal(get("sync-remove-confirm").hidden, false);
  assert.equal(get("sync-paired").hidden, true);
  assert.match(text("sync-remove-target"), /Pocket phone.*member12/);
  assert.equal(document.activeElement, get("sync-remove-cancel"));

  get("sync-remove-cancel").click();
  assert.equal(get("sync-remove-confirm").hidden, true);
  assert.equal(syncCalls("remove_sync_device").length, 0);
  assert.equal(text("sync-code"), CODE);

  const again = get("sync-devices")
    .children.flatMap((row) => row.children)
    .find((child) => child.textContent === "Remove");
  again.click();
  get("sync-remove-device").click();
  await flush();
  assert.deepEqual(
    syncCalls("remove_sync_device").map((call) => call.args),
    [{ memberId: "member123456" }],
  );
  assert.equal(get("sync-remove-confirm").hidden, true);
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(text("sync-code"), "");
  assert.equal(text("sync-show-code"), "Show code");
  assert.equal(get("sync-code-missing").hidden, true);
  assert.match(get("sync-devices").children.flatMap(rowTexts).join(" "), /revoked/);
  assert.equal(
    get("sync-devices")
      .children.flatMap((row) => row.children)
      .some((child) => child.textContent === "Remove"),
    false,
  );
  get("sync-show-code").click();
  await flush();
  assert.equal(text("sync-code"), REKEYED_CODE);
});

test("a failed removal keeps the confirmation and says why", async () => {
  await open(masterStatus);
  get("sync-devices")
    .children.flatMap((row) => row.children)
    .find((child) => child.textContent === "Remove")
    .click();
  backend.fail = { command: "remove_sync_device", error: { category: "master_required" } };
  get("sync-remove-device").click();
  await flush();
  assert.equal(get("sync-remove-confirm").hidden, false);
  assert.match(text("sync-error-message"), /Only the administrator/);
  assert.equal(get("sync-retry").hidden, true);
});

test("End Sync for all devices needs the typed word and ends in the start-over state", async () => {
  await open(masterStatus);
  get("sync-dissolve").click();
  assert.equal(get("sync-dissolve-confirm").hidden, false);
  assert.equal(document.activeElement, get("sync-dissolve-cancel"));
  assert.equal(get("sync-dissolve-submit").disabled, true);

  get("sync-dissolve-cancel").click();
  assert.equal(get("sync-dissolve-confirm").hidden, true);
  assert.equal(document.activeElement, get("sync-dissolve"));
  assert.equal(syncCalls("dissolve_sync").length, 0);

  get("sync-dissolve").click();
  get("sync-dissolve-word").value = "end";
  get("sync-dissolve-word").dispatchEvent(new Event("input"));
  assert.equal(get("sync-dissolve-submit").disabled, true);
  submit("sync-dissolve-confirm");
  await flush();
  assert.equal(syncCalls("dissolve_sync").length, 0);

  get("sync-dissolve-word").value = "END";
  get("sync-dissolve-word").dispatchEvent(new Event("input"));
  assert.equal(get("sync-dissolve-submit").disabled, false);
  submit("sync-dissolve-confirm");
  await flush();
  assert.equal(syncCalls("dissolve_sync").length, 1);
  assert.equal(get("sync-ended").hidden, false);
  assert.equal(get("sync-paired").hidden, true);
  assert.match(text("sync-status-detail"), /has ended for all devices/);
  assert.equal(document.activeElement, get("sync-start-over"));
});

test("leaving works offline, keeps saved data, manages focus and ends in the start-over state", async () => {
  await open(memberStatus);
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
  backend.onSyncNow = () => assert.fail("leaving must not need the server");
  get("sync-leave-confirm-button").click();
  await flush();
  assert.equal(syncCalls("leave_sync").length, 2);
  assert.equal(get("sync-leave-confirm").hidden, true);
  assert.equal(get("sync-ended").hidden, false);
  assert.equal(get("sync-unpaired").hidden, true);
  assert.equal(text("sync-status"), "This device is no longer syncing");
  assert.match(text("sync-status-detail"), /This device left the Sync/);
  assert.equal(document.activeElement, get("sync-start-over"));
  assert.equal(syncCalls("sync_now").length, 0);
  assert.equal(stateModule.state.history.length, 1);
});

test("every ended state explains itself once, offers no retry, and Start over returns to the choices", async () => {
  const expected = {
    revoked: /administrator removed this device/,
    closed: /has ended for all devices/,
    left: /This device left the Sync/,
    left_locally: /left while offline/,
    credential_replaced: /access to the Sync was replaced/,
  };
  for (const [state, pattern] of Object.entries(expected)) {
    await open(ended(state));
    assert.equal(get("sync-ended").hidden, false, state);
    assert.equal(get("sync-unpaired").hidden, true, state);
    assert.equal(get("sync-paired").hidden, true, state);
    assert.equal(get("sync-now").hidden, true, state);
    assert.equal(get("sync-scope").hidden, true, state);
    assert.match(text("sync-status-detail"), pattern, state);
    assert.match(text("sync-status-detail"), /stays here/, state);
    assert.equal(get("sync-retry").hidden, true, state);
    assert.equal(get("sync-button").dataset.sync, "attention", state);

    const before = syncCalls("leave_sync").length;
    get("sync-start-over").click();
    await flush();
    assert.equal(syncCalls("leave_sync").length, before + 1, state);
    assert.equal(get("sync-ended").hidden, true, state);
    assert.equal(get("sync-unpaired").hidden, false, state);
    assert.equal(text("sync-status"), "Sync is off", state);
    assert.equal(document.activeElement, get("sync-enable"), state);
    get("sync-dialog").close();
  }
});

test("a failed Start over keeps the ended state and the button", async () => {
  await open(ended("revoked"));
  backend.fail = { command: "leave_sync", error: { category: "persistence" } };
  get("sync-start-over").click();
  await flush();
  assert.equal(get("sync-ended").hidden, false);
  assert.match(text("sync-error-message"), /could not be saved/);
  assert.equal(document.activeElement, get("sync-start-over"));
});

test("an action that finds the Sync ended shows the reason and then the start-over state", async () => {
  await open(paired);
  backend.fail = { command: "sync_now", error: { category: "revoked" } };
  get("sync-now").click();
  backend.current = ended("revoked");
  await flush();
  assert.match(text("sync-error-message"), /administrator removed this device/);
  assert.equal(get("sync-retry").hidden, true);
  assert.equal(get("sync-ended").hidden, false);
});

const CATEGORIES = [
  "master_required",
  "master_cannot_leave",
  "no_code",
  "already_paired",
  "unpaired",
  "already_syncing",
  "pending_operation",
  "revoked",
  "left",
  "closed",
  "credential_replaced",
  "conflict",
  "offline",
  "timeout",
  "tls",
  "rate_limited",
  "server_error",
  "malformed_response",
  "not_found",
  "body_too_large",
  "rollback_detected",
  "secure_storage",
  "persistence",
  "corrupt_local_state",
  "invalid_remote_data",
  "invalid_endpoint",
  "unsupported_platform",
  "migration_pending",
  "operation_mismatch",
  "code_length",
  "code_word",
  "code_typo",
  "code_rejected",
];

test("every error category has its own calm copy and retry appears only where retrying can help", async () => {
  await open(paired);
  const notRetryable = new Set([
    "master_required",
    "master_cannot_leave",
    "no_code",
    "already_paired",
    "unpaired",
    "revoked",
    "left",
    "closed",
    "credential_replaced",
    "not_found",
    "body_too_large",
    "rollback_detected",
    "corrupt_local_state",
    "invalid_remote_data",
    "invalid_endpoint",
    "unsupported_platform",
    "operation_mismatch",
    "code_length",
    "code_word",
    "code_typo",
    "code_rejected",
  ]);
  const messages = new Set();
  for (const category of CATEGORIES) {
    backend.fail = { command: "sync_now", error: { category } };
    get("sync-now").click();
    await flush();
    const message = text("sync-error-message");
    assert.notEqual(message, "Sync could not complete. Try again.", category);
    assert.equal(get("sync-retry").hidden, notRetryable.has(category), category);
    messages.add(message);
  }
  assert.equal(messages.size, CATEGORIES.length);

  backend.fail = { command: "sync_now", error: { category: "code_word", details: 4 } };
  get("sync-now").click();
  await flush();
  assert.equal(text("sync-error-message"), "Word 5 is not a valid code word.");

  for (const category of ["invalid_remote_data", "rollback_detected"]) {
    backend.fail = { command: "sync_now", error: { category } };
    get("sync-now").click();
    await flush();
    assert.match(text("sync-error-message"), /not applied/);
    assert.doesNotMatch(text("sync-error-message"), /repair|overwrite|replace/i);
  }
  backend.fail = { command: "sync_now", error: { category: "mystery" } };
  get("sync-now").click();
  await flush();
  assert.equal(text("sync-error-message"), "Sync could not complete. Try again.");

  // Retry repeats the failed action and clears the error when it works.
  backend.fail = { command: "sync_now", error: { category: "offline" } };
  get("sync-now").click();
  await flush();
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
  await open(masterStatus);
  backend.fail = { command: "get_sync_code", error: { category: "unsupported_platform" } };
  get("sync-show-code").click();
  await flush();
  assert.match(text("sync-error-message"), /isn’t available on this device/);
  assert.equal(document.activeElement, get("sync-show-code"));
});

const joinErrors = [
  ["code_length", undefined, "The code has 24 words; this one has a different number."],
  ["code_word", 0, "Word 1 is not a valid code word."],
  ["code_word", 23, "Word 24 is not a valid code word."],
  ["code_typo", undefined, "The code has a typo. Check the words and their order."],
  ["code_rejected", undefined, /replaced.*Ask the administrator for the current code/],
  ["no_code", undefined, /no code yet.*New code/i],
];

for (const [category, details, expected] of joinErrors) {
  test(`a ${category}${details === undefined ? "" : ` at ${details}`} join error shows beside the field and keeps what was typed`, async () => {
    await open(unpaired);
    get("sync-show-join").click();
    await flush();
    choose("restore");
    backend.fail = { command: "join_sync", error: { category, details } };
    get("sync-code-input").value = TYPED_CODE;
    submit("sync-join-form");
    await flush();
    const shown = text("sync-code-error");
    if (typeof expected === "string") assert.equal(shown, expected);
    else assert.match(shown, expected);
    assert.equal(get("sync-code-error").hidden, false);
    assert.equal(get("sync-code-input").getAttribute("aria-invalid"), "true");
    assert.equal(get("sync-error").hidden, true);
    assert.equal(get("sync-retry").hidden, true);
    assert.equal(get("sync-code-input").value, TYPED_CODE);
    assert.equal(document.activeElement, get("sync-code-input"));
    assert.equal(get("sync-join-form").hidden, false);
    assert.equal(get("sync-paired").hidden, true);
    assert.notEqual(text("sync-status"), "Sync needs attention");

    get("sync-code-input").value = `${TYPED_CODE} fixed`;
    get("sync-code-input").dispatchEvent(new Event("input"));
    assert.equal(get("sync-code-error").hidden, true);
    assert.equal(get("sync-code-input").getAttribute("aria-invalid"), null);

    backend.fail = null;
    submit("sync-join-form");
    await flush();
    assert.equal(get("sync-paired").hidden, false);
    assert.equal(text("sync-code-error"), "");
  });
}

test("the join error region is a live alert next to the code field", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const form = html.split('id="sync-join-form"')[1].split("</form>")[0];
  assert.match(form, /<textarea[^>]*id="sync-code-input"[^>]*aria-describedby="[^"]*sync-code-error/);
  assert.match(form, /<p[^>]*id="sync-code-error"[^>]*role="alert"/);
  assert.match(form, /<label for="sync-code-input">/);
  assert.match(form, /autocapitalize="off"/);
  assert.match(form, /spellcheck="false"/);
});

test("joining sends the typed code exactly as typed apart from trimming, with the chosen mode", async () => {
  for (const mode of ["restore", "merge"]) {
    const start = joinCalls().length;
    await openJoin();
    assert.equal(document.activeElement, get("sync-code-input"));
    choose(mode);
    get("sync-code-input").value = TYPED_CODE;
    submit("sync-join-form");
    await flush();
    assert.deepEqual(joinCalls().slice(start), [{ code: TYPED_CODE.trim(), mode }]);
    assert.ok(TYPED_CODE.trim().includes("\n"));
    assert.ok(TYPED_CODE.trim().includes("ABANDON"));
    assert.equal(get("sync-paired").hidden, false);
    assert.equal(get("sync-code-input").value, "");
    assert.equal(document.activeElement, get("sync-now"));
    assert.equal(text("sync-code"), "");
    assert.equal(get("sync-code-panel").hidden, true);
    get("sync-dialog").close();
  }
  assert.equal(syncCalls("create_sync").length, 0);
});
test("a status failure is an error with a retry, never a status stuck on Checking", async () => {
  backend.statusFails = true;
  get("sync-button").click();
  await flush();
  assert.equal(get("sync-error").hidden, false);
  assert.match(text("sync-error-message"), /took too long/);
  assert.equal(text("sync-status"), "Could not check Sync status");
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
  assert.equal(text("sync-join"), "Join this Sync");
  assert.equal(get("sync-join-modes").hidden, false);
  assert.equal(get("sync-join-fresh").hidden, true);
  assert.equal(get("sync-join").disabled, true);
  choose("restore");
  assert.equal(restoreOption().checked, true);
  assert.equal(get("sync-join").disabled, false);
  get("sync-code-input").value = CODE;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls(), [{ code: CODE, mode: "restore" }]);
  assert.equal(get("sync-paired").hidden, false);
  assert.equal(get("sync-join-form").hidden, true);
});

test("choosing Merge sends merge, and the label never decides the mode", async () => {
  await openJoin();
  choose("merge");
  assert.equal(get("sync-join").disabled, false);
  assert.equal(text("sync-join"), "Merge this device");
  get("sync-code-input").value = CODE;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls(), [{ code: CODE, mode: "merge" }]);

  // A relabelled button cannot change what Restore means.
  backend.current = structuredClone(unpaired);
  await open(unpaired);
  get("sync-show-join").click();
  await flush();
  assert.equal(restoreOption().checked, false);
  choose("restore");
  get("sync-join").textContent = "Merge this device";
  get("sync-code-input").value = CODE;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls().at(-1), { code: CODE, mode: "restore" });
});

test("Enter/form submission without a choice cannot Restore or Merge, regardless of button text", async () => {
  await openJoin();
  assert.equal(restoreOption().checked, false);
  assert.equal(mergeOption().checked, false);
  assert.equal(get("sync-join").disabled, true);
  get("sync-join").textContent = "Restore this device";
  get("sync-code-input").value = CODE;
  submit("sync-join-form");
  await flush();
  assert.equal(syncCalls("join_sync").length, 0);
  assert.match(text("sync-error-message"), /Choose how this device should join/);
  assert.equal(document.activeElement, restoreOption());
  assert.equal(get("sync-code-input").value, CODE);
});

test("a submit while the summary is still loading cannot join even with a selected radio", async () => {
  await open(unpaired);
  get("sync-show-join").click();
  choose("restore");
  get("sync-code-input").value = CODE;
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
    `This device currently has 3 history items, 1 saved frame, ${count(1217)} previous deletions.`,
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
  get("sync-code-input").value = CODE;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls(), [{ code: CODE, mode: "restore" }]);
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
  get("sync-code-input").value = CODE;
  submit("sync-join-form");
  await flush();
  assert.deepEqual(joinCalls(), [{ code: CODE, mode: "merge" }]);
});

test("a failed join preserves either explicit choice for retry, then success resets to neutral", async () => {
  for (const mode of ["restore", "merge"]) {
    const start = joinCalls().length;
    await openJoin();
    choose(mode);
    get("sync-code-input").value = CODE;
    backend.fail = { command: "join_sync", error: { category: "timeout" } };
    submit("sync-join-form");
    await flush();
    assert.equal(get("sync-join-form").hidden, false);
    assert.equal(mergeOption().checked, mode === "merge");
    assert.equal(restoreOption().checked, mode === "restore");
    assert.equal(get("sync-join").disabled, false);
    assert.equal(get("sync-code-input").value, CODE);
    assert.equal(get("sync-retry").hidden, false);
    backend.fail = null;
    get("sync-retry").click();
    await flush();
    assert.deepEqual(joinCalls().slice(start), [
      { code: CODE, mode },
      { code: CODE, mode },
    ]);
    assert.equal(get("sync-paired").hidden, false);
    assert.equal(restoreOption().checked, false);
    assert.equal(mergeOption().checked, false);
  }
});

test("Restore reloads replaced views when saving this device’s Sync settings fails", async () => {
  const stage = await import("../dist/test-client/stage.js");
  for (const category of ["secure_storage", "persistence"]) {
    const oldItem = { source: "prntsc", id: "oldlocal", sourcePageUrl: "https://prnt.sc/oldlocal", viewedAt: 1 };
    stateModule.applyHistory({ history: [oldItem], index: 0 });
    stateModule.applySavedLibrary(libraryOf([{ ...oldItem, addedAt: 1 }]));
    await openJoin();
    choose("restore");
    get("sync-code-input").value = CODE;
    // Native Restore replaces the stores before saving credentials and sync-config.
    backend.onJoin = () => {
      backend.history = [];
      backend.favorites = [];
    };
    backend.fail = { command: "join_sync", error: { category } };
    stage.startLoading();
    submit("sync-join-form");
    await flush();
    assert.equal(stateModule.state.history[0].id, "oldlocal");
    stage.finishLoading();
    await flush();
    assert.deepEqual(stateModule.state.history, []);
    assert.deepEqual(stateModule.state.favorites, []);
    assert.equal(stateModule.state.index, -1);
    assert.equal(get("favorite-button").disabled, true);
    assert.equal(get("sync-retry").hidden, false);
    assert.match(text("sync-error-message"), category === "secure_storage" ? /secure storage/ : /could not be saved/);
    assert.equal(get("sync-code-input").value, CODE);
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
  get("sync-code-input").value = CODE;
  get("sync-join-cancel").click();
  assert.equal(get("sync-join-form").hidden, true);
  assert.equal(get("sync-code-input").value, "");
  assert.equal(restoreOption().checked, false);
  assert.equal(mergeOption().checked, false);
  assert.equal(syncCalls("join_sync").length, 0);
});

test("the options are native radios with labelled consequences for assistive technology", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const form = html.split('id="sync-join-form"')[1].split("</form>")[0];
  assert.match(form, /<fieldset[^>]*id="sync-join-modes"/);
  assert.match(form, /<legend[^>]*>How should this device join\?<\/legend>/);
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
  const form = html.split('id="sync-connect-title"')[1].split('id="sync-ended"')[0];
  const copy = form.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const phrase of [
    "Enter the 24-word code from the administrator’s device.",
    "Restore this device from Sync",
    "Replace this device’s synced data with the copy already in Sync.",
    "Local history, saved frames, collections and their previous deletions will not be added to Sync.",
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

test("confirmations explain what changes before anything happens", async () => {
  const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
  const section = (id, end) =>
    html
      .split(`id="${id}"`)[1]
      .split(end)[0]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  const newCode = section("sync-newcode-confirm", "</section>");
  assert.match(newCode, /The current code stops working\./);
  assert.match(newCode, /Devices that haven’t joined yet will need the new code\./);
  assert.match(newCode, /Devices already in this Sync aren’t affected\./);
  const remove = section("sync-remove-confirm", "</section>");
  assert.match(remove, /The Sync key changes, so this device stops syncing\./);
  assert.match(remove, /A new code is created, and the old code stops working\./);
  const dissolve = section("sync-dissolve-confirm", "</form>");
  assert.match(dissolve, /This ends Sync on every device, including this one, and the code stops working\./);
  assert.match(dissolve, /Type END to confirm/);
  const leave = section("sync-leave-confirm", "<footer");
  assert.match(leave, /To join again, you’ll need the current code from the administrator\./);
  const ended = section("sync-ended", "</section>");
  assert.match(ended, /Start over/);
  assert.match(section("sync-code-missing", "</p>"), /No code yet\./);
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

test("joining names the actual operation while controls are disabled", async () => {
  await openJoin();
  choose("restore");
  get("sync-code-input").value = CODE;
  submit("sync-join-form");
  assert.equal(text("sync-join"), "Restoring this device…");
  assert.equal(text("sync-status"), "Restoring this device…");
  assert.equal(get("sync-join").disabled, true);
  await flush();
  assert.equal(get("sync-join-actions").hidden, true);
});

test("disclosures expose content immediately, exclude collapsed controls, and reverse repeated toggles", () => {
  disclosureToggle.click();
  assert.equal(disclosureToggle.getAttribute("aria-expanded"), "true");
  assert.equal(disclosureBody.inert, false);
  disclosureInput.focus();
  disclosureToggle.click();
  assert.equal(disclosureToggle.getAttribute("aria-expanded"), "false");
  assert.equal(disclosureBody.inert, true);
  assert.equal(document.activeElement, disclosureToggle);
  disclosureToggle.click();
  disclosureToggle.click();
  disclosureToggle.click();
  assert.equal(disclosureToggle.getAttribute("aria-expanded"), "true");
  assert.equal(disclosureBody.inert, false);
  disclosureToggle.click();
});

test("only the current Sync commands are called or referenced by the Sync client", async () => {
  const allowed = new Set([
    "get_sync_status",
    "create_sync",
    "join_sync",
    "get_sync_join_summary",
    "sync_now",
    "startup_sync",
    "leave_sync",
    "get_sync_code",
    "new_sync_code",
    "remove_sync_device",
    "dissolve_sync",
  ]);
  const used = [...everyCommand].filter((command) => /sync/.test(command) && !command.startsWith("plugin:"));
  assert.deepEqual(
    used.filter((command) => !allowed.has(command)),
    [],
  );
  for (const file of ["sync-api.js", "sync-dialog.js"]) {
    const source = await readFile(new URL(`../dist/test-client/${file}`, import.meta.url), "utf8");
    const referenced = [...source.matchAll(/"([a-z]+(?:_[a-z]+)+)"/g)]
      .map((match) => match[1])
      .filter((name) => /sync/.test(name));
    assert.deepEqual(
      referenced.filter((name) => !allowed.has(name)),
      [],
      file,
    );
  }
});
