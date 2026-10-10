import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("dialog recovery remains reachable, survives a blocked attempt and other feedback, and consumes only on success", async (t) => {
  const document = new FakeDocument(ids);
  const originals = new Map(
    ["document", "window"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  const timers = [];
  Object.assign(globalThis, {
    document,
    window: {
      setTimeout: (callback) => {
        timers.push(callback);
        return 0;
      },
    },
  });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const { toast } = await import(`../dist/test-client/toast.js?recovery=${Date.now()}`);
  const { openDialog } = await import("../dist/test-client/dialogs.js");
  // dialogs imports the shared toast module, so use its actual shared instance too.
  const shared = (await import("../dist/test-client/toast.js")).toast;
  const dialog = document.querySelector("#history-dialog");
  const close = document.querySelector("#history-close-button");
  dialog.querySelector = (selector) => (selector.includes("autofocus") ? close : undefined);
  openDialog(dialog);
  const outside = document.querySelector("#draw-button");
  outside.isConnected = true;
  outside.getClientRects = () => [1];
  outside.matches = () => false;
  outside.focus();
  let succeed = false;
  let calls = 0;
  shared.info("Removed from history", {
    label: "Undo",
    run: async () => {
      calls++;
      await flush();
      return succeed;
    },
  });
  const notice = dialog.children
    .flatMap((region) => region.children)
    .find((element) => element.className === "toast toast--info");
  assert.ok(
    notice?.children.some((button) => button.textContent === "Undo"),
    "Undo belongs to the dialog",
  );
  shared.undo();
  shared.undo();
  await flush();
  await flush();
  assert.equal(calls, 1, "rapid Undo cannot start concurrent recovery");
  shared.error("A frame is loading. Try Undo again in a moment.");
  for (const timer of timers) timer();
  assert.equal(shared.undo(), true, "blocked recovery survives errors and notification timeout");
  await flush();
  await flush();
  assert.equal(calls, 2);
  succeed = true;
  notice.children.find((button) => button.textContent === "Undo").focus();
  shared.undo();
  await flush();
  await flush();
  assert.equal(shared.undo(), false);
  assert.equal(document.activeElement, close, "dismissal cannot return focus outside the active dialog");
  assert.ok(toast);
});
