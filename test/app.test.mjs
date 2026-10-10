import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids, testCapabilities } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const keydown = (target, key) => {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  target.dispatchEvent(event);
};

test("persistent history, the info line, the draw ledger, and the lightbox", async (t) => {
  const document = new FakeDocument(ids);
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const performance = { getEntriesByType: () => [{ type: "back_forward" }] };
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  // Toasts schedule their own dismissal; the test never waits for it.
  let toastExpiry;
  let favoriteTip;
  window.setTimeout = (callback, delay) => {
    if (delay === 4000) {
      favoriteTip = callback;
      return 0;
    }
    toastExpiry = callback;
    return 0;
  };
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  localStorage.setItem("random-frame-viewing-stats", JSON.stringify({ day: "2026-10-02", today: 1, total: 2 }));
  sessionStorage.setItem(
    "prntsc-gallery-history",
    JSON.stringify({ history: [{ id: "saved1" }, { id: "saved2" }], index: 1 }),
  );

  Object.assign(globalThis, { document, localStorage, performance, sessionStorage, window });
  const todayIso = new Date().toLocaleDateString("en-CA");
  let draw = 0;
  let savePath = null;
  let failNextDraw = false;
  let brokenNextImage = false;
  let failStats = false;
  let failNextCommitClear = false;
  const invocations = [];
  let persisted = { history: [], index: -1 };
  let finishStartupSync;
  const startupSync = new Promise((resolve) => {
    finishStartupSync = resolve;
  });
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args, options) {
      if (command === "get_platform_capabilities") return testCapabilities;
      if (command === "complete_state_imports") {
        invocations.push({ command, args });
        return null;
      }
      if (command === "get_user_preferences" || command === "set_user_preferences") {
        invocations.push({ command, args });
        return { theme: null, historyPageSize: null };
      }
      if (command === "import_session_history") {
        invocations.push({ command, args });
        if (!persisted.history.length) persisted = { history: structuredClone(args.items), index: args.index };
        return structuredClone(persisted);
      }
      invocations.push({ command, args, options });
      if (command === "get_history") return structuredClone(persisted);
      if (command === "startup_sync") return startupSync;
      if (command === "get_sync_status")
        return { paired: false, state: "unpaired", lastSuccessRevision: null, dirty: true, lastErrorCategory: null };
      if (command === "get_favorites") return [];
      if (command === "record_history_item") {
        let itemIndex = persisted.history.findIndex(
          (item) => item.source === args.item.source && item.id === args.item.id,
        );
        if (itemIndex === -1) {
          persisted.history.push(args.item);
          itemIndex = persisted.history.length - 1;
        }
        persisted.index = itemIndex;
        return structuredClone(persisted);
      }
      if (command === "select_history_item") {
        persisted.index = args.index;
        return structuredClone(persisted);
      }
      if (command === "prepare_history_clear") return "clear-request-1";
      if (command === "commit_history_clear") {
        if (failNextCommitClear) {
          failNextCommitClear = false;
          throw new Error("Could not commit clear");
        }
        persisted = { history: [], index: -1 };
        return null;
      }
      if (command === "get_exploration_stats") {
        if (failStats) throw new Error("unreadable");
        return { explored: 12_483, total: 4_773_622_240, viewable: 8_000, unavailable: 4_483, unclassified: 0 };
      }
      if (command === "get_viewing_activity") {
        return {
          viewedTotal: 2,
          days: [{ date: todayIso, viewed: 2, rejected: 0 }],
          localViewTimes: persisted.history.map((item) => item.viewedAt),
        };
      }
      if (command === "migrate_viewing_stats") return null;
      if (command === "get_random_frame") {
        if (failNextDraw) {
          failNextDraw = false;
          throw { kind: "network", message: "The source could not be reached" };
        }
        draw += 1;
        const id = ["abc123", "def456"][draw - 1] ?? `new${draw}`;
        return { id, source: "prntsc", sourcePageUrl: `https://prnt.sc/${id}`, mimeType: "image/jpeg" };
      }
      if (command === "get_frame_by_id") {
        return {
          id: args.id,
          source: "prntsc",
          sourcePageUrl: `https://prnt.sc/${args.id}`,
          mimeType: "image/png",
        };
      }
      if (command === "get_frame_image") {
        const byte = brokenNextImage ? 255 : draw;
        brokenNextImage = false;
        return new Uint8Array([byte]).buffer;
      }
      if (command === "plugin:dialog|save") return savePath;
      if (command === "plugin:fs|write_file") return null;
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  t.after(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  await import(`../dist/test-client/app.js?test=${Date.now()}`);
  const get = (id) => document.querySelector(`#${id}`);
  const historyWrites = () => invocations.filter(({ command }) => command === "record_history_item").length;
  await flush();
  await flush();
  await flush();
  assert.ok(invocations.some(({ command }) => command === "startup_sync"));
  for (const command of ["import_session_history", "migrate_viewing_stats", "set_user_preferences"]) {
    assert.ok(
      invocations.findIndex((call) => call.command === command) <
        invocations.findIndex((call) => call.command === "complete_state_imports"),
      command,
    );
  }
  assert.ok(
    invocations.findIndex(({ command }) => command === "complete_state_imports") <
      invocations.findIndex(({ command }) => command === "startup_sync"),
  );
  assert.ok(
    invocations.findIndex(({ command }) => command === "import_session_history") <
      invocations.findIndex(({ command }) => command === "startup_sync"),
  );
  assert.ok(
    invocations.findIndex(({ command }) => command === "startup_sync") <
      invocations.findIndex(({ command }) => command === "get_frame_by_id"),
  );
  assert.match(get("image").alt, /saved2/);
  assert.deepEqual(
    invocations.find(({ command }) => command === "import_session_history").args.items.map((item) => item.id),
    ["saved1", "saved2"],
  );
  finishStartupSync({
    paired: false,
    state: "unpaired",
    lastSuccessRevision: null,
    dirty: true,
    lastErrorCategory: null,
  });

  get("history-tool-button").click();
  assert.equal(get("history-dialog").open, true);
  assert.equal(get("history-grid").children.length, 2);
  assert.match(get("image").alt, /saved2/);
  // Pre-pagination users have no page-size setting; a short history keeps only the compact pager row and nothing is written.
  assert.equal(get("history-pager-nav").hidden, true);
  assert.equal(get("history-pager").getAttribute("data-compact"), "");
  assert.equal(get("history-page-size").value, "25");
  assert.equal(localStorage.getItem("random-frame-history-page-size"), null);

  get("history-close-button").click();
  assert.equal(get("history-dialog").open, false);
  // History returns focus to its titlebar button.
  assert.equal(document.activeElement, get("history-tool-button"));

  // Arrows only walk history: on the newest frame → points at Draw instead of drawing.
  assert.equal(get("frame-count-current").textContent, "2");
  assert.equal(get("frame-count-total").textContent, "2");
  // The newest frame drops Next rather than showing it disabled; the count carries the position.
  assert.equal(get("next-button").hidden, true);
  keydown(document, "ArrowRight");
  await flush();
  assert.equal("pulse" in get("draw-button").dataset, true);
  assert.match(get("announcer").textContent, /Press N to draw another/);
  assert.equal(invocations.filter(({ command }) => command === "get_random_frame").length, 0);

  get("draw-button").click();
  await flush();
  await flush();
  keydown(document, "n");
  await flush();
  await flush();
  // The first-draw tip waits for the image to settle.
  assert.equal(localStorage.getItem("random-frame-favorite-tip"), null);
  favoriteTip();
  assert.equal(localStorage.getItem("random-frame-favorite-tip"), "shown");
  assert.match(document.body.children.flatMap((region) => region.children).at(-1).textContent, /press F to favorite/);
  assert.equal(get("frame-count-current").textContent, "4");
  assert.equal(get("image-id-value").textContent, "def456");
  assert.equal(get("draw-button").getAttribute("aria-busy"), "false");
  assert.equal(historyWrites(), 2);
  assert.deepEqual(
    invocations.filter(({ command }) => command === "record_history_item").map(({ args }) => args.legacyImport),
    [false, false],
  );

  keydown(document, "t");
  await flush();
  assert.equal(get("stats-dialog").open, true);
  assert.equal(get("stats-today").textContent, "2");
  assert.equal(get("stats-total").textContent, "2");
  assert.equal(get("stats-streak").textContent, "1 day");
  assert.equal(get("stats-explored").textContent, "12,483");
  assert.equal(get("stats-explored-breakdown").textContent, "8,000 drawn · 4,483 unavailable");
  // One ledger row for today; frames shown this session (saved2, abc123, def456) have thumbnails, newest first.
  assert.equal(get("ledger-list").children.length, 1);
  assert.equal(get("ledger-empty").hidden, true);
  assert.equal(get("ledger-more").hidden, true);
  const [row] = get("ledger-list").children;
  assert.equal(row.getAttribute("aria-label"), "Today: 2 drawn");
  const strip = row.children[2];
  assert.deepEqual(
    strip.children.map((child) => child.getAttribute("aria-label") ?? child.textContent),
    ["Show frame 4, def456", "Show frame 3, abc123", "Show frame 2, saved2", "+1"],
  );
  // A thumbnail jumps straight to its frame in history.
  strip.children[1].click();
  assert.equal(get("stats-dialog").open, false);
  await flush();
  await flush();
  assert.match(get("image").alt, /abc123/);
  assert.equal(get("frame-count-current").textContent, "3");
  get("stats-button").click();
  await flush();
  get("stats-close-button").click();
  assert.equal(document.activeElement, get("tools-menu-button"));

  // Unreadable stats show dashes, not zeros, and recover through Try again.
  failStats = true;
  get("stats-button").click();
  await flush();
  assert.equal(get("stats-explored").textContent, "Unavailable");
  assert.equal(get("stats-today").textContent, "—");
  assert.equal(get("stats-error").hidden, false);
  assert.equal(get("ledger").hidden, true);
  failStats = false;
  get("stats-retry").click();
  await flush();
  assert.equal(get("stats-today").textContent, "2");
  assert.equal(get("stats-error").hidden, true);
  assert.equal(get("ledger").hidden, false);
  get("stats-close-button").click();

  get("history-tool-button").click();
  assert.equal(get("history-grid").children.length, 4);
  // Newest first: def456, abc123 (shown), saved2, saved1.
  assert.equal(get("history-grid").children[1].children[0].getAttribute("aria-current"), "true");
  assert.equal(sessionStorage.getItem("prntsc-gallery-history"), null);
  assert.deepEqual(
    persisted.history.map(({ source, id }) => ({ source, id })),
    [
      { source: "prntsc", id: "saved1" },
      { source: "prntsc", id: "saved2" },
      { source: "prntsc", id: "abc123" },
      { source: "prntsc", id: "def456" },
    ],
  );

  get("dialog-backdrop").click();
  assert.equal(get("history-dialog").open, false);

  get("history-tool-button").click();
  get("history-grid").children[3].children[0].click();
  assert.equal(get("history-dialog").open, false);
  await flush();
  await flush();
  assert.match(get("image").alt, /saved1/);
  assert.equal(historyWrites(), 2);

  get("save-button").click();
  await flush();
  assert.equal(invocations.at(-1).command, "plugin:dialog|save");
  // A cancelled dialog is not a save: no check.
  assert.equal(get("save-button").dataset.saved, undefined);

  savePath = "/tmp/random-frame-prntsc-saved1.png";
  get("save-button").click();
  await flush();
  await flush();
  assert.equal(invocations.at(-2).command, "plugin:dialog|save");
  assert.equal(invocations.at(-2).args.options.defaultPath, "random-frame-prntsc-saved1.png");
  assert.equal(invocations.at(-1).command, "plugin:fs|write_file");
  assert.deepEqual([...invocations.at(-1).args], [2]);
  assert.equal(get("save-button").dataset.saved, "new");

  get("jump-input").value = "4";
  get("jump-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  assert.match(get("image").alt, /def456/);

  get("image-zoom").click();
  assert.equal(get("lightbox-dialog").open, true);
  const escapeKey = new Event("keydown");
  Object.defineProperty(escapeKey, "key", { value: "Escape" });
  document.dispatchEvent(escapeKey);
  assert.equal(get("lightbox-dialog").open, false);
  get("image-zoom").click();
  get("lightbox-dialog").click();
  assert.equal(get("lightbox-dialog").open, false);

  // ? toggles the shortcut sheet; while it is open, frame keys stay inert.
  keydown(document, "?");
  assert.equal(get("shortcuts-dialog").open, true);
  keydown(document, "h");
  assert.equal(get("history-dialog").open, false);
  keydown(document, "?");
  assert.equal(get("shortcuts-dialog").open, false);
  keydown(document, "H");
  assert.equal(get("history-dialog").open, true);
  get("history-close-button").click();
  const writesBefore = invocations.filter(({ command }) => command === "plugin:fs|write_file").length;
  keydown(document, "s");
  await flush();
  await flush();
  assert.equal(invocations.filter(({ command }) => command === "plugin:fs|write_file").length, writesBefore + 1);

  // Draw always draws, even mid-history: the frame joins the end and the view jumps to it.
  get("jump-input").value = "1";
  get("jump-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  await flush();
  assert.match(get("image").alt, /saved1/);
  get("draw-button").click();
  await flush();
  await flush();
  assert.match(get("image").alt, /new3/);
  assert.equal(get("frame-count-current").textContent, "5");
  assert.equal(get("frame-count-total").textContent, "5");

  // A failed draw explains itself, hides actions for the unseen frame, and can return to the last frame.
  failNextDraw = true;
  get("draw-button").click();
  await flush();
  await flush();
  assert.equal(get("error-state").hidden, false);
  assert.equal(get("error-title").textContent, "Prnt.sc could not be reached.");
  assert.equal(get("save-button").disabled, true);
  assert.equal(get("retry-button").textContent, "Try again");
  assert.equal(get("image-zoom").hidden, false);
  assert.equal(get("back-button").hidden, false);
  assert.equal(get("back-button").textContent, "Keep viewing frame 5");
  get("back-button").click();
  await flush();
  await flush();
  assert.equal(get("error-state").hidden, true);
  assert.match(get("image").alt, /new3/);
  assert.equal(get("save-button").disabled, false);

  // Cooldown keeps retry visible, blocks it, and uses an info notice while browsing history.
  const stage = await import("../dist/test-client/stage.js");
  const now = Date.now;
  let clock = now() - 10001;
  Date.now = () => clock;
  try {
    let retried = false;
    stage.showError({ kind: "upstream-rate-limited" }, async () => {
      retried = true;
    });
    stage.syncControls();
    assert.equal(get("retry-button").hidden, false);
    assert.equal(get("retry-button").textContent, "Try again in 10s");
    assert.equal(get("retry-button").getAttribute("aria-disabled"), "true");
    get("retry-button").click();
    assert.equal(retried, false);
    get("back-button").click();
    await flush();
    stage.drawPaused();
    const notice = document.body.children.filter((element) => element.className === "toast-region").at(-1).children[0];
    assert.equal(notice.className, "toast toast--info");
    assert.equal(notice.textContent, "Drawing resumes in 10s");
    clock += 10001;
    stage.syncControls();
    assert.equal(get("retry-button").textContent, "Try again");
    assert.equal(get("retry-button").getAttribute("aria-disabled"), "false");
    // Let the cooldown interval retire before restoring the real clock.
    await new Promise((resolve) => setTimeout(resolve, 1050));
  } finally {
    Date.now = now;
  }

  // An image that will not decode stays out of history, so the counter keeps pointing at a frame that shows.
  brokenNextImage = true;
  get("draw-button").click();
  await flush();
  await flush();
  await flush();
  assert.equal(get("error-state").hidden, false);
  assert.equal(get("error-title").textContent, "This frame would not open.");
  assert.equal(get("frame-count-current").textContent, "5");
  assert.equal(get("frame-count-total").textContent, "5");
  assert.equal(persisted.history.length, 5);
  assert.equal(historyWrites(), 3);
  get("back-button").click();
  await flush();
  await flush();
  assert.match(get("image").alt, /new3/);

  // Review is persistent and harmless; completion is an explicit second activation.
  const clearButton = get("history-clear-button");
  const clears = () => invocations.filter(({ command }) => command === "commit_history_clear").length;
  const prepares = () => invocations.filter(({ command }) => command === "prepare_history_clear").length;
  const historyDialog = get("history-dialog");
  const action = (label) =>
    historyDialog.children
      .flatMap((region) => region.children)
      .flatMap((notice) => notice.children)
      .findLast((button) => button.textContent === label);
  get("history-tool-button").click();
  const beforeClear = structuredClone(persisted);
  clearButton.click();
  await flush();
  assert.equal(prepares(), 0);
  assert.equal(clears(), 0);
  assert.equal(get("draw-button").getAttribute("aria-disabled"), "true");
  assert.equal(get("frame-count-total").textContent, "5");
  action("Finish clearing").click();
  await flush();
  assert.equal(clears(), 0, "double activation cannot confirm review immediately");
  toastExpiry?.();
  assert.deepEqual(persisted, beforeClear, "toast expiry cannot delete data");
  keydown(document, "z");
  await flush();
  await flush();
  assert.equal(prepares(), 0, "Undo before completion requires no durable transaction");
  assert.equal(get("draw-button").getAttribute("aria-disabled"), "false");
  clearButton.click();
  get("history-close-button").click();
  assert.deepEqual(persisted, beforeClear);
  assert.equal(get("draw-button").getAttribute("aria-disabled"), "false", "closing safely cancels review");

  get("history-tool-button").click();
  clearButton.click();
  await new Promise((resolve) => setTimeout(resolve, 520));
  failNextCommitClear = true;
  action("Finish clearing").click();
  await flush();
  await flush();
  assert.equal(clears(), 1);
  assert.equal(get("draw-button").getAttribute("aria-disabled"), "true");
  assert.equal(historyDialog.dataset.busy, "true");
  assert.equal(action("Undo").hidden, true, "confirmed clearing no longer offers cancellation");
  keydown(document, "z");
  await flush();
  assert.equal(get("draw-button").getAttribute("aria-disabled"), "true", "confirmed transaction cannot be abandoned");
  action("Finish clearing").click();
  await flush();
  await flush();
  assert.equal(prepares(), 1, "retry preserves the frozen operation set");
  assert.equal(clears(), 2);
  assert.deepEqual(persisted, { history: [], index: -1 });
  assert.equal(get("frame-count-total").textContent, "0");
  assert.equal(document.activeElement, get("draw-button"));
  assert.equal(get("source-link").getAttribute("href"), null);
  assert.equal(get("draw-button").getAttribute("aria-disabled"), "false");
  const commits = invocations.filter(({ command }) => command === "commit_history_clear");
  assert.deepEqual(commits.at(-1).args, commits.at(-2).args);
});

test("migrates the legacy localStorage counter once on startup and clears it", async (t) => {
  const document = new FakeDocument(ids);
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const performance = { getEntriesByType: () => [{ type: "back_forward" }] };
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  const legacyDay = new Date().toLocaleDateString("en-CA");
  localStorage.setItem("random-frame-viewing-stats", JSON.stringify({ day: legacyDay, today: 5, total: 42 }));

  Object.assign(globalThis, { document, localStorage, performance, sessionStorage, window });
  const invocations = [];
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      if (command === "get_platform_capabilities") return testCapabilities;
      if (command === "complete_state_imports") return null;
      if (command === "get_user_preferences" || command === "set_user_preferences")
        return { theme: null, historyPageSize: null };
      if (command === "import_session_history") return { history: [], index: -1 };
      invocations.push({ command, args });
      if (command === "get_history") return { history: [], index: -1 };
      if (command === "get_favorites") return [];
      if (command === "migrate_viewing_stats") return null;
      throw new Error(`Unexpected command: ${command}`);
    },
  };
  t.after(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  await import(`../dist/test-client/app.js?test=${Date.now()}`);
  await new Promise((resolve) => setImmediate(resolve));

  const migration = invocations.find(({ command }) => command === "migrate_viewing_stats");
  assert.deepEqual(migration?.args, { legacyDay, legacyToday: 5, legacyTotal: 42 });
  assert.equal(localStorage.getItem("random-frame-viewing-stats"), null);
});
