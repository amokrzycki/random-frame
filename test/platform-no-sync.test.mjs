import assert from "node:assert/strict";
import test from "node:test";
import { android, startApp } from "./platform-fixture.mjs";

test("a platform without Sync never calls Sync IPC and hides Sync", async (t) => {
  const { invocations, get } = await startApp(t, { ...android, sync: false });
  assert.deepEqual(
    invocations.filter((command) => /sync/.test(command)),
    [],
  );
  assert.equal(get("error-state").hidden, true);
  assert.equal(get("sync-button").hidden, true);
});
