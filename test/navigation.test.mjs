import assert from "node:assert/strict";
import test from "node:test";
import {
  adjacentPrntscId,
  frameNumberToIndex,
  historyFromStorage,
  historyIndexForId,
  nextHistoryIndex,
  shouldShowEntryDialog,
} from "../dist/test-client/navigation.js";

test("shows the entry warning until it is accepted", () => {
  assert.equal(shouldShowEntryDialog(null), true);
  assert.equal(shouldShowEntryDialog("accepted"), false);
});

test("uses saved history before requesting a new frame", () => {
  assert.equal(nextHistoryIndex(2, 42), 3);
  assert.equal(nextHistoryIndex(41, 42), null);
});

test("reuses a previously drawn adjacent frame", () => {
  const history = [{ id: "uox2x4" }, { id: "uox2x5" }];
  assert.equal(historyIndexForId(history, "uox2x4"), 0);
  assert.equal(historyIndexForId(history, "uox2x3"), -1);
});

test("validates frame numbers before jumping", () => {
  assert.equal(frameNumberToIndex("3", 42), 2);
  assert.equal(frameNumberToIndex("43", 42), null);
  assert.equal(frameNumberToIndex("3.5", 42), null);
});

test("reads the existing session history format", () => {
  assert.deepEqual(historyFromStorage('{"history":[{"id":"abc123"},{"id":"def456"}],"index":1}'), {
    history: [{ id: "abc123" }, { id: "def456" }],
    index: 1,
  });
  assert.deepEqual(historyFromStorage(null), { history: [], index: -1 });
  assert.deepEqual(historyFromStorage("invalid"), { history: [], index: -1 });
});

test("steps through the legacy sequential base-36 Prnt.sc namespace", () => {
  assert.equal(adjacentPrntscId("z", 1), "10");
  assert.equal(adjacentPrntscId("10", -1), "z");
  assert.equal(adjacentPrntscId("0", -1), null);
  assert.equal(adjacentPrntscId("26y3ahq", 1), "26y3ahr");
  assert.equal(adjacentPrntscId("26y3ahr", 1), null);
});

test("Nearby windows preserve numerical order, aliases, endpoints and five-ID overlap", async () => {
  const { nearbyWindow } = await import("../dist/test-client/navigation.js");
  const window = nearbyWindow("0abc123");
  assert.deepEqual(
    window.slots.map((x) => x.id),
    ["abc11z", "abc120", "abc121", "abc122", "abc123", "abc124", "abc125", "abc126", "abc127"],
  );
  assert.equal(window.centerId, "abc123");
  assert.equal(nearbyWindow("0").slots.filter((x) => x.id === null).length, 4);
  assert.equal(nearbyWindow("26y3ahr").nextCenterId, null);
  for (const id of ["z", "zz", "zzzzzz", "0", "26y3ahr", "abc123"]) {
    const a = nearbyWindow(id);
    assert.equal(a.slots.length, 9);
    if (a.nextCenterId) {
      const b = nearbyWindow(a.nextCenterId);
      assert.equal(parseInt(b.centerId, 36) - parseInt(a.centerId, 36), 4);
      if (a.slots.every((x) => x.id) && b.slots.every((x) => x.id))
        assert.equal(a.slots.filter((x) => b.slots.some((y) => y.id === x.id)).length, 5);
    }
  }
  for (const id of ["ABC", "26y3ahs", "", "zzzzzzz"]) assert.throws(() => nearbyWindow(id));
});
