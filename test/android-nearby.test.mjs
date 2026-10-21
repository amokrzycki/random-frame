import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runNearbySmoke } from "../.github/tools/android-nearby.mjs";
import { nearbyWindow } from "../dist/test-client/navigation.js";
import { NearbySession } from "../dist/test-client/nearby-state.js";

function gallery({ windowDelay = 4000, duplicate = false } = {}) {
  let elapsed = 0;
  const pending = [];
  const fixture = { active: 0, maximum: 0, resolves: duplicate ? 1 : 0 };
  const delay = (ms) => new Promise((resolve) => pending.push({ at: elapsed + ms, resolve }));
  const advance = async (ms) => {
    elapsed += ms;
    for (const event of pending.filter((event) => event.at <= elapsed)) {
      pending.splice(pending.indexOf(event), 1);
      event.resolve();
    }
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  const session = new NearbySession("abc123", {
    setWindow: async (center) => {
      await delay(windowDelay);
      return { window: nearbyWindow(center), evidence: { abc123: 1 } };
    },
    resolve: async () => {
      fixture.resolves++;
      fixture.maximum = Math.max(fixture.maximum, ++fixture.active);
      await delay(700);
      fixture.active--;
      return { state: "unavailable", reason: "fixture" };
    },
    changed: () => undefined,
  });
  const tiles = () =>
    session.tiles.map((tile) => ({
      dataset: { state: tile.phase },
      title: tile.message,
      querySelector: (selector) =>
        selector === ".nearby-id" ? { textContent: tile.id } : selector === "img" ? { src: "blob:current" } : null,
    }));
  const document = {
    querySelector: (selector) => {
      if (selector === "#nearby-button") return { click: () => void session.move("abc123") };
      if (selector === "#nearby-next") return { click: () => void session.move("abc127") };
      if (selector === "#nearby-dialog") return { open: true };
      if (selector === "#nearby-center") return { textContent: session.window.centerId };
      if (selector === "#nearby-status") return { textContent: "" };
      if (selector === "#image") return { src: "blob:current" };
      if (selector === '[aria-current="true"]') return tiles()[session.tiles.findIndex((tile) => tile.current)];
      if (selector === "#nearby-grid")
        return {
          children: session.tiles.map((tile, index) => ({
            querySelector: () => (tile.current ? tiles()[index] : null),
          })),
        };
      throw new Error(`Unexpected selector: ${selector}`);
    },
    querySelectorAll: () => tiles(),
  };
  const context = vm.createContext({
    document,
    window: { __nearbySmoke: fixture },
    Date: { now: () => elapsed },
    setTimeout: (callback, ms) => void advance(ms).then(callback),
  });
  const finished = new Error("first two windows checked");
  const run = () =>
    runNearbySmoke({
      evaluate: async (expression) => {
        // Native transport installation and device geometry are outside this queue regression.
        if (expression.includes("const nativePost") || expression.includes("getBoundingClientRect")) return true;
        if (expression.startsWith("Promise.all(")) return [];
        return vm.runInContext(expression, context);
      },
      sleep: advance,
      check: (ok, message) => {
        assert.ok(ok, message);
        if (message.startsWith("Next 4 retains")) throw finished;
      },
    });
  return { run, finished, fixture, elapsed: () => elapsed };
}

test("Nearby smoke waits for slow window acknowledgement and preview completion before counting requests", async () => {
  const device = gallery();
  await assert.rejects(device.run(), (error) => error === device.finished);
  assert.equal(device.fixture.resolves, 12);
  assert.equal(device.fixture.maximum, 2);
  assert.equal(device.fixture.active, 0);
  assert.ok(device.elapsed() > 8000, "both native window acknowledgements exceeded the old fixed sleeps");
});

test("Nearby smoke times out with queue diagnostics when native acknowledgement never arrives", async () => {
  const device = gallery({ windowDelay: Infinity });
  await assert.rejects(device.run(), (error) => {
    assert.match(error.message, /timed out/i);
    assert.match(error.message, /"resolves":0/);
    assert.match(error.message, /queued/);
    return true;
  });
  assert.ok(device.elapsed() <= 16000, "a stuck queue has a bounded wait");
});

test("Nearby smoke still rejects an extra request after the queue settles", async () => {
  const device = gallery({ duplicate: true });
  await assert.rejects(device.run(), (error) => {
    assert.match(error.message, /eight fixture checks/);
    assert.match(error.message, /"resolves":9/);
    return true;
  });
});
