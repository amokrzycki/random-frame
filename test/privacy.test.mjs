import assert from "node:assert/strict";
import test from "node:test";

class FakeElement extends EventTarget {
  classList = {
    add() {
      // noop
    },
    remove() {
      // noop
    },
  };
  children = [];

  append(...nodes) {
    this.children.push(...nodes);
  }

  setAttribute() {
    // noop
  }
}

test("privacy mailto click copies email to clipboard, shows toast, and invokes openUrl", async (t) => {
  const commands = [];
  const copied = [];
  let preventDefaultCalled = false;

  const window = new EventTarget();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    async invoke(command, args) {
      commands.push({ command, args });
      return null;
    },
  };

  const body = new FakeElement();
  const mailLink = new FakeElement();
  mailLink.href = "mailto:contact@amokrzycki.ovh";

  const document = new EventTarget();
  document.body = body;
  document.createElement = () => new FakeElement();
  document.querySelector = (selector) => {
    if (selector === ".toast-region") return body;
    return null;
  };
  document.querySelectorAll = (selector) => {
    if (selector === 'a[href^="mailto:"]') return [mailLink];
    return [];
  };

  const navigator = {
    clipboard: {
      async writeText(text) {
        copied.push(text);
      },
    },
  };

  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

  Object.assign(globalThis, { document, window });
  Object.defineProperty(globalThis, "navigator", { value: navigator, configurable: true, writable: true });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else delete globalThis.document;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else delete globalThis.window;
    if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
    else delete globalThis.navigator;
  });

  const { handleMailtoClick, initializePrivacy } = await import(`../dist/test-client/privacy.js?test=${Date.now()}`);

  initializePrivacy();

  const fakeEvent = {
    preventDefault() {
      preventDefaultCalled = true;
    },
  };

  await handleMailtoClick(fakeEvent, "mailto:contact@amokrzycki.ovh");

  assert.equal(preventDefaultCalled, true);
  assert.deepEqual(copied, ["contact@amokrzycki.ovh"]);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, "plugin:opener|open_url");
  assert.equal(commands[0].args.url, "mailto:contact@amokrzycki.ovh");
});
