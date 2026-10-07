// Emulator smoke test for the Android build. Needs a booted emulator on adb and a debug APK built with
// RANDOM_FRAME_SYNC_BASE_URL=http://127.0.0.1:8787, which this script serves with an in-memory Sync mock.
//
//   node .github/tools/android-smoke.mjs <debug.apk> [--page-size 16384]
//
// Covers: install and start, Back on the consent screen leaves the app, consent survives nothing but
// acceptance, Back still reaches the app after a relaunch, Sync create stores the secret, and the secret and pairing survive a force-stop.
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const [apk, pageSizeFlag, pageSize] = process.argv.slice(2);
const pkg = "dev.randomframe.android.debug";
const adbPath = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : "adb";
const adb = (...args) => execFileSync(adbPath, args, { encoding: "utf8" }).trim();
const check = (ok, message) => {
  if (!ok) throw new Error(`Smoke failed: ${message}`);
  process.stdout.write(`ok - ${message}\n`);
};

// The Sync protocol in miniature: PUT/GET /sync/<id>, numeric ETags, If-None-Match / If-Match.
const store = new Map();
const server = createServer((request, response) => {
  const id = /^\/sync\/([0-9a-f]{64})$/.exec(request.url)?.[1];
  const token = request.headers.authorization;
  const send = (status, revision, body) => {
    if (revision) response.setHeader("ETag", `"${revision}"`);
    if (body) response.setHeader("Content-Type", "application/octet-stream");
    response.writeHead(status).end(body);
  };
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const entry = id && store.get(id);
    if (!id) return send(404);
    if (request.method === "GET") return entry ? send(200, entry.revision, entry.body) : send(404);
    if (request.headers["if-none-match"] === "*") {
      if (entry) return send(412);
      store.set(id, { token, revision: 1, body: Buffer.concat(chunks) });
      return send(201, 1);
    }
    if (!entry) return send(404);
    if (entry.token !== token) return send(403);
    if (request.headers["if-match"] !== `"${entry.revision}"`) return send(412);
    store.set(id, { token, revision: entry.revision + 1, body: Buffer.concat(chunks) });
    return send(204, entry.revision + 1);
  });
});
await new Promise((resolve) => server.listen(8787, "127.0.0.1", resolve));

const running = () => {
  try {
    return adb("shell", "pidof", pkg) !== "";
  } catch {
    return false;
  }
};
const resumed = () =>
  /topResumedActivity=.*dev\.randomframe\.android\.debug\//.test(adb("shell", "dumpsys", "activity", "activities"));
async function launch() {
  adb("shell", "am", "start", "-W", "-n", `${pkg}/dev.randomframe.android.MainActivity`);
  for (let i = 0; i < 30 && !running(); i++) await sleep(500);
  await sleep(4000);
}

// Evaluates an expression in the app's WebView through its DevTools socket (debug builds only).
async function evaluate(expression) {
  const pid = adb("shell", "pidof", pkg);
  adb("forward", "--remove-all");
  adb("forward", "tcp:9229", `localabstract:webview_devtools_remote_${pid}`);
  let page;
  for (let attempt = 0; attempt < 20 && !page; attempt++) {
    try {
      const pages = await (await fetch("http://127.0.0.1:9229/json")).json();
      page = pages.find((candidate) => candidate.type === "page");
    } catch {
      // The process can start before its WebView DevTools socket is ready.
    }
    if (!page) await sleep(250);
  }
  if (!page) throw new Error("Smoke failed: WebView DevTools page is unavailable");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      id: 1,
      method: "Runtime.evaluate",
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
  const reply = await new Promise((resolve) =>
    socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true }),
  );
  socket.close();
  if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result?.result?.value;
}
const invoke = (command) =>
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}).catch((error) => ({ error }))`;

try {
  const actualPageSize = adb("shell", "getconf", "PAGE_SIZE");
  if (pageSizeFlag === "--page-size") check(actualPageSize === pageSize, `device page size is ${pageSize}`);
  adb("reverse", "tcp:8787", "tcp:8787");
  adb("install", "-r", apk);
  adb("shell", "pm", "clear", pkg);

  await launch();
  check(running(), "app starts");
  check((await evaluate("document.querySelector('#entry-dialog').open")) === true, "consent screen shows first");

  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await sleep(2000);
  check(!resumed(), "Back on the consent screen leaves the app");

  await launch();
  check((await evaluate("document.querySelector('#entry-dialog').open")) === true, "consent is asked again");
  await evaluate(
    "document.querySelector('#entry-consent').click(); document.querySelector('#entry-button').click(); true",
  );
  await sleep(500);
  check((await evaluate("document.querySelector('#entry-dialog').open")) === false, "accepting consent closes it");
  // The WebView writes localStorage to disk lazily; a kill within seconds asks for consent again (safe side).
  await sleep(12000);

  const created = await evaluate(invoke("create_sync"));
  check(created?.status?.paired === true, `Sync create pairs this device (${JSON.stringify(created?.error ?? "")})`);
  const key = await evaluate(invoke("get_sync_recovery_key"));

  adb("shell", "am", "force-stop", pkg);
  await launch();
  check((await evaluate("document.querySelector('#entry-dialog').open")) === false, "consent survives a restart");
  check(
    (await evaluate(
      "document.documentElement.dataset.platform === 'android' && getComputedStyle(document.querySelector('.viewer')).visibility === 'visible' && getComputedStyle(document.querySelector('#draw-button')).visibility === 'visible'",
    )) === true,
    "cold start shows the Android viewer and Draw before opening a menu",
  );
  await evaluate("document.querySelector('#tools-menu').showPopover(); true");
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await sleep(1000);
  check(resumed(), "after a relaunch, Back closes the open menu instead of leaving");
  check(
    (await evaluate("document.querySelector('#tools-menu').matches(':popover-open')")) === false,
    "the menu is closed",
  );
  const status = await evaluate(invoke("get_sync_status"));
  check(status?.paired === true && status?.state === "idle", `Sync stays paired after a force-stop (${status?.state})`);
  check((await evaluate(invoke("get_sync_recovery_key"))) === key, "the stored secret survives a force-stop");
  check((await evaluate(invoke("sync_now")))?.state === "idle", "Sync runs after the restart");
} finally {
  server.close();
  try {
    adb("forward", "--remove-all");
    adb("reverse", "--remove-all");
  } catch {
    // The device may already be gone.
  }
}
