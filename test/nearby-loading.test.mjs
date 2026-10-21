import assert from "node:assert/strict";
import test from "node:test";
import { nearbyWindow } from "../dist/test-client/navigation.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("Nearby resolves eight neighbors around Current and four new frames after Next 4", async () => {
  const { NearbySession } = await import("../dist/test-client/nearby-state.js");
  const requests = [];
  let active = 0;
  let maximum = 0;
  const session = new NearbySession("abc123", {
    setWindow: async (centerId) => ({ window: nearbyWindow(centerId), evidence: { abc123: 1 } }),
    resolve: async (id) => {
      requests.push(id);
      maximum = Math.max(maximum, ++active);
      await tick();
      active--;
      return { state: "unavailable", reason: "Unavailable" };
    },
    changed: () => {
      /* Rendering is exercised by the dialog suite. */
    },
  });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(active, 0);
  };
  await session.move("abc123");
  await settle();
  assert.equal(session.tiles.length, 9);
  assert.equal(session.tiles[4].current, true);
  assert.equal(session.tiles[4].phase, "ready");
  assert.equal(requests.length, 8);
  assert.ok(!requests.includes("abc123"), "Current reuses its displayed image");
  await session.move("abc127");
  await settle();
  assert.equal(session.tiles[0].current, true);
  assert.equal(session.tiles[0].phase, "ready");
  assert.equal(requests.length, 12);
  assert.deepEqual(new Set(requests.slice(8)), new Set(["abc128", "abc129", "abc12a", "abc12b"]));
  assert.equal(maximum, 2);
  session.close();
});

test("Nearby pump bounds work, adopts overlap and ignores obsolete decode/close results", async () => {
  const { NearbySession } = await import("../dist/test-client/nearby-state.js");
  const requests = [];
  let active = 0,
    maximum = 0;
  const session = new NearbySession("abc123", {
    setWindow: async (centerId) => ({ window: nearbyWindow(centerId), evidence: {} }),
    resolve: (id) =>
      new Promise((resolve) => {
        active++;
        maximum = Math.max(maximum, active);
        requests.push({
          id,
          resolve: (value) => {
            active--;
            resolve(value);
          },
        });
      }),
    changed: () => {
      /* Rendering is exercised by the dialog suite. */
    },
  });
  await session.move("abc123");
  assert.equal(session.tiles[4].phase, "ready");
  assert.equal(requests.length, 2);
  assert.equal(maximum, 2);
  await session.move("abc127");
  assert.equal(requests.length, 2);
  requests[0].resolve({ state: "unavailable", reason: "Unavailable" });
  requests[1].resolve({ state: "retryable", kind: "timeout", message: "Timed out" });
  await tick();
  assert.equal(maximum, 2);
  session.close();
  for (const request of requests.slice(2))
    request.resolve({
      state: "available",
      source: "prntsc",
      id: request.id,
      sourcePageUrl: "",
      thumbnailHandle: request.id,
    });
  await tick();
  assert.equal(session.active, false);
});
