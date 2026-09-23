import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

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
  window.setTimeout = () => 0;
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  sessionStorage.setItem(
    "prntsc-gallery-history",
    JSON.stringify({ history: [{ id: "saved1" }, { id: "saved2" }], index: 1 }),
  );

  Object.assign(globalThis, { document, localStorage, performance, sessionStorage, window });
  const todayIso = new Date().toLocaleDateString("en-CA");
  let draw = 0;
  let savePath = null;
  let failNextDraw = false;
  let failStats = false;
  const invocations = [];
  let persisted = { history: [], index: -1 };
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args, options) {
      invocations.push({ command, args, options });
      if (command === "get_history") return structuredClone(persisted);
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
      if (command === "clear_history") {
        persisted = { history: [], index: -1 };
        return null;
      }
      if (command === "get_exploration_stats") {
        if (failStats) throw new Error("unreadable");
        return { explored: 12_483, total: 4_773_622_240, viewable: 8_000, unavailable: 4_483 };
      }
      if (command === "get_viewing_activity") {
        return { viewedTotal: 2, days: [{ date: todayIso, viewed: 2, rejected: 0 }] };
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
      if (command === "get_frame_image") return new Uint8Array([draw]).buffer;
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
  await flush();
  await flush();
  await flush();

  get("history-button").click();
  assert.equal(get("history-dialog").open, true);
  assert.equal(get("history-grid").children.length, 2);
  assert.match(get("image").alt, /saved2/);
  // Pre-pagination users have no page-size setting; a short history shows no pager and nothing is written.
  assert.equal(get("history-pager").hidden, true);
  assert.equal(get("history-page-size").value, "25");
  assert.equal(localStorage.getItem("random-frame-history-page-size"), null);

  get("history-close-button").click();
  assert.equal(get("history-dialog").open, false);
  assert.equal(document.activeElement, get("history-button"));

  // Arrows only walk history: on the newest frame → points at Draw next instead of drawing.
  assert.equal(get("position-current").textContent, "2");
  assert.equal(get("history-total").textContent, "2");
  assert.equal(get("next-button").getAttribute("aria-disabled"), "true");
  keydown(document, "ArrowRight");
  await flush();
  assert.equal("pulse" in get("draw-button").dataset, true);
  assert.match(get("announcer").textContent, /Press N to draw next/);
  assert.equal(invocations.filter(({ command }) => command === "get_random_frame").length, 0);

  get("draw-button").click();
  await flush();
  await flush();
  keydown(document, "n");
  await flush();
  await flush();
  assert.equal(get("position-current").textContent, "4");
  assert.equal(get("image-id-value").textContent, "def456");
  assert.equal(get("draw-button").getAttribute("aria-busy"), "false");

  get("stats-button").click();
  await flush();
  assert.equal(get("stats-dialog").open, true);
  assert.equal(get("stats-today").textContent, "2");
  assert.equal(get("stats-total").textContent, "2");
  assert.equal(get("stats-explored").textContent, "12,483 / 4,773,622,240");
  assert.equal(get("stats-explored-percent").textContent, "< 0.001% of known legacy ID space");
  assert.equal(get("stats-explored-breakdown").textContent, "8,000 viewable · 4,483 unavailable");
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
  assert.equal(get("position-current").textContent, "3");
  get("stats-button").click();
  await flush();
  get("stats-close-button").click();
  assert.equal(document.activeElement, get("stats-button"));

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

  get("history-button").click();
  assert.equal(get("history-grid").children.length, 4);
  assert.equal(get("history-grid").children[2].getAttribute("aria-current"), "true");
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

  get("history-button").click();
  get("history-grid").children[0].click();
  assert.equal(get("history-dialog").open, false);
  await flush();
  await flush();
  assert.match(get("image").alt, /saved1/);

  get("save-button").click();
  await flush();
  assert.equal(invocations.at(-1).command, "plugin:dialog|save");

  savePath = "/tmp/random-frame-prntsc-saved1.png";
  get("save-button").click();
  await flush();
  await flush();
  assert.equal(invocations.at(-2).command, "plugin:dialog|save");
  assert.equal(invocations.at(-2).args.options.defaultPath, "random-frame-prntsc-saved1.png");
  assert.equal(invocations.at(-1).command, "plugin:fs|write_file");
  assert.deepEqual([...invocations.at(-1).args], [2]);

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

  // Draw next always draws, even mid-history: the frame joins the end and the view jumps to it.
  get("jump-input").value = "1";
  get("jump-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  await flush();
  assert.match(get("image").alt, /saved1/);
  get("draw-button").click();
  await flush();
  await flush();
  assert.match(get("image").alt, /new3/);
  assert.equal(get("position-current").textContent, "5");
  assert.equal(get("history-total").textContent, "5");

  // A failed draw explains itself, hides actions for the unseen frame, and can return to the last frame.
  failNextDraw = true;
  get("draw-button").click();
  await flush();
  await flush();
  assert.equal(get("error-state").hidden, false);
  assert.equal(get("error-title").textContent, "Prnt.sc could not be reached.");
  assert.equal(get("save-button").disabled, true);
  assert.equal(get("back-button").hidden, false);
  assert.equal(get("back-button").textContent, "Show frame 5");
  get("back-button").click();
  await flush();
  await flush();
  assert.equal(get("error-state").hidden, true);
  assert.match(get("image").alt, /new3/);
  assert.equal(get("save-button").disabled, false);

  // Clearing is hold-to-confirm: the completed fill transition clears, releasing early does not.
  const clearButton = get("history-clear-button");
  const clears = () => invocations.filter(({ command }) => command === "clear_history").length;
  const press = () => {
    const event = new Event("pointerdown");
    Object.defineProperty(event, "button", { value: 0 });
    clearButton.dispatchEvent(event);
  };
  const release = () => {
    clearButton.dispatchEvent(new Event("pointerup"));
    clearButton.click();
  };
  const fill = () => {
    const event = new Event("transitionend");
    Object.defineProperty(event, "pseudoElement", { value: "::before" });
    clearButton.dispatchEvent(event);
  };
  get("history-button").click();
  press();
  release();
  fill();
  await flush();
  assert.equal(clears(), 0);
  press();
  fill();
  release();
  await flush();
  assert.deepEqual(persisted, { history: [], index: -1 });
  assert.equal(get("history-total").textContent, "0");
  assert.equal(clearButton.disabled, true);
  get("draw-button").click();
  await flush();
  await flush();
  assert.equal(clearButton.disabled, false);
  // Assistive tech clicks without a press: the first activation arms, the second clears.
  clearButton.click();
  await flush();
  assert.equal(clears(), 1);
  assert.equal(get("announcer").textContent, "Activate again to clear history");
  clearButton.click();
  await flush();
  assert.equal(clears(), 2);
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
      invocations.push({ command, args });
      if (command === "get_history") return { history: [], index: -1 };
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
