import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("APK verification errors stay visible when the release workflow captures the certificate", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "android-apk-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const buildTools = join(directory, "build-tools", "35.0.0");
  const ndk = join(directory, "ndk");
  mkdirSync(buildTools, { recursive: true });
  mkdirSync(join(ndk, "toolchains", "llvm", "prebuilt"), { recursive: true });
  // Reject the package before later checks; no SDK, real APK or signing material is needed.
  writeFileSync(join(buildTools, "aapt2"), "#!/usr/bin/env bash\necho \"package: name='wrong.package'\"\n", {
    mode: 0o755,
  });
  writeFileSync(join(ndk, "toolchains", "llvm", "prebuilt", "llvm-readelf"), "#!/usr/bin/env bash\nexit 0\n", {
    mode: 0o755,
  });
  const result = spawnSync(
    "bash",
    ["-c", "set -e; cert=$(.github/tools/check-android-apk.sh test.apk release arm64-v8a)"],
    { encoding: "utf8", env: { ...process.env, ANDROID_HOME: directory, NDK_HOME: ndk }, timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /::error::expected dev\.randomframe\.android .*wrong\.package/);
});
