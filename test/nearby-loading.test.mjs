import assert from "node:assert/strict";
import test from "node:test";
import { nearbyWindow } from "../dist/test-client/navigation.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));

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
