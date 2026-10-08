import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function smokeFailure(t, mode) {
  const directory = mkdtempSync(join(tmpdir(), "android-smoke-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const preload = join(directory, "adb.mjs");
  // Run the real script with a fake device, no elapsed time, and an isolated mock-server port.
  writeFileSync(
    preload,
    `import childProcess from 'node:child_process';
import timers from 'node:timers/promises';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
const listen = http.Server.prototype.listen;
http.Server.prototype.listen = function (_port, ...args) { return listen.call(this, 0, ...args); };
let launches = 0;
let probes = 0;
childProcess.execFileSync = (_path, args) => {
  const command = args.join(' ');
  if (command === 'shell getconf PAGE_SIZE') return ${JSON.stringify(mode)} === 'pagesize' ? '4096' : '16384';
  if (command.startsWith('shell am start ')) {
    process.stderr.write('Launch ' + ++launches + '\\n');
    if (${JSON.stringify(mode)} === 'start-error') return 'Error: Activity class does not exist.';
    return 'Status: ok\\nActivity: dev.randomframe.android.debug/dev.randomframe.android.MainActivity';
  }
  if (command === 'shell pidof dev.randomframe.android.debug') {
    if (${JSON.stringify(mode)} === 'dead') throw Object.assign(new Error('no process'), { status: 1 });
    if (${JSON.stringify(mode)} === 'transport') throw Object.assign(new Error('device offline'), { status: 255 });
    return ${JSON.stringify(mode)} === 'background' || ++probes === 1 ? '123' : '456';
  }
  if (command === 'shell pm list packages -U dev.randomframe.android.debug') return 'package:dev.randomframe.android.debug uid:10207';
  if (command === 'shell dumpsys activity activities') return 'topResumedActivity=com.google.android.apps.nexuslauncher/.NexusLauncherActivity';
  if (command === 'shell dumpsys activity exit-info dev.randomframe.android.debug') return 'process=dev.randomframe.android.debug reason=3 (LOW_MEMORY)';
  if (command.startsWith('logcat') && args.includes('crash')) return 'F libc: Fatal signal 6 (SIGABRT)';
  if (command.startsWith('logcat')) return "lowmemorykiller: Kill 'dev.randomframe.android.debug'";
  return '';
};
timers.setTimeout = async () => {};
globalThis.fetch = async () => ({ json: async () => [] });
syncBuiltinESMExports();`,
  );
  const result = spawnSync(
    process.execPath,
    ["--import", preload, ".github/tools/android-smoke.mjs", "test.apk", "--page-size", "16384"],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /ok - app starts/);
  return result.stdout + result.stderr;
}

test("a failed launch is not retried and retains process-exit and crash evidence", (t) => {
  const output = smokeFailure(t, "dead");
  assert.match(output, /LOW_MEMORY/);
  assert.match(output, /SIGABRT/);
  assert.match(output, /lowmemorykiller/);
  assert.doesNotMatch(output, /Launch 2/);
});

test("a replacement process cannot satisfy launch liveness", (t) => {
  assert.match(smokeFailure(t, "restart"), /process changed/);
});

test("an adb transport failure is not treated as an absent app process", (t) => {
  assert.match(smokeFailure(t, "transport"), /device offline/);
});

test("a live process without a foreground activity does not pass", (t) => {
  assert.match(smokeFailure(t, "background"), /did not reach the foreground/);
});

test("am start errors fail even when adb exits successfully", (t) => {
  assert.match(smokeFailure(t, "start-error"), /activity launch did not succeed/);
});

test("the 16 KB page-size guard fails before launch on a 4 KB device", (t) => {
  const output = smokeFailure(t, "pagesize");
  assert.match(output, /Smoke failed: device page size is 16384/);
  assert.doesNotMatch(output, /Launch 1/);
});
