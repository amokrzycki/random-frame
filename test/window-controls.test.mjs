import assert from "node:assert/strict";
import test from "node:test";

class FakeElement extends EventTarget {
  attributes = new Map();
  hidden = false;
  textContent = "";
  title = "";

  click() {
    this.dispatchEvent(new Event("click"));
  }

  setAttribute(name, value) {
    this.attributes.set(name, value);
  }

  toggleAttribute(name, force) {
    if (force) this.attributes.set(name, "");
    else this.attributes.delete(name);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("window controls follow native maximized state and invoke native actions", async (t) => {
  const elements = new Map(
    [
      "window-minimize",
      "window-maximize",
      "window-close",
      "window-maximize-icon",
      "window-restore-icon",
      "announcer",
    ].map((id) => [`#${id}`, new FakeElement()]),
  );
  const document = { querySelector: (selector) => elements.get(selector) ?? null };
  const window = new EventTarget();
  const callbacks = new Map();
  const commands = [];
  let nextCallback = 1;
  let maximized = false;
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    transformCallback(callback) {
      const id = nextCallback++;
      callbacks.set(id, callback);
      return id;
    },
    async invoke(command, args) {
      commands.push(command);
      if (command === "plugin:window|is_maximized") return maximized;
      if (command === "plugin:window|toggle_maximize") {
        maximized = !maximized;
        return null;
      }
      if (command === "plugin:event|listen") {
        window.resizeHandler = callbacks.get(args.handler);
        return 1;
      }
      return null;
    },
  };

  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.assign(globalThis, { document, window });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
  });

  await import(`../dist/test-client/window-controls.js?test=${Date.now()}`);
  await flush();

  const get = (id) => elements.get(`#${id}`);
  assert.equal(get("window-maximize-icon").getAttribute("hidden"), null);
  assert.equal(get("window-restore-icon").getAttribute("hidden"), "");
  assert.equal(get("window-maximize").getAttribute("aria-label"), "Maximize window");

  get("window-maximize").click();
  await flush();
  assert.equal(get("window-maximize-icon").getAttribute("hidden"), "");
  assert.equal(get("window-restore-icon").getAttribute("hidden"), null);
  assert.equal(get("window-maximize").getAttribute("aria-label"), "Restore window");

  maximized = false;
  window.resizeHandler({ event: "tauri://resize", id: 1, payload: { width: 800, height: 600 } });
  await flush();
  assert.equal(get("window-maximize-icon").getAttribute("hidden"), null);

  get("window-minimize").click();
  get("window-close").click();
  await flush();
  assert.ok(commands.includes("plugin:window|minimize"));
  assert.ok(commands.includes("plugin:window|close"));
  assert.equal(get("announcer").textContent, "");
});
