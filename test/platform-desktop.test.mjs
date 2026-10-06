import assert from "node:assert/strict";
import test from "node:test";
import { desktop, startApp } from "./platform-fixture.mjs";

test("desktop keeps window controls, the update check, and Sync", async (t) => {
  const { invocations, removed } = await startApp(t, desktop);
  assert.ok(invocations.includes("plugin:window|is_maximized"));
  assert.ok(invocations.includes("plugin:updater|check"));
  assert.ok(invocations.includes("startup_sync"));
  assert.deepEqual(removed, []);
});
