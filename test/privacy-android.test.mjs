import assert from "node:assert/strict";
import test from "node:test";

test("Android Back on the privacy page returns to the gallery without a history entry", async (t) => {
  let backHandler;
  let replaced;
  const window = new EventTarget();
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    transformCallback: () => 1,
    async invoke(command, args) {
      if (command === "get_platform_capabilities")
        return { platform: "android", sync: true, desktopWindowControls: false, updater: false, imageClipboard: false };
      if (command === "plugin:app|register_listener") backHandler = args.handler;
      return null;
    },
  };
  const document = new EventTarget();
  document.querySelector = () => null;
  document.querySelectorAll = () => [];
  const names = ["document", "window", "location"];
  const originals = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.assign(globalThis, { document, window });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: {
      replace: (url) => {
        replaced = url;
      },
    },
  });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  await import(`../dist/test-client/privacy.js?test=${Date.now()}`);
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(backHandler, "the privacy page handles Back itself");
  backHandler.onmessage({ canGoBack: false });
  assert.equal(replaced, "index.html");
});
