// Emulator smoke test for the Android build. Needs a booted emulator on adb and a debug APK built with
// RANDOM_FRAME_SYNC_BASE_URL=http://127.0.0.1:8787, which this script serves with a bounded in-memory v2 storage mock (not a security test).
//
//   node .github/tools/android-smoke.mjs <debug.apk> [--page-size 16384]
//
// Covers: install and start, Back on the consent screen leaves the app, consent survives nothing but
// acceptance, Back still reaches the app after a relaunch, Sync create stores the secret, and the secret and pairing survive a force-stop.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// Storage smoke only: this bounded mock implements create/snapshot for one HEAD per group.
// Security, revocation and recovery are tested against the real Rust/SQLite server by client E2Es.
const store = new Map();
const hash = (token) => createHash("sha256").update(token).digest("hex");
const frame = (metadata, payload = Buffer.alloc(0)) => {
  const json = Buffer.from(JSON.stringify(metadata));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(json.length);
  return Buffer.concat([prefix, json, payload]);
};
const server = createServer((request, response) => {
  const match = /^\/sync\/v2\/groups\/([0-9a-f]{64})\/(create|snapshot)$/.exec(request.url ?? "");
  response.setHeader("Cache-Control", "no-store");
  const send = (status, metadata, payload) => {
    const body = metadata ? (payload ? frame(metadata, payload) : Buffer.from(JSON.stringify(metadata))) : undefined;
    if (body) response.setHeader("Content-Type", payload ? "application/octet-stream" : "application/json");
    response.writeHead(status).end(body);
  };
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > 67108864) request.destroy();
    else chunks.push(chunk);
  });
  request.on("end", () => {
    if (!match) return send(404);
    const [, id, route] = match;
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (!/^[0-9a-f]{64}$/.test(token)) return send(404);
    let entry = store.get(id);
    if (request.method === "GET") {
      if (!entry || entry.tokenVerifier !== hash(token)) return send(404);
      return send(200, entry.control, entry.payload);
    }
    try {
      const body = Buffer.concat(chunks);
      if (body.length < 4) return send(400);
      const len = body.readUInt32BE();
      if (len > 1048576 || len > body.length - 4) return send(400);
      const req = JSON.parse(body.subarray(4, 4 + len));
      const mutation = req.mutation;
      const payload = body.subarray(4 + len);
      if (route === "create" && mutation.kind === "create") {
        if (entry) return send(412);
        const member = mutation.member;
        if (member.tokenVerifier !== hash(token) || req.expectedRevision !== 0 || req.expectedEpoch !== 0)
          return send(404);
        entry = {
          tokenVerifier: member.tokenVerifier,
          payload,
          control: {
            protocolVersion: 2,
            groupId: id,
            masterMemberId: member.memberId,
            state: "active",
            epoch: 1,
            revision: 1,
            keyId: mutation.key_id,
            snapshotSchemaFloor: 2,
            recoveryGeneration: 1,
            recoveryPublicKey: mutation.recovery.publicKey,
            thisMemberId: member.memberId,
            members: [
              {
                memberId: member.memberId,
                deviceId: member.deviceId,
                credentialVersion: 1,
                wrappingPublicKey: member.wrappingPublicKey,
                status: "active",
                joinedAtMs: Date.now(),
              },
            ],
            keyPackage: mutation.packages.find(
              (p) => p.recipientKind === "member" && p.recipientId === member.memberId,
            ),
          },
        };
        store.set(id, entry);
      } else if (route === "snapshot" && mutation.kind === "snapshot") {
        if (!entry || entry.tokenVerifier !== hash(token)) return send(404);
        if (
          req.expectedRevision !== entry.control.revision ||
          req.expectedEpoch !== entry.control.epoch ||
          mutation.credential_version !== 1 ||
          mutation.key_id !== entry.control.keyId
        )
          return send(412);
        entry.payload = payload;
        entry.control.revision++;
      } else return send(405);
      return send(200, {
        operationId: req.operationId,
        revision: entry.control.revision,
        epoch: 1,
        recoveryGeneration: 1,
      });
    } catch {
      return send(400);
    }
  });
});
const selfTest = apk === "--self-test";
await new Promise((resolve) => server.listen(selfTest ? 0 : 8787, "127.0.0.1", resolve));
if (selfTest) {
  try {
    const id = "ab".repeat(32),
      token = "cd".repeat(32),
      memberId = "ef".repeat(16);
    const url = `http://127.0.0.1:${server.address().port}/sync/v2/groups/${id}`;
    const member = { memberId, deviceId: memberId, tokenVerifier: hash(token), wrappingPublicKey: "12".repeat(32) };
    const metadata = {
      operationId: memberId,
      expectedRevision: 0,
      expectedEpoch: 0,
      mutation: {
        kind: "create",
        member,
        recovery: { publicKey: "34".repeat(32) },
        key_id: "56".repeat(32),
        packages: [{ recipientKind: "member", recipientId: memberId }],
      },
    };
    const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" };
    assert.equal(
      (await fetch(`${url}/create`, { method: "POST", headers: auth, body: frame(metadata, Buffer.from("opaque")) }))
        .status,
      200,
    );
    assert.equal(
      (await fetch(`${url}/snapshot`, { headers: { Authorization: `Bearer ${"00".repeat(32)}` } })).status,
      404,
    );
    const got = await fetch(`${url}/snapshot`, { headers: auth });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("cache-control"), "no-store");
    const bytes = Buffer.from(await got.arrayBuffer());
    assert.equal(bytes.subarray(4 + bytes.readUInt32BE()).toString(), "opaque");
    metadata.expectedRevision = 1;
    metadata.expectedEpoch = 1;
    metadata.mutation = { kind: "snapshot", credential_version: 1, key_id: "56".repeat(32) };
    assert.equal(
      (await fetch(`${url}/snapshot`, { method: "PUT", headers: auth, body: frame(metadata, Buffer.from("next")) }))
        .status,
      200,
    );
    assert.equal(
      (await fetch(`${url}/snapshot`, { method: "PUT", headers: auth, body: frame(metadata, Buffer.from("stale")) }))
        .status,
      412,
    );
    process.stdout.write("ok - bounded v2 Android storage mock validates tokens and CAS\n");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  process.exit(0);
}

