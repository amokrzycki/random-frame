import assert from "node:assert/strict";
import test from "node:test";
import { desktop, flush, startApp } from "./platform-fixture.mjs";

test("desktop keeps window controls, the update check, and Sync", async (t) => {
  const { invocations, removed, syncStatus } = await startApp(t, desktop);
  assert.ok(invocations.includes("plugin:window|is_maximized"));
  assert.ok(invocations.includes("plugin:updater|check"));
  assert.ok(invocations.includes("startup_sync"));
  assert.deepEqual(removed, []);
  assert.equal(document.documentElement.getAttribute("data-platform"), "linux");
  assert.equal(document.querySelector("#window-controls").hidden, false);
  const before = invocations.filter((command) => command === "startup_sync").length;
  Object.assign(syncStatus, { paired: true, dirty: true, state: "idle" });
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  assert.equal(invocations.filter((command) => command === "startup_sync").length, before + 1);
  syncStatus.dirty = false;
  window.dispatchEvent(new Event("focus"));
  await flush();
  assert.equal(invocations.filter((command) => command === "startup_sync").length, before + 1);
});
