import assert from "node:assert/strict";
import test from "node:test";

test("pointer presses hide focus rings and keyboard navigation or shortcuts restore them", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const document = new EventTarget();
  document.documentElement = { dataset: {} };
  document.body = { append: () => undefined };
  let tooltipShows = 0;
  document.createElement = () => ({
    setAttribute: () => undefined,
    showPopover: () => tooltipShows++,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    style: {},
  });
  globalThis.document = document;
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  });

  const { bindTooltipEvents } = await import("../dist/test-client/tooltip.js");
  bindTooltipEvents();
  assert.equal(document.documentElement.dataset.input, undefined);

  // Touch browsers emit pointerover before pointerdown. A tap must not flash a desktop tooltip.
  const originalElement = Object.getOwnPropertyDescriptor(globalThis, "Element");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  class Target {
    dataset = { tip: "History (H)" };
    closest() {
      return this;
    }
    getBoundingClientRect() {
      return { left: 20, top: 20, bottom: 68, width: 48 };
    }
  }
  globalThis.Element = Target;
  globalThis.window = { innerWidth: 400, innerHeight: 800 };
  t.after(() => {
    for (const [name, descriptor] of [
      ["Element", originalElement],
      ["window", originalWindow],
    ]) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const target = new Target();
  for (const pointerType of ["touch", "mouse"]) {
    const event = new Event("pointerover");
    Object.defineProperties(event, { target: { value: target }, pointerType: { value: pointerType } });
    document.dispatchEvent(event);
    assert.equal(tooltipShows, pointerType === "touch" ? 0 : 1);
  }

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
