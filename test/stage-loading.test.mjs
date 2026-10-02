import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, ids } from "./dom-fakes.mjs";

test("loading preserves the frame and settles only its delayed entrance before crossfade", async (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  });
  const document = new FakeDocument(ids);
  globalThis.document = document;
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { setState, settleLoader, swapImage } = await import("../dist/test-client/stage.js");
  const image = document.querySelector("#image");
  const zoom = document.querySelector("#image-zoom");
  const ghost = document.querySelector("#image-ghost");
  const loading = document.querySelector("#loading-state");
  image.src = "blob:previous";
  setState("image");
  setState("loading");
  assert.equal(zoom.hidden, false);
  assert.equal(zoom.inert, true);
  assert.equal(image.src, "blob:previous");
  assert.equal(zoom.dataset.dimmed, "loading");
  await settleLoader(); // A fast request has no minimum wait.
  t.mock.timers.tick(160);
  let settled = false;
  const entrance = settleLoader().then(() => {
    settled = true;
  });
  t.mock.timers.tick(209);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await entrance;
  assert.equal(settled, true);
  swapImage("blob:next", "next");
  assert.equal(ghost.src, "blob:previous");
  assert.equal(ghost.hidden, false);
  assert.equal(ghost.dataset.dimmed, "loading"); // The outgoing frame keeps its optical treatment through the handoff.
  assert.equal(loading.hidden, true);
  assert.equal(zoom.dataset.dimmed, undefined);
  assert.equal(zoom.inert, false);
  swapImage("blob:third", "third");
  assert.equal(ghost.dataset.dimmed, undefined); // Cached navigation must not inherit the loading treatment.
});
