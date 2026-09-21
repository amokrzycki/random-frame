import assert from "node:assert/strict";
import test from "node:test";
import { heatmapPlaceholderCount, heatmapRangeLabel, leadingBlankCount } from "../dist/test-client/statistics.js";

class FakeElement extends EventTarget {
  constructor(document) {
    super();
    this.document = document;
    this.attributes = new Map();
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.open = false;
    this.checked = false;
    this.value = "";
    this.src = "";
    this.href = "";
    this.textContent = "";
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  focus() {
    this.document.activeElement = this;
  }

  click() {
    this.dispatchEvent(new Event("click"));
  }

  show() {
    this.open = true;
  }

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  }

  setCustomValidity() {
    // Form validation is outside this history-flow test.
  }

  reportValidity() {
    // Form validation is outside this history-flow test.
  }

  get offsetWidth() {
    return 1;
  }
}

class FakeDocument extends EventTarget {
  constructor(ids) {
    super();
    this.activeElement = null;
    this.elements = new Map(ids.map((id) => [`#${id}`, new FakeElement(this)]));
    this.body = new FakeElement(this);
  }

  querySelector(selector) {
    return this.elements.get(selector) ?? null;
  }

  querySelectorAll() {
    return [];
  }

  createElement() {
    return new FakeElement(this);
  }
}

class FakeStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

const ids = [
  "image",
  "image-zoom",
  "lightbox-dialog",
  "lightbox-image",
  "lightbox-close-button",
  "empty-state",
  "loading-state",
  "error-state",
  "error-message",
  "start-button",
  "retry-button",
  "previous-button",
  "next-button",
  "save-button",
  "copy-image-button",
  "copy-link-button",
  "source-link",
  "image-id",
  "previous-id-button",
  "next-id-button",
  "jump-form",
  "jump-input",
  "jump-button",
  "history-total",
  "history-button",
  "history-dialog",
  "history-close-button",
  "history-clear-button",
  "history-grid",
  "history-empty",
  "stats-button",
  "stats-dialog",
  "stats-close-button",
  "stats-today",
  "stats-total",
  "stats-explored",
  "stats-explored-percent",
  "stats-explored-breakdown",
  "stats-heatmap-grid",
  "stats-heatmap-range",
  "stats-heatmap-detail",
  "frame-meta",
  "announcer",
  "entry-dialog",
  "entry-consent",
  "entry-button",
  "main-content",
  "app-footer",
  "dialog-backdrop",
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("persistent history keeps the existing jump path and the main image opens a lightbox", async (t) => {
  const document = new FakeDocument(ids);
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const performance = { getEntriesByType: () => [{ type: "back_forward" }] };
  const globalNames = ["document", "localStorage", "performance", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  localStorage.setItem("random-frame-risk-accepted", "accepted");
  sessionStorage.setItem(
    "prntsc-gallery-history",
    JSON.stringify({ history: [{ id: "saved1" }, { id: "saved2" }], index: 1 }),
  );

  Object.assign(globalThis, { document, localStorage, performance, sessionStorage, window });
  const todayIso = new Date().toLocaleDateString("en-CA");
  let draw = 0;
  let savePath = null;
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
        return { explored: 12_483, total: 4_773_622_240, viewable: 8_000, unavailable: 4_483 };
      }
      if (command === "get_viewing_activity") {
        return { viewedTotal: 2, days: [{ date: todayIso, viewed: 2, rejected: 0 }] };
      }
      if (command === "migrate_viewing_stats") return null;
      if (command === "get_random_frame") {
        draw += 1;
        const id = draw === 1 ? "abc123" : "def456";
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

  get("history-close-button").click();
  assert.equal(get("history-dialog").open, false);
  assert.equal(document.activeElement, get("history-button"));

  get("start-button").click();
  await flush();
  await flush();
  get("next-button").click();
  await flush();
  await flush();

  get("stats-button").click();
  await flush();
  assert.equal(get("stats-dialog").open, true);
  assert.equal(get("stats-today").textContent, "2");
  assert.equal(get("stats-total").textContent, "2");
  assert.equal(get("stats-explored").textContent, "12,483 / 4,773,622,240");
  assert.equal(get("stats-explored-percent").textContent, "0.0002615% of known legacy ID space");
  assert.equal(get("stats-explored-breakdown").textContent, "8,000 viewable · 4,483 unavailable");
  assert.equal(get("stats-heatmap-detail").textContent, "Hover or focus a day for details.");
  const expectedRange = heatmapRangeLabel([{ date: todayIso, viewed: 2, rejected: 0 }]);
  assert.equal(get("stats-heatmap-range").textContent, expectedRange);
  assert.equal(
    get("stats-heatmap-grid").getAttribute("aria-label"),
    `Daily viewed images, ${expectedRange.toLowerCase()}`,
  );
  assert.equal(get("stats-heatmap-grid").children.length, leadingBlankCount(todayIso) + 1 + heatmapPlaceholderCount(1));
  get("stats-close-button").click();
  assert.equal(document.activeElement, get("stats-button"));

  get("history-button").click();
  assert.equal(get("history-grid").children.length, 4);
  assert.equal(get("history-grid").children[3].getAttribute("aria-current"), "true");
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

  get("history-button").click();
  get("history-clear-button").click();
  await flush();
  assert.deepEqual(persisted, { history: [], index: -1 });
  assert.equal(get("history-total").textContent, "0");
  assert.equal(get("history-clear-button").disabled, false);
  get("history-clear-button").click();
  await flush();
  assert.equal(invocations.filter(({ command }) => command === "clear_history").length, 2);
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