const processId = () => {
  try {
    return adb("shell", "pidof", pkg);
  } catch (error) {
    // pidof reports no match with status 1 and no output; adb transport errors can also exit 1.
    if (error.status === 1 && !error.stdout?.toString().trim() && !error.stderr?.toString().trim()) return "";
    throw error;
  }
};
const running = () => processId() !== "";
const resumed = () =>
  /topResumedActivity=.*dev\.randomframe\.android\.debug\//.test(adb("shell", "dumpsys", "activity", "activities"));
async function launch() {
  let failure;
  try {
    // Back can return to the launcher before Tauri finishes destroying its process. Android's -S
    // stops that old process before starting, so this cannot relaunch an activity already exiting.
    const result = adb("shell", "am", "start", "-S", "-W", "-n", `${pkg}/dev.randomframe.android.MainActivity`);
    process.stdout.write(`${result}\n`);
    if (!/^Status: ok$/m.test(result)) throw new Error("activity launch did not succeed");
    const pid = processId();
    if (!pid) throw new Error("app did not stay running after launch");
    // Observe the same process throughout the existing four-second liveness window, not only at
    // its endpoints: Android can kill and recreate a foreground process under memory pressure.
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      const current = processId();
      if (!current) throw new Error("app did not stay running after launch");
      if (current !== pid) throw new Error(`app process changed after launch (${pid} -> ${current})`);
    }
    if (!resumed()) throw new Error("app did not reach the foreground after launch");
    process.stdout.write(`ok - app process ${pid} stayed running in the foreground\n`);
    return;
  } catch (error) {
    failure = error.message;
  }

  let diagnostics = "";
  try {
    diagnostics += `\nActivity state:\n${adb("shell", "dumpsys", "activity", "activities")
      .split("\n")
      .filter((line) => line.includes(pkg) || /ResumedActivity|mFocusedApp/.test(line))
      .join("\n")}`;
  } catch (error) {
    diagnostics += `\nActivity diagnostics unavailable: ${error.message}`;
  }
  try {
    diagnostics += `\nProcess exit history:\n${adb("shell", "dumpsys", "activity", "exit-info", pkg)}`;
    diagnostics += `\nMemory state:\n${adb("shell", "cat", "/proc/meminfo")}`;
  } catch (error) {
    diagnostics += `\nProcess diagnostics unavailable: ${error.message}`;
  }
  try {
    const uid = adb("shell", "pm", "list", "packages", "-U", pkg).match(/\buid:(\d+)/)?.[1];
    if (uid) diagnostics += `\nApp logcat:\n${adb("logcat", "-d", "--uid", uid, "-t", "200")}`;
    diagnostics += `\nCrash logcat:\n${adb("logcat", "-d", "-b", "crash", "-t", "200")}`;
    diagnostics += `\nLaunch and memory logcat:\n${adb(
      "logcat",
      "-d",
      "-t",
      "200",
      "ActivityManager:I",
      "ActivityTaskManager:I",
      "lowmemorykiller:I",
      "*:S",
    )}`;
  } catch (error) {
    diagnostics += `\nLogcat diagnostics unavailable: ${error.message}`;
  }
  throw new Error(`Smoke failed: ${failure}${diagnostics}`);
}

