import assert from "node:assert/strict";
import test from "node:test";

test("pointer presses hide focus rings and keyboard navigation or shortcuts restore them", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = new EventTarget();
  document.documentElement = { dataset: {} };
  document.body = { append: () => undefined };
  document.createElement = () => ({ setAttribute: () => undefined });
  globalThis.document = document;
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  });

  const { bindTooltipEvents } = await import("../dist/test-client/tooltip.js");
  bindTooltipEvents();
  assert.equal(document.documentElement.dataset.input, undefined);

  for (const key of ["Tab", "ArrowDown", "Enter", "h", "Escape"]) {
    document.dispatchEvent(new Event("pointerdown"));
    assert.equal(document.documentElement.dataset.input, "pointer");
    const event = new Event("keydown");
    event.key = key;
    document.dispatchEvent(event);
    assert.equal(document.documentElement.dataset.input, "keyboard");
  }
  document.dispatchEvent(new Event("pointerdown"));
  assert.equal(document.documentElement.dataset.input, "pointer");
});
