import assert from "node:assert/strict";
import test from "node:test";
import { nearbyWindow } from "../dist/test-client/navigation.js";

test("Nearby current anchor is independent of moving center and queue is nearest first", async () => {
  const { nearbyTiles, queueOrder } = await import("../dist/test-client/nearby-state.js");
  const tiles = nearbyTiles(nearbyWindow("abc127"), "abc123");
  assert.equal(tiles[0].current, true);
  assert.equal(tiles[4].current, false);
  assert.deepEqual(
    queueOrder(tiles).map((x) => x.id),
    ["abc127", "abc126", "abc128", "abc125", "abc129", "abc124", "abc12a", "abc12b"],
  );
});
