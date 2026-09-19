import test from "node:test";
import assert from "node:assert/strict";
import { adjacentPrntscId, frameNumberToIndex, historyIndexForId, nextHistoryIndex, shouldShowEntryDialog } from "../dist/client/navigation.js";

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

test("steps through fixed-width Prnt.sc base-36 identifiers", () => {
  assert.equal(adjacentPrntscId("00000z", 1), "000010");
  assert.equal(adjacentPrntscId("000010", -1), "00000z");
  assert.equal(adjacentPrntscId("000000", -1), null);
  assert.equal(adjacentPrntscId("zzzzzz", 1), null);
});
