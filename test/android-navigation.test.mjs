import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

test("Android Back closes the top layer by the Escape rules, and leaves from the consent screen", async (t) => {
  const document = new FakeDocument(ids);
  const window = new EventTarget();
  const commands = [];
  let backHandler;
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 1,
    async invoke(command, args) {
      commands.push(command);
      if (command === "plugin:app|register_listener") backHandler = args.handler;
      return null;
    },
  };
  const globalNames = ["document", "window", "history"];
  const originalGlobals = new Map(globalNames.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let wentBack = 0;
  Object.assign(globalThis, { document, window, history: { back: () => wentBack++ } });
  t.after(() => {
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const get = (id) => document.querySelector(`#${id}`);
  const menu = get("tools-menu");
  menu.matches = (selector) => selector === ":popover-open" && menu.popoverOpen;
  menu.hidePopover = () => {
    menu.popoverOpen = false;
  };
  get("frame-menu").matches = () => false;

  const { dismissTopLayer } = await import("../dist/test-client/dialogs.js");
  const { bindAndroidNavigation } = await import("../dist/test-client/android-navigation.js");

  assert.equal(dismissTopLayer(), false, "nothing open: the system handles Back");

  menu.popoverOpen = true;
  assert.equal(dismissTopLayer(), true);
  assert.equal(menu.popoverOpen, false);

  get("history-dialog").open = true;
  assert.equal(dismissTopLayer(), true);
  assert.equal(get("history-dialog").open, false);

  // A busy dialog and an unconfirmed recovery key keep the dialog and consume Back.
  get("sync-dialog").open = true;
  get("sync-dialog").dataset.busy = "true";
  assert.equal(dismissTopLayer(), true);
  assert.equal(get("sync-dialog").open, true);
  delete get("sync-dialog").dataset.busy;
  get("sync-recovery").dataset.gated = "true";
  assert.equal(dismissTopLayer(), true);
  assert.equal(get("sync-dialog").open, true);
  get("sync-key-saved").checked = true;
  assert.equal(dismissTopLayer(), true);
  assert.equal(get("sync-dialog").open, false);

  // Consent never closes on Back; Back leaves the app instead, even over another layer.
  get("entry-dialog").open = true;
  menu.popoverOpen = true;
  assert.equal(dismissTopLayer(), false);
  assert.equal(get("entry-dialog").open, true);

  const unbind = await bindAndroidNavigation();
  backHandler.onmessage({ canGoBack: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(commands.includes("exit_app"));
  assert.equal(get("entry-dialog").open, true);

  get("entry-dialog").open = false;
  menu.popoverOpen = false;
  commands.length = 0;
  // Like Escape, Back cancels a draw in flight before it would leave the app.
  const { state } = await import("../dist/test-client/viewer-state.js");
  state.drawing = true;
  backHandler.onmessage({ canGoBack: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.drawing, false);
  assert.equal(get("announcer").textContent, "Draw canceled");
  assert.equal(commands.includes("exit_app"), false);

  // The gallery keeps no history entries of its own; a stale Privacy entry must not trap Back.
  backHandler.onmessage({ canGoBack: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(wentBack, 0);
  assert.ok(commands.includes("exit_app"));
  unbind();
});
