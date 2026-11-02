import assert from "node:assert/strict";
import test from "node:test";
import { operationKey } from "../dist/test-client/favorites.js";

test("operation keys preserve byte order, leading zeros, and every byte value without retaining mutable IDs", () => {
  for (let offset = 0; offset < 256; offset++) {
    const id = Array.from({ length: 16 }, (_, index) => (offset + index * 17) % 256);
    const original = [...id];
    assert.equal(operationKey(id), Buffer.from(id).toString("hex"));
    assert.deepEqual(id, original);
  }
  const id = Array(16).fill(0);
  assert.equal(operationKey(id), "0".repeat(32));
  id[15] = 255;
  assert.equal(operationKey(id), `${"0".repeat(30)}ff`);
  assert.notEqual(operationKey([1, 23, ...Array(14).fill(0)]), operationKey([12, 3, ...Array(14).fill(0)]));
});
