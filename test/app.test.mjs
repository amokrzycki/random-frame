import assert from "node:assert/strict";
import test from "node:test";

class FakeElement extends EventTarget {
  constructor(document) {
    super();
    this.document = document;
    this.attributes = new Map();
    this.children = [];
    this.style = {};
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

  focus() {
    this.document.activeElement = this;
  }

  click() {
    this.dispatchEvent(new Event("click"));
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
  "empty-state",
  "loading-state",
  "error-state",
  "error-message",
  "start-button",
  "retry-button",
  "previous-button",
  "next-button",
  "save-button",
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
  "history-grid",
  "history-empty",
  "stats-button",
  "stats-dialog",
  "stats-close-button",
  "stats-today",
  "stats-total",
  "frame-meta",
  "announcer",
  "entry-dialog",
  "entry-consent",
  "entry-button",
];

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("history dialog uses session history and the existing jump path", async (t) => {
  const document = new FakeDocument(ids);
  const sessionStorage = new FakeStorage();
  const localStorage = new FakeStorage();
  const window = new EventTarget();
  const globalNames = ["document", "localStorage", "sessionStorage", "window"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  localStorage.setItem("random-frame-risk-accepted", "accepted");

  Object.assign(globalThis, { document, localStorage, sessionStorage, window });
  let draw = 0;
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      if (command === "get_random_frame") {
        draw += 1;
        const id = draw === 1 ? "abc123" : "def456";
        return { id, source: "prntsc", sourcePageUrl: `https://prnt.sc/${id}`, mimeType: "image/png" };
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

  get("history-button").click();
  assert.equal(get("history-dialog").open, true);
  assert.equal(get("history-grid").hidden, true);
  assert.equal(get("history-empty").hidden, false);

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
  assert.equal(get("stats-dialog").open, true);
  assert.equal(get("stats-today").textContent, "2");
  assert.equal(get("stats-total").textContent, "2");
  assert.deepEqual(JSON.parse(localStorage.getItem("random-frame-viewing-stats")), {
    day: new Date().toLocaleDateString("en-CA"),
    today: 2,
    total: 2,
  });
  get("stats-close-button").click();
  assert.equal(document.activeElement, get("stats-button"));

  get("history-button").click();
  assert.equal(get("history-grid").children.length, 2);
  assert.equal(get("history-grid").children[1].getAttribute("aria-current"), "true");
  assert.deepEqual(JSON.parse(sessionStorage.getItem("prntsc-gallery-history")), {
    history: [{ id: "abc123" }, { id: "def456" }],
    index: 1,
  });

  get("history-dialog").click();
  assert.equal(get("history-dialog").open, false);

  get("history-button").click();
  get("history-grid").children[0].click();
  assert.equal(get("history-dialog").open, false);
  assert.match(get("image").alt, /abc123/);

  get("jump-input").value = "2";
  get("jump-form").dispatchEvent(new Event("submit", { cancelable: true }));
  assert.match(get("image").alt, /def456/);
});
