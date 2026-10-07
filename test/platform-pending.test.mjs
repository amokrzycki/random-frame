import assert from "node:assert/strict";
import test from "node:test";
import { flush, startApp } from "./platform-fixture.mjs";

test("Leave still closes the window while the platform has not answered yet", async (t) => {
  const { invocations, get } = await startApp(t, () => new Promise(() => undefined));
  get("leave-button").click();
  await flush();
  assert.ok(invocations.includes("plugin:window|close"));
  assert.equal(get("announcer").textContent, "");
});
