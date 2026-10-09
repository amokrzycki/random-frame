import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const fingerprint = "54c5acacf09af07d08e5cb95161fec477a92ac29b34196b11d0df2d05b60bbb1";
const signatureCheck = readFileSync(".github/tools/check-android-apk.sh", "utf8").split(
  'if [ "$mode" = release ]; then\n',
)[1];
const publishCheck = readFileSync(".github/workflows/release.yml", "utf8").match(/^\s*cert=\$\(.*<<<"\$certs".*$/m)[0];

for (const [label, certificates, status] of [
  ["numbered signers", `Signer #1 certificate SHA-256 digest: ${fingerprint}`, 0],
  ["SDK-scoped signers", `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${fingerprint}`, 0],
  ["Build Tools 37 signers", `V3.0 Signer: certificate SHA-256 digest: ${fingerprint}`, 0],
  [
    "repeated schemes",
    `V3.1 Signer: certificate SHA-256 digest: ${fingerprint}\nV3.0 Signer: certificate SHA-256 digest: ${fingerprint}`,
    0,
  ],
  [
    "different scheme certificates",
    `V3.1 Signer: certificate SHA-256 digest: ${fingerprint}\nV3.0 Signer: certificate SHA-256 digest: ${"0".repeat(64)}`,
    1,
  ],
]) {
  test(`release verification and publishing ${status === 0 ? "accept" : "reject"} ${label}`, {
    skip: process.platform === "win32",
  }, (t) => {
    const directory = mkdtempSync(join(tmpdir(), "android-signature-test-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, "apksigner"), '#!/usr/bin/env bash\nprintf "%s\\n" "$CERTIFICATES"\n', {
      mode: 0o755,
    });
    const certs = `Verifies\n${certificates}\nSource Stamp Signer certificate SHA-256 digest: ${"0".repeat(64)}`;
    for (const check of [`cert=$(if true; then\n${signatureCheck}\n)`, publishCheck]) {
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -euo pipefail
fail() { echo "$*" >&2; exit 1; }
apk=test.apk
build_tools=$1
package=dev.randomframe.android
version=0.7.0
version_code=7000
abis=arm64-v8a
certs=$CERTIFICATES
${check}
[ "$cert" = "$EXPECTED_CERT" ]
`,
          "signature-test",
          directory,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, CERTIFICATES: certs, EXPECTED_CERT: fingerprint },
          timeout: 5000,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.status, status, result.stdout + result.stderr);
    }
  });
}
