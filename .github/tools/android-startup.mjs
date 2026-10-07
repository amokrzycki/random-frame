// Non-destructive regression check on a device with an accepted consent screen and a selected frame.
// node .github/tools/android-startup.mjs SERIAL [APK]
// Optional APK is installed as an update. No pm clear, uninstallation, Sync mock, or secret reads.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const [serial, apk] = process.argv.slice(2);
assert.ok(serial, "Pass the exact adb device serial");
const pkg = "dev.randomframe.android.debug";
const activity = `${pkg}/dev.randomframe.android.MainActivity`;
const adbPath = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : "adb";
const adb = (...args) => execFileSync(adbPath, ["-s", serial, ...args], { encoding: "utf8" }).trim();
let port;
let socket;
let nextId = 0;
let javascriptErrors = 0;
const pending = new Map();
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`DevTools timed out: ${method}`));
    }, 5000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      if (reply.error) reject(new Error(reply.error.message));
      else resolve(reply.result);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
async function connect() {
  javascriptErrors = 0;
  const pid = adb("shell", "pidof", pkg);
  port = adb("forward", "tcp:0", `localabstract:webview_devtools_remote_${pid}`);
  let page;
  for (let attempt = 0; attempt < 20 && !page; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = pages.find((page) => page.type === "page" && page.url.startsWith("http://tauri.localhost"));
    } catch {
      // The process starts before its WebView DevTools socket is ready.
    }
    if (!page) await sleep(250);
  }
  assert.ok(page, "The app's WebView DevTools page is available");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.addEventListener("message", (event) => {
    const reply = JSON.parse(event.data);
    if (
      reply.method === "Runtime.exceptionThrown" ||
      (reply.method === "Runtime.consoleAPICalled" && reply.params.type === "error")
    )
      javascriptErrors++;
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  await call("Runtime.enable");
}
async function evaluate(expression) {
  const reply = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!reply.exceptionDetails, "WebView evaluation completes without an exception");
  return reply.result.value;
}
function disconnect() {
  socket?.close();
  socket = undefined;
  if (port) adb("forward", "--remove", `tcp:${port}`);
  port = undefined;
}
async function waitForFrame(label) {
  let result;
  for (let attempt = 0; attempt < 40; attempt++) {
    // Pure DOM reads only: an extra invoke here can wake a broken native IPC queue and hide the bug.
    result = await evaluate(`(() => {
      if (document.readyState === 'loading') return { domReady: false };
      const image = document.querySelector('#image');
      const zoom = document.querySelector('#image-zoom');
      const info = document.querySelector('#info-actions');
      const rect = image.getBoundingClientRect();
      return { elapsedMs: Math.round(performance.now()), platform: document.documentElement.dataset.platform, imageHidden: zoom.hidden,
        imageComplete: image.complete, naturalWidth: image.naturalWidth, width: rect.width, height: rect.height,
        opacity: getComputedStyle(image).opacity, metadataHidden: info.hidden,
        drawDisabled: document.querySelector('#draw-button').getAttribute('aria-disabled'),
        consentOpen: document.querySelector('#entry-dialog').open, errorHidden: document.querySelector('#error-state').hidden };
    })()`);
    if (
      result.platform === "android" &&
      !result.imageHidden &&
      result.imageComplete &&
      result.naturalWidth > 1 &&
      result.width > 0 &&
      result.height > 0 &&
      result.opacity === "1" &&
      !result.metadataHidden &&
      result.drawDisabled === "false" &&
      !result.consentOpen &&
      result.errorHidden
    ) {
      assert.equal(javascriptErrors, 0, "Startup has no JavaScript exceptions or console errors");
      process.stdout.write(`ok - ${label}: ${JSON.stringify(result)}\n`);
      return;
    }
    await sleep(500);
  }
  assert.fail(`${label}: frame did not become ready without interaction: ${JSON.stringify(result)}`);
}

try {
  if (apk) adb("install", "-r", apk);
  for (let run = 1; run <= 3; run++) {
    adb("shell", "am", "force-stop", pkg);
    adb("shell", "am", "start", "-W", "-n", activity);
    await connect();
    await waitForFrame(`cold start ${run}`);
    disconnect();
  }
  // Return from Home preserves the running process and its WebView.
  const pid = adb("shell", "pidof", pkg);
  adb("shell", "input", "keyevent", "KEYCODE_HOME");
  await sleep(2000);
  adb("shell", "am", "start", "-W", "-n", activity);
  assert.equal(adb("shell", "pidof", pkg), pid, "Returning from background keeps the same process");
  await connect();
  await waitForFrame("return from background");
} finally {
  disconnect();
}