async function installApk() {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      adb("install", "-r", apk);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await sleep(2000);
    }
  }
  throw lastError;
}

// Evaluates an expression in the app's WebView through its DevTools socket (debug builds only).
async function evaluate(expression) {
  const pid = processId();
  if (!pid) throw new Error("Smoke failed: app is not running before DevTools discovery");
  adb("forward", "--remove-all");
  adb("forward", "tcp:9229", `localabstract:webview_devtools_remote_${pid}`);
  const deadline = Date.now() + 30000;
  let page;
  let discoveryError;
  let failure;
  // A foreground activity can precede WebView readiness, especially after a cold relaunch on CI.
  while (Date.now() < deadline && !page) {
    const current = processId();
    if (current !== pid) {
      failure = `app process changed (${pid} -> ${current || "exited"}) during DevTools discovery`;
      break;
    }
    try {
      const pages = await (
        await fetch("http://127.0.0.1:9229/json", {
          signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
        })
      ).json();
      page = pages.find((candidate) => candidate.type === "page");
      discoveryError = `DevTools targets: ${JSON.stringify(pages)}`;
    } catch (error) {
      discoveryError = `${error.message}${error.cause ? `: ${error.cause.message}` : ""}`;
    }
    if (!page) await sleep(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  if (!page) {
    let diagnostics = "";
    for (const args of [
      ["shell", "dumpsys", "activity", "exit-info", pkg],
      ["logcat", "-d", "--pid", pid, "-t", "200"],
    ]) {
      try {
        diagnostics += `\n${args.join(" ")}:\n${adb(...args)}`;
      } catch (error) {
        diagnostics += `\nDiagnostics unavailable: ${error.message}`;
      }
    }
    throw new Error(
      `Smoke failed: ${failure ?? "WebView DevTools page is unavailable after 30 seconds"}${discoveryError ? `: ${discoveryError}` : ""}${diagnostics}`,
    );
  }
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
  await installApk();
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
  const historyBefore = await evaluate(invoke("get_history"));
  adb("shell", "am", "force-stop", pkg);
  const prefsPath = "shared_prefs/keyring-random-frame-sync.xml";
  const prefs = adb("shell", "run-as", pkg, "cat", prefsPath);
  let changed = false;
  const damaged = prefs.replace(
    /(<string name="[^"\n]*sync\.v2[^"\n]*">)([^<]+)(<\/string>)/,
    (_all, prefix, value, suffix) => {
      const bytes = Buffer.from(value, "base64");
      check(bytes.length > 16, "managed credential has an encrypted value");
      bytes[bytes.length - 1] ^= 1;
      changed = true;
      return prefix + bytes.toString("base64") + suffix;
    },
  );
  check(changed, "managed credential is in the excluded Android store");
  const writePrefs = (value) =>
    execFileSync(adbPath, ["shell", `run-as ${pkg} sh -c 'cat > ${prefsPath}'`], {
      input: value,
      stdio: ["pipe", "ignore", "pipe"],
    });
  try {
    writePrefs(damaged);
    await launch();
    const denied = await evaluate(invoke("get_sync_status"));
    check(
      ["secure_storage", "corrupt_local_state"].includes(denied?.error?.category),
      "damaged Keystore ciphertext fails closed instead of unpairing",
    );
    check(
      JSON.stringify(await evaluate(invoke("get_history"))) === JSON.stringify(historyBefore),
      "Keystore failure preserves local history",
    );
    check(
      (await evaluate(invoke("create_sync")))?.error?.category === "already_paired",
      "Keystore failure cannot silently create a replacement group",
    );
  } finally {
    adb("shell", "am", "force-stop", pkg);
    writePrefs(prefs);
  }
} finally {
  server.close();
  try {
    adb("forward", "--remove-all");
    adb("reverse", "--remove-all");
  } catch {
    // The device may already be gone.
  }
}
