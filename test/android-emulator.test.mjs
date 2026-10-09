import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function waitForBoot(t, scenario) {
  const directory = mkdtempSync(join(tmpdir(), "android-boot-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const action = readFileSync(new URL("../.github/actions/android-smoke/action.yml", import.meta.url), "utf8");
  const script = action.match(/ {8}deadline=.*?(?=\n {4}- name: Smoke test)/s)[0].replace(/^ {8}/gm, "");
  const result = spawnSync(
    "bash",
    [
      "-e",
      "-o",
      "pipefail",
      "-c",
      `state_dir=$1
scenario=$2
adb=adb
emulator_pid=1
log=/dev/null
unset SECONDS
SECONDS=0
echo 0 > "$state_dir/poll"
kill() { return 0; }
sleep() { SECONDS=$((SECONDS + 5)); }
adb() {
  local poll
  poll=$(cat "$state_dir/poll")
  case "$*" in
    get-state) echo $((poll + 1)) > "$state_dir/poll"; echo device ;;
    'shell getprop sys.boot_completed') echo 1 ;;
    'shell getprop init.svc.bootanim')
      if [ "$scenario" = animation ]; then echo running; else echo stopped; fi ;;
    'shell pm path android') echo package:/system/framework/framework-res.apk ;;
    'shell service check activity')
      if [ "$scenario" = services ] && (( poll <= 4 )); then
        echo 'Service activity: not found'
      else
        echo 'Service activity: found'
      fi ;;
    'shell pidof system_server')
      if [ "$scenario" = restart ] && (( poll > 4 )); then echo 200; else echo 100; fi ;;
    *) echo "Unexpected adb command: $*" >&2; return 1 ;;
  esac
}
${script}
echo "ready at $SECONDS"
`,
      "boot-test",
      directory,
      scenario,
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  return result;
}

// The composite action runs only on Linux; exercise its actual Bash readiness loop.
test("boot completion alone does not bypass the settling window", { skip: process.platform === "win32" }, (t) => {
  const result = waitForBoot(t, "ready");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready at 30\b/);
});

test("missing activity services delay readiness", { skip: process.platform === "win32" }, (t) => {
  const result = waitForBoot(t, "services");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready at 50\b/);
});

test("a system-server restart resets the settling window", { skip: process.platform === "win32" }, (t) => {
  const result = waitForBoot(t, "restart");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready at 50\b/);
});

test("an unfinished boot animation times out instead of starting smoke", {
  skip: process.platform === "win32",
}, (t) => {
  const result = waitForBoot(t, "animation");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /did not finish booting within 600 seconds/);
  assert.doesNotMatch(result.stdout, /ready at/);
});
