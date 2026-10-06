import assert from "node:assert/strict";
import test from "node:test";
import { android, desktopOnly, flush, startApp } from "./platform-fixture.mjs";

test("Android retries a failed capability check, then starts Sync without any desktop-only IPC", async (t) => {
  let failing = true;
  const { invocations, removed, get } = await startApp(t, () => {
    if (failing) throw new Error("ipc down");
    return android;
  });
  const platform = await import("../dist/test-client/platform.js");
  // A failed check never guesses the platform: nothing loads and nothing desktop-only runs.
  assert.equal(get("error-state").hidden, false);
  assert.equal(get("retry-button").textContent, "Try again");
  assert.equal(invocations.includes("get_history"), false);
  assert.throws(() => platform.getPlatformCapabilities(), /not initialized/);

  failing = false;
  get("retry-button").click();
  for (let i = 0; i < 4; i++) await flush();
  assert.equal(get("error-state").hidden, true);
  assert.deepEqual(platform.getPlatformCapabilities(), android);
  assert.ok(invocations.includes("get_history"));
  assert.ok(invocations.includes("startup_sync"));
  assert.deepEqual(
    invocations.filter((command) => desktopOnly.test(command)),
    [],
  );
  assert.deepEqual(removed, ["window-controls"]);
  assert.equal(get("titlebar-drag-region").getAttribute("data-tauri-drag-region"), null);
  assert.equal(get("sync-button").hidden, false);
  // Text goes through the native clipboard; images are not offered on Android.
  assert.equal(get("copy-image-button").hidden, true);
  get("source-link").href = "https://prnt.sc/abc123";
  get("copy-link-button").click();
  await flush();
  assert.ok(invocations.includes("plugin:clipboard-manager|write_text"));
  // Returning to the app syncs again, at most every 15 minutes, without drawing a new frame.
  const syncs = () => invocations.filter((command) => command === "startup_sync").length;
  const before = syncs();
  const realNow = Date.now;
  t.after(() => {
    Date.now = realNow;
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  assert.equal(syncs(), before, "a quick return does not sync again");
  const later = realNow() + 16 * 60_000;
  Date.now = () => later;
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  assert.equal(syncs(), before + 1);
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  assert.equal(syncs(), before + 1);
  assert.equal(invocations.includes("get_random_frame"), false);

  // Back belongs to the app's layers, and Leave finishes the activity instead of closing a window.
  assert.ok(invocations.includes("plugin:app|register_listener"));
  get("leave-button").click();
  await flush();
  assert.ok(invocations.includes("exit_app"));
  assert.equal(
    invocations.some((command) => desktopOnly.test(command)),
    false,
  );
});
