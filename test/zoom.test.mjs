import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("Fit, actual image scale, and enlargement labels agree for small and large images", async (t) => {
  const document = new FakeDocument(ids);
  const window = new EventTarget();
  window.setTimeout = () => 0;
  const originals = new Map(
    ["document", "window", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
  );
  Object.assign(globalThis, { document, window, localStorage: new FakeStorage() });
  t.after(() => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const get = (id) => document.querySelector(`#${id}`);
  const img = get("lightbox-image");
  const view = get("lightbox-view");
  view.clientWidth = 600;
  view.clientHeight = 400;
  view.scrollLeft = 0;
  view.scrollTop = 0;
  let fit = 200;
  img.naturalWidth = 200;
  img.naturalHeight = 100;
  img.getBoundingClientRect = () => {
    const width = Number.parseFloat(img.style.width) || fit;
    return {
      width,
      height: (width * img.naturalHeight) / img.naturalWidth,
      left: Math.max(0, (600 - width) / 2) - view.scrollLeft,
      top: 0 - view.scrollTop,
    };
  };
  Object.defineProperty(view, "scrollWidth", { get: () => Math.max(600, img.getBoundingClientRect().width) });
  Object.defineProperty(view, "scrollHeight", { get: () => Math.max(400, img.getBoundingClientRect().height) });
  get("image").src = "fixture";
  const { bindFrameActionEvents } = await import("../dist/test-client/frame-actions.js");
  (await import("../dist/test-client/stage.js")).setState("image");
  (await import("../dist/test-client/viewer-state.js")).state.history = [{ source: "prntsc", id: "aaa111" }];
  (await import("../dist/test-client/viewer-state.js")).state.index = 0;
  bindFrameActionEvents();
  get("image-zoom").click();
  assert.equal(get("lightbox-zoom-button").textContent, "2×");
  get("lightbox-zoom-button").click();
  assert.equal(img.getBoundingClientRect().width, 400);
  assert.match(get("lightbox-zoom-button").getAttribute("aria-label"), /200%/);
  get("lightbox-zoom-button").click();
  assert.equal(img.getBoundingClientRect().width, 200);
  fit = 300;
  img.naturalWidth = 1200;
  img.naturalHeight = 600;
  get("image-zoom").click();
  assert.equal(get("lightbox-zoom-button").textContent, "1:1");
  get("lightbox-zoom-button").click();
  assert.equal(img.getBoundingClientRect().width, 1200);
  assert.match(get("lightbox-zoom-button").getAttribute("aria-label"), /100%/);
  get("lightbox-zoom-button").click();
  fit = 200;
  img.naturalWidth = 10000;
  img.naturalHeight = 5000;
  get("image-zoom").click();
  get("lightbox-zoom-button").click();
  assert.equal(img.getBoundingClientRect().width, 10000, "1:1 remains reachable beyond the old relative zoom limit");
  // Two touch pointers change scale continuously; ending the pinch must not toggle Fit.
  get("lightbox-zoom-button").click();
  fit = 300;
  img.naturalWidth = 1200;
  img.naturalHeight = 600;
  get("image-zoom").click();
  view.setPointerCapture = () => undefined;
  const pointer = (type, id, x, y) => {
    const event = new Event(type, { cancelable: true });
    Object.defineProperties(event, {
      pointerId: { value: id },
      pointerType: { value: "touch" },
      button: { value: 0 },
      clientX: { value: x },
      clientY: { value: y },
      target: { value: img },
    });
    view.dispatchEvent(event);
    return event;
  };
  pointer("pointerdown", 1, 200, 100);
  pointer("pointerdown", 2, 400, 100);
  pointer("pointermove", 2, 600, 100);
  assert.equal(img.getBoundingClientRect().width, 600, "a 2× pinch doubles the fit width");
  pointer("pointerup", 2, 600, 100);
  const beforePan = view.scrollLeft;
  pointer("pointermove", 1, 150, 100);
  assert.equal(view.scrollLeft, beforePan + 50, "remaining pointer pans without jumping");
  pointer("pointerup", 1, 150, 100);
  img.click();
  assert.equal(img.getBoundingClientRect().width, 600, "gesture-generated click cannot toggle zoom");
  pointer("pointerdown", 3, 300, 100);
  pointer("pointercancel", 3, 300, 100);
  img.click();
  assert.equal(img.getBoundingClientRect().width, 600, "cancellation does not leave a tap behind");
  window.dispatchEvent(new Event("resize"));
  assert.equal(img.getBoundingClientRect().width, 600, "viewport changes preserve absolute magnification");
  for (let step = 0; step < 4; step++) get("lightbox-zoom-in").click();
  const before = img.getBoundingClientRect();
  const focal = (250 - before.left) / before.width;
  const wheel = new Event("wheel", { cancelable: true });
  Object.defineProperties(wheel, {
    ctrlKey: { value: true },
    deltaY: { value: -100 },
    deltaMode: { value: 0 },
    clientX: { value: 250 },
    clientY: { value: 100 },
  });
  view.dispatchEvent(wheel);
  const after = img.getBoundingClientRect();
  assert.ok(
    Math.abs(after.left + focal * after.width - 250) < 0.001,
    "continuous zoom keeps the image point under its focal anchor",
  );
  for (let step = 0; step < 30; step++) get("lightbox-zoom-in").click();
  assert.equal(img.getBoundingClientRect().width, fit * 16);
  assert.equal(get("lightbox-zoom-in").disabled, true);
  for (let step = 0; step < 30; step++) get("lightbox-zoom-out").click();
  assert.equal(img.getBoundingClientRect().width, fit, "zoom cannot shrink below Fit");
  assert.equal(get("lightbox-zoom-out").disabled, true);
});
