# Native Android fixture run

This optional slice uses the actual Tauri Android APK and Android WebView. It is separate from the Linux release matrix. The available Android 15 experimental 16 KiB emulator image has crashed `system_server`; never accept a run spanning a system restart. There is no physical-device or release-build claim.

Use a new isolated AVD named `rf-performance`, on emulator port 5580. Do not reuse a personal AVD. Every runner command specifies `emulator-5580` and checks the AVD name and emulator property. The runner clears only its synthetic debug package. No USB device is used.

The installed image is `system-images;android-35;google_apis_ps16k;x86_64`, device `pixel_6`, RAM 6144 MiB, `-no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect`. Keep its AVD directory under `/tmp/rf-native-android/avd` using `ANDROID_AVD_HOME`. The SDK is `$HOME/Android/Sdk`; JDK 17 and NDK 28.2.13676358 are installed. These tools were outside PATH.

Prepare a disposable source copy from the project root:

```bash
node performance/android-prepare.mjs /tmp/rf-native-android/before --baseline
node performance/android-prepare.mjs /tmp/rf-native-android/after
```

The helper uses the same IPC span wrapper, probe and current workload as Linux. The retained Android runs used v7; the current v8 driver additionally asserts each navigation's selected index and decoded target blob image after the final review. Android was not rerun with v8. The helper replaces only the disposable Prnt.sc fixture destination with Android loopback port 18787, adds config/report commands, preaccepts consent for the synthetic profile, and disables update checks. Config uses eight retained samples and no long soak. It embeds a minified frontend and leaves production files untouched. The shared frontend-build section is extracted from the adjacent `native-build.mjs`; keep those harness files together. The build hook is disabled in the copy so it cannot overwrite the prepared frontend.

Build each variant sequentially, from its own copy:

```bash
ANDROID_HOME="$HOME/Android/Sdk" \
NDK_HOME="$HOME/Android/Sdk/ndk/28.2.13676358" \
JAVA_HOME=/usr/lib/jvm/java-17-openjdk \
CARGO_TARGET_DIR=/tmp/rf-native-android/cargo-target \
GRADLE_USER_HOME=/tmp/rf-native-android/gradle \
npm run tauri -- android build --debug --target x86_64 --apk --ci
```

Use an isolated Gradle home with cached dependencies; do not copy signing credentials. The measured environment redirected Gradle project outputs to `/tmp/rf-native-android/gradle-build` through a temporary init script. Therefore its real APK was `/tmp/rf-native-android/gradle-build/android/app/outputs/apk/universal/debug/app-universal-debug.apk`, even though the CLI printed the usual project path. Copy each APK to a distinct filename before building the next variant. Changing source-copy paths while sharing Cargo artifacts can omit generated `TauriActivity.kt` / Wry classes; cleaning only the temporary target's `tauri` and `wry` packages for `x86_64-linux-android` regenerated them. This was a harness build-cache issue, not a source fix.

From the project root, with the emulator booted:

```bash
PYTHONDONTWRITEBYTECODE=1 python performance/android-run.py /tmp/rf-native-android/before.apk --count 100 --runs 2 --output /tmp/rf-native-android/before-100
PYTHONDONTWRITEBYTECODE=1 python performance/android-run.py /tmp/rf-native-android/after.apk --count 100 --runs 2 --output /tmp/rf-native-android/after-100
```

Repeat with `--count 1000` and fresh output directories. The runner creates the same deterministic JPEGs and native JSON as Linux, seeds Android's **app data root** and `cache/thumbnails`, and forwards the device fixture port to its own local HTTP server. `--installed` skips installation for a known already installed APK; it still resets the synthetic profile. Earlier seeding under `files/` was wrong and supplied no accepted timings.

`startup.ready` is measured from **WebView time origin**, followed by the same decoded restored blob predicate and two rAF callbacks. The Linux-only `launchToTimeOrigin` field uses constant config launch=0 on Android and must not be used. `am start -W` is retained separately as activity launch evidence; it is not time to interactive. The first run uses a fresh profile, the second reopens it; OS disk cache is uncontrolled. No Android CPU or peak process-tree RSS comparison is claimed. End-of-run `dumpsys meminfo`, system crashes and exit records are diagnostic artifacts.

Stop only this AVD with `adb -s emulator-5580 emu kill` after collecting artifacts. Do not stop the host ADB server or change any physical device's authorization.
