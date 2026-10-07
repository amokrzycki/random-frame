#!/usr/bin/env bash
# Verifies a built Random Frame APK before anyone installs or publishes it.
#
#   .github/tools/check-android-apk.sh <apk> <debug|release> <abi>...
#
# Checks the package identity and Tauri-derived version, the permission policy, cleartext traffic,
# the native ABIs, 16 KB ELF alignment of every .so, 16 KB zip alignment, and (release) the signature.
# Needs ANDROID_HOME, NDK_HOME and Node; prints the signing certificate's SHA-256 for release builds.
set -euo pipefail

apk=$1
mode=$2
shift 2
expected_abis=$(printf '%s\n' "$@" | sort | tr '\n' ' ')

build_tools=$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -1)
readelf=$(find "$NDK_HOME/toolchains/llvm/prebuilt" -name llvm-readelf | head -1)
fail() {
  echo "::error::$*"
  exit 1
}
[ -x "$build_tools/aapt2" ] && [ -x "$readelf" ] || fail "Android build-tools or NDK llvm-readelf not found"

version=$(node -p 'require("./package.json").version')
IFS=. read -r major minor patch <<<"${version%%-*}"
((minor < 1000 && patch < 1000)) || fail "minor and patch must stay below 1000 for Tauri's versionCode"
version_code=$((major * 1000000 + minor * 1000 + patch))
package=dev.randomframe.android
[ "$mode" = debug ] && package=$package.debug

badging=$("$build_tools/aapt2" dump badging "$apk")
grep -q "^package: name='$package' versionCode='$version_code' versionName='$version'" <<<"$badging" ||
  fail "expected $package $version ($version_code), got: $(head -1 <<<"$badging")"
grep -q "^minSdkVersion:'24'" <<<"$badging" || fail "minSdkVersion is not 24"

permissions=$(grep -o "^uses-permission: name='[^']*'" <<<"$badging" | cut -d"'" -f2 | sort)
grep -qx android.permission.INTERNET <<<"$permissions" || fail "INTERNET permission is missing"
forbidden=$(grep -E 'REQUEST_INSTALL_PACKAGES|EXTERNAL_STORAGE|READ_MEDIA_|QUERY_ALL_PACKAGES' <<<"$permissions" || true)
[ -z "$forbidden" ] || fail "forbidden permissions: $forbidden"

manifest=$("$build_tools/aapt2" dump xmltree --file AndroidManifest.xml "$apk")
grep -q 'android:allowBackup.*=false' <<<"$manifest" || fail "backup is not disabled"
if [ "$mode" = release ] && ! grep -q 'android:usesCleartextTraffic.*=false' <<<"$manifest"; then
  fail "release build allows cleartext traffic"
fi

abis=$(unzip -Z1 "$apk" 'lib/*' | cut -d/ -f2 | sort -u | tr '\n' ' ')
[ "$abis" = "$expected_abis" ] || fail "native ABIs are '$abis', expected '$expected_abis'"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
unzip -q "$apk" 'lib/*' -d "$work"
libraries=$(find "$work" -name '*.so')
[ -n "$libraries" ] || fail "no native libraries in the APK"
while IFS= read -r library; do
  # Every LOAD segment must be aligned to at least 16 KB (0x4000) to load on 16 KB page devices.
  alignments=$("$readelf" -lW "$library" | awk '$1 == "LOAD" { print $NF }')
  [ -n "$alignments" ] || fail "$(basename "$library") has no LOAD segments"
  while IFS= read -r alignment; do
    ((alignment >= 16384)) || fail "$(basename "$library") has a LOAD segment aligned to $alignment"
  done <<<"$alignments"
done <<<"$libraries"
"$build_tools/zipalign" -c -P 16 4 "$apk" || fail "APK is not zip-aligned for 16 KB pages"

if [ "$mode" = release ]; then
  certs=$("$build_tools/apksigner" verify --verbose --print-certs "$apk") || fail "signature does not verify"
  grep -q 'Signer #1 certificate SHA-256 digest' <<<"$certs" || fail "no signing certificate"
  grep -qi 'CN=Android Debug' <<<"$certs" && fail "signed with a debug key"
  grep -m1 'Signer #1 certificate SHA-256 digest' <<<"$certs" | awk '{print $NF}'
fi
echo "APK checks passed: $package $version ($version_code), ABIs $abis" >&2
