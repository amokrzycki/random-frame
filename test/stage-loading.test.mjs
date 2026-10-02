import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

test("loading preserves the frame and settles only its delayed entrance before crossfade", async (t) => {
  const originals = Object.fromEntries(
    ["document", "matchMedia", "localStorage"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  t.after(() => {
    for (const [key, original] of Object.entries(originals)) {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    }
  });
  const document = new FakeDocument(ids);
  globalThis.document = document;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new FakeStorage() });
  const preference = new EventTarget();
  preference.matches = false;
  globalThis.matchMedia = () => preference;
  const animations = [];
  const frame = document.querySelector("#loading-frame");
  frame.append(...Array.from({ length: 4 }, () => document.createElement("path")));
  for (const target of [frame, ...frame.children, document.querySelector("#image-zoom")])
    target.animate = (keyframes, options) => {
      const animation = {
        target,
        keyframes,
        options,
        playState: "running",
        cancel() {
          this.playState = "idle";
        },
        pause() {
          this.playState = "paused";
        },
        play() {
          this.playState = "running";
        },
      };
      animations.push(animation);
      return animation;
    };
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  const { bindStageEvents, setState, settleLoader, swapImage } = await import("../dist/test-client/stage.js");
  bindStageEvents();
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
  t.mock.timers.tick(589);
  await Promise.resolve();
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

  // Constant randomness must still avoid repeats, including the previous draw's second message.
  t.mock.method(Math, "random", () => 0);
  const message = document.querySelector("#loading-message");
  setState("loading");
  const first = message.textContent;
  t.mock.timers.tick(4499);
  assert.equal(message.textContent, first);
  t.mock.timers.tick(1);
  t.mock.timers.tick(140);
  const second = message.textContent;
  assert.notEqual(second, first);
  t.mock.timers.tick(20000);
  assert.equal(message.textContent, second); // Only one replacement, even for a very slow draw.
  setState("image");
  setState("loading");
  const next = message.textContent;
  assert.notEqual(next, first);
  assert.notEqual(next, second);
  t.mock.timers.tick(4500);
  t.mock.timers.tick(140);
  assert.ok(![first, second, next].includes(message.textContent));
  setState("image");
  setState("loading");
  const canceled = message.textContent;
  t.mock.timers.tick(4500);
  setState("error"); // Completing or canceling during the copy fade must discard the pending swap.
  t.mock.timers.tick(10000);
  assert.equal(message.textContent, canceled);
  assert.equal(message.dataset.changing, undefined);
  setState("loading", "Restoring frame 2…");
  t.mock.timers.tick(10000);
  assert.equal(message.textContent, "Restoring frame 2…");
  setState("image");

  const { loadingMessages, pickLoadingMessage } = await import("../dist/test-client/loading-copy.js");
  const all = loadingMessages.flatMap((group) => group.messages);
  assert.ok(all.length >= 1268);
  assert.equal(new Set(all).size, all.length);
  assert.ok(all.every((copy) => copy.length <= 52));
  assert.ok(all.filter((copy) => copy.length <= 38).length / all.length > 0.9);
  const counts = [0, 0, 0, 0];
  let randomCall = 0;
  let draw = 0;
  Math.random.mock.mockImplementation(() => (randomCall++ % 2 ? 0 : (draw++ + 0.5) / 1000));
  for (let i = 0; i < 1000; i++) {
    const copy = pickLoadingMessage([]);
    const category = loadingMessages.findIndex((group) => group.messages.includes(copy));
    assert.ok(category >= 0);
    counts[category]++;
  }
  assert.ok(counts[0] >= 650); // Neutral dominates regardless of the size of the other pools.
  assert.ok(counts[1] >= 150);
  assert.ok(counts[2] > 0 && counts[2] <= 60);
  assert.ok(counts[3] > 0 && counts[3] <= 15);

  Math.random.mock.mockImplementation(() => 0);
  setState("loading");
  const moving = animations.filter((animation) => animation.playState === "running");
  const entranceMotion = moving.find(
    (animation) => animation.target === frame && animation.options.iterations !== Infinity,
  );
  assert.equal(entranceMotion.keyframes[0].transform, "scale(1.32)");
  const loops = moving.filter((animation) => animation.options.iterations === Infinity);
  assert.equal(loops.length, 6); // The viewfinder, all four corners, and image share one focus rhythm.
  assert.ok(loops.every((animation) => animation.options.duration === 2600 && animation.options.delay === 750));
  document.hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.ok(moving.every((animation) => animation.playState === "paused"));
  const hiddenCopy = message.textContent;
  t.mock.timers.tick(10000);
  assert.equal(message.textContent, hiddenCopy);
  document.hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  assert.ok(moving.every((animation) => animation.playState === "running"));
  preference.matches = true;
  preference.dispatchEvent(new Event("change"));
  assert.ok(moving.every((animation) => animation.playState === "idle"));
  const count = animations.length;
  setState("loading");
  assert.equal(animations.length, count); // Reduced motion starts with a still frame too.
  preference.matches = false;
  preference.dispatchEvent(new Event("change"));
  assert.ok(animations.length > count);
  setState("empty");
  assert.ok(animations.every((animation) => animation.playState === "idle"));
});
