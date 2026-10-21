import assert from "node:assert/strict";
import test from "node:test";
import { FakeDocument, FakeStorage, ids } from "./dom-fakes.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Stats opens before reads, discards late responses, and refreshes without stale values", async () => {
  globalThis.document = new FakeDocument(ids);
  globalThis.localStorage = new FakeStorage();
  const requests = [];
  globalThis.window = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: {
      invoke: (command) => new Promise((resolve, reject) => requests.push({ command, resolve, reject })),
    },
  });
  const { elements: e } = await import("../dist/test-client/elements.js");
  const { state } = await import("../dist/test-client/viewer-state.js");
  const { bindStatsDialogEvents } = await import("../dist/test-client/stats-dialog.js");
  bindStatsDialogEvents();
  const finish = (offset, count) => {
    assert.deepEqual(
      requests.slice(offset, offset + 2).map((r) => r.command),
      ["get_exploration_stats", "get_viewing_activity"],
    );
    requests[offset].resolve({ explored: count, viewable: count, unavailable: 0, unclassified: 0 });
    requests[offset + 1].resolve({
      viewedTotal: count,
      days: [{ date: "2026-10-19", viewed: count, rejected: 0 }],
      localViewTimes: [],
      frameViews: [],
    });
  };
  const loading = () => {
    assert.equal(e.statsDialog.open, true);
    assert.equal(e.statsBody.getAttribute("aria-busy"), "true");
    assert.match(e.statsStatus.textContent, /Loading/);
    for (const value of [e.statsToday, e.statsTotal, e.statsStreak, e.statsExplored])
      assert.equal(value.textContent, "—");
    assert.equal(e.statsExploredBreakdown.textContent, "");
    assert.equal(e.ledgerList.children.length, 0);
    assert.equal(e.ledgerMore.hidden, true);
    assert.equal(e.ledgerEmpty.hidden, true);
    assert.equal(e.statsError.hidden, true);
  };
  e.statsButton.click();
  loading();
  e.statsButton.click();
  assert.equal(requests.length, 2, "double activation does not duplicate reads");
  e.statsDialog.dispatchEvent(new Event("dialog-dismiss"));
  document.dispatchEvent(new Event("persisted-view-refreshed"));
  assert.equal(requests.length, 2, "sync during the closing animation does not restart reads");
  e.statsClose.click();
  finish(0, 1);
  await flush();
  assert.equal(e.statsDialog.open, false, "late reads never reopen the dialog");
  assert.equal(e.statsTotal.textContent, "—");

  e.statsButton.click(); // old request
  e.statsClose.click();
  e.statsButton.click(); // new request
  finish(4, 30);
  await flush();
  assert.equal(e.statsTotal.textContent, "30");
  finish(2, 20);
  await flush();
  assert.equal(e.statsTotal.textContent, "30", "old success cannot replace newer data");

  document.dispatchEvent(new Event("persisted-view-refreshed"));
  loading();
  document.dispatchEvent(new Event("persisted-view-refreshed"));
  requests[6].reject(Error("old failure"));
  requests[7].reject(Error("old failure"));
  await flush();
  loading(); // stale finally must not clear the latest request's busy state
  finish(8, 40);
  await flush();
  assert.equal(e.statsTotal.textContent, "40");
  assert.equal(e.statsBody.getAttribute("aria-busy"), "false");
  assert.equal(e.statsError.hidden, true);
  assert.equal(e.ledgerList.children.length, 1);

  document.dispatchEvent(new Event("persisted-view-refreshed"));
  requests[10].reject(Error("unreadable"));
  requests[11].reject(Error("unreadable"));
  await flush();
  assert.equal(e.statsError.hidden, false);
  assert.equal(e.statsTotal.textContent, "—");
  assert.equal(e.ledger.hidden, true);
  e.statsRetry.click();
  loading();
  assert.equal(document.activeElement, e.statsClose);
  e.statsClose.click();
  e.nearbyButton.focus();
  finish(12, 50);
  await flush();
  assert.equal(e.statsDialog.open, false);
  assert.equal(document.activeElement, e.nearbyButton, "late retry cannot steal focus");
  document.dispatchEvent(new Event("persisted-view-refreshed"));
  assert.equal(requests.length, 14, "sync while closed does not start reads");
  assert.deepEqual(state.history, [], "reading Stats does not create history");

  state.history = [{ source: "prntsc", id: "0abc123", sourcePageUrl: "https://prnt.sc/0abc123", viewedAt: 1 }];
  const { thumbnails } = await import("../dist/test-client/frame-cache.js");
  thumbnails.set("prntsc:abc123", "data:image/jpeg;base64,AQ==");
  e.statsButton.click();
  requests[14].resolve({ explored: 1, viewable: 1, unavailable: 0, unclassified: 0 });
  requests[15].resolve({
    viewedTotal: 1,
    days: [{ date: "2026-10-19", viewed: 1, rejected: 0 }],
    localViewTimes: [1],
    frameViews: [{ source: "prntsc", id: "abc123", atMs: 1, day: "2026-10-19", dayInferred: false }],
  });
  await flush();
  assert.equal(
    e.ledgerList.children[0].children[2].children[0]?.children[0].src,
    "data:image/jpeg;base64,AQ==",
    "Stats renders canonical thumbnails for leading-zero History IDs",
  );
  e.statsClose.click();
});
