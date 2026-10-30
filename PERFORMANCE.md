# Performance audit — 2026-10-29, extended 2026-10-30

The October 29 phase below records four component optimizations and their original verification boundaries. The **October 30 native validation extension at the end** adds real Linux Tauri/WebKitGTK release-process measurements, further evidence-backed changes, and current limitations. Its internal thumbnail-load IPC format supersedes the prior phase's unchanged-IPC statement; disk files, save commands, sync formats, image retrieval, admission limits, and motion remain unchanged.

## Confirmed bottlenecks and changes

| Severity | Location | Evidence and implementation |
| --- | --- | --- |
| High at large libraries | `src-tauri/src/persistence/favorites.rs`, `projection` | For each distinct Saved item, every save operation was rescanned. 10,000 unique saves took 512.52 ms median in release mode. Group operation IDs by borrowed `(source, id)` once, then consume each group. Preserve the original metadata winner, display order, operation-ID order, concurrent saves, and source identity. Projection now takes 3.15 ms. |
| High at large pinned caches | `src/client/frame-cache.ts`, `thumbnailFor` | A miss or leading-zero alias copied and scanned the entire Map. The ordinary cache limit excludes pinned Saved thumbnails, so 10,000 entries is possible. Probe the at-most-seven spellings of the same base-36 ID instead. Exact spelling still wins; when several other spellings exist, the shortest cached spelling wins. No index or invalidation state is needed. |
| High at large pinned caches | `src/client/frame-cache.ts`, `persistThumbnails` | Every request invoked native saving, including unchanged snapshots. The successful-save bookkeeping also did an array membership scan per saved key, making it quadratic. Keep the last successful disk projection, skip unchanged calls after one successful reconciliation, and use a Set for retained keys. Preserve deletion-only pruning, initial crash-artifact cleanup, serialized saves, pinning, repairs, migration, and retries. |
| Low/medium | `src/client/history-dialog.ts`, `renderHistoryPage` | Every visible tile constructed locale formatting machinery for its timestamp. Use two page-local `Intl.DateTimeFormat` instances. Their lifetime is one render so subsequent renders still pick up locale/time-zone changes. Existing date labels, keyboard focus, page sizes, and animations are preserved. |

`get_saved_library` calls the Rust projection during startup and frontend persisted-view refresh, so its reduction removes work from both paths. **Those complete paths were not timed**: the 512.52 → 3.15 ms result excludes serialization, Tauri transport, disk writes, and frontend refresh.

## Method and reproduction

Baseline production commit: `42091246d6a5d36b4a9b66d1bc22b04134c2e007`. Baselines were recorded before editing the corresponding production functions. The expanded browser collection workload was subsequently rerun against that same original source using the benchmark's `--ref` loader.

Environment: Linux x86_64, Ryzen 7 5800X3D, 64 GiB RAM, Node 26.9.0, Rust 1.99.0, WebKitGTK 2.54.2, Chromium 152/Electron 44. CPU boost and the desktop session remained enabled. This was not an isolated laboratory runner; small differences and P95 outliers should be treated cautiously.

- Fixtures: 100, 1,000, and 10,000 history entries and Saved items. All thumbnails are cached and pinned. This deliberately exercises the uncapped Saved portion of the cache. Browser thumbnails are locally generated valid 1px JPEGs; Node uses minimal encoded data and DOM doubles. These workloads do not represent full-resolution image decoding or real thumbnail byte sizes.
- Collection switching: ten collections with 80% of saves assigned, valid 16-byte operation IDs, two collection switches per sample. Other dialog samples use All saved and no memberships. Browser pagination samples include Next **and** Previous, not one transition.
- Rust: release build, five warmups, 40 timed projections; sorting, grouping, output allocation and membership filtering are included, dropping output is outside the timer. The primary Rust fixture uses unique saves; a separate correctness regression covers concurrent duplicate saves and source identity.
- Frontend: five warmups, 40 samples, nearest-rank P95. Unchanged-save Node measurements use 20 samples. Browser measurements force synchronous layout and yield between samples; they include the existing opening path, skip intentional exit animation using native dialog close, and **do not measure paint completion or animation FPS**.
- Network, upstream rate limiting, native IPC latency, filesystem latency, and sync-server latency are excluded. Native thumbnail commands are mocked and counted; no calls are sent to Prnt.sc. Zero IPC on unchanged requests is a deterministic count, not an estimate of filesystem milliseconds saved.
- WebKit uses an ephemeral profile at 1440×900; Chromium uses the T3 preview viewport. Compare each engine to itself, not across engines. WebKit's observed timer resolution is 1 ms; a recorded zero is reported below as `<1 ms`, not instantaneous.

Raw observations are in [performance/results](performance/results), including a final Node repeat. Browser and Node samples are synthetic component benchmarks, not application startup benchmarks. Large gains reproduced independently in review; small rendering gains have medium confidence, with no statistical confidence interval claimed. The final Node Saved-open repeat was 13.16 ms versus 13.25 ms baseline, effectively unchanged. Chromium's 1,000-entry collection-switch P95 worsened from 27.3 to 47.5 ms while its median was almost unchanged (23.5 → 23.3 ms); collection switching remains a follow-up hotspot.

```bash
# JavaScript work only; no browser, native calls, or network
npm run build:test
node performance/bench-client.mjs

# Native Rust projection, no filesystem/network in the timed loop
cargo test --release --manifest-path src-tauri/Cargo.toml saved_projection_timing -- --ignored --nocapture

# Real DOM/layout with stubbed native commands
npm run build
node performance/build-browser.mjs
python -m http.server 8743 --bind 127.0.0.1 --directory dist
# In a separate terminal, with system PyGObject and WebKit2 4.1 installed:
python performance/webkit.py > after-webkit.json
# Or open http://127.0.0.1:8743/performance.html?autorun in a browser;
# read window.performanceResult after document.title becomes "Benchmark complete".

# Rebuild exactly the same browser workload against baseline production sources:
node performance/build-browser.mjs --ref=42091246d6a5d36b4a9b66d1bc22b04134c2e007
python performance/webkit.py > before-webkit.json
```

Do not rebuild `dist` while a browser run is loading, or run other builds/tests during measurement. The browser builder intentionally writes only to ignored `dist/`; benchmark code is never imported by the production app. WebKit execution times out after 120 seconds.

To reproduce the native baseline, create a separate checkout at the baseline commit, append the current `#[cfg(test)] mod performance_tests` from `favorites.rs` to the baseline version of that file, and run the same release command. Only the benchmark/test module should be transplanted; leave the original `projection` unchanged. For the Node baseline, build the baseline checkout's test modules and run the current `performance/bench-client.mjs` with its `test/dom-fakes.mjs`. The fixtures use unchanged interfaces. No baseline copy of production code is shipped.

## Comparison

All durations are milliseconds, written **median / P95**. Improvement percentages use medians. Each row is **VERIFIED for the stated fixture**, not a universal application speedup.

| Area (10,000 entries) | Before | After | Median improvement | Confidence |
| --- | ---: | ---: | ---: | --- |
| Rust Saved projection | 512.52 / 519.05 | 3.15 / 3.16 | 99.4% | High |
| WebKit History open + forced layout | 29 / 30 | 27 / 28 | 6.9% | Medium |
| WebKit Saved open + forced layout | 29 / 30 | 27 / 29 | 6.9% | Medium |
| WebKit Saved Next + Previous layout | 39 / 41 | 35 / 41 | 10.3% | Medium |
| WebKit two collection switches + layout | 74 / 75 | 69 / 74 | 6.8% | Medium |
| WebKit 100 thumbnail misses | 71 / 72 | <1 / <1 | >98% | High for bounded work; clock floor |
| WebKit unchanged thumbnail persistence | 97 / 98 | 5 / 9 | 94.8% | High |
| WebKit unchanged native save calls, 45 requests | 45 | 0 | 100% | High, deterministic |
| Chromium History open + layout | 23.2 / 30.6 | 21.8 / 29.3 | 6.0% | Medium |
| Chromium Saved open + layout | 25.9 / 33.5 | 23.5 / 27.9 | 9.3% | Medium |
| Chromium Saved Next + Previous layout | 52.1 / 54.8 | 45.8 / 48.4 | 12.1% | Medium |
| Chromium two collection switches + layout | 96.7 / 103.7 | 91.7 / 97.4 | 5.2% | Medium |
| Node 100 alias hits near cache end | 101.445 / 106.495 | 0.029 / 0.030 | >99.9% | High for JS algorithm |
| Node unchanged thumbnail persistence | 39.996 / 40.915 | 4.480 / 4.908 | 88.8% | High for JS algorithm |

Smaller datasets, same method:

| Area | Entries | Before median / P95 | After median / P95 |
| --- | ---: | ---: | ---: |
| Rust Saved projection | 100 | 0.061 / 0.065 | 0.027 / 0.028 |
| Rust Saved projection | 1,000 | 5.203 / 5.432 | 0.315 / 0.369 |

The JSON files contain every smaller-dataset frontend result, including insignificant changes near the timer floor. No memory or CPU percentage improvement is inferred from these timings.

## Prior-phase audit and validation boundaries

These are the October 29 results. The native extension below supersedes rows for which it supplies new evidence.

| Area | Status | Evidence / limit |
| --- | --- | --- |
| Linux backend | VERIFIED | Compiled, formatted, linted, and tested on Linux. Full Rust suite: 240 passed, 22 intentionally ignored. |
| Frontend correctness | VERIFIED | 196 tests passed, including Draw/navigation, history removal/Undo, collections, Stats, startup recovery, stale sync refresh, Nearby cancellation/retry/motion, zoom, keyboard/focus, and pinning. These are primarily DOM/native doubles. |
| Linux rendering engine | PARTIALLY_VERIFIED | Real WebKitGTK DOM/layout fixture ran, with mocked IPC. This is not a packaged Tauri session or a visual/assistive-technology inspection. |
| Full-image retention | PARTIALLY_VERIFIED | Existing regression navigates over 100 frames and checks 20-frame/32 MiB cache bounds, borrowed URLs, outgoing transitions and revocation. Decoded GPU/WebView memory and long-session process RSS were not profiled. |
| History/Saved scrolling | PARTIALLY_VERIFIED | Existing pagination limits DOM to one page; IntersectionObserver queues visible thumbnails, with concurrency three and disconnect on close. Layout work was measured; scroll FPS was not. |
| Nearby 3×3 | PARTIALLY_VERIFIED | Frontend and backend tests verify shared fetches, overlap reuse, handle expiry, retry, cancellation, and handoff. Backend thumbnail encoding already uses `spawn_blocking`; frontend thumbnail alias/persistence improvements apply here. No end-to-end gallery latency or animation-FPS measurement. |
| Sync responsiveness | PARTIALLY_VERIFIED | Refresh already coalesces same-turn requests and rejects stale domains using generations. Backend projection is faster; sync state machine, transactional persistence and crypto were unchanged. Existing convergence/CAS/restore/tombstone/pending-change tests passed. No timed encrypted upload-to-paint workload. |
| Image loading | PARTIALLY_VERIFIED | Full bytes already use binary Tauri responses; keyed raw fetches coalesce viewer/preview work and preserve admission/rate-limit rules. Frontend decodes before committing history. No live upstream requests or network/backend/decode/paint timing split. |
| Cold/warm startup and time to interactive | NOT_TESTED | Component projection improvement is measured; process launch, OS page cache, startup migrations, keyring and restored-frame network effects were not timed. |
| CPU utilization, process memory/retention, physical disk I/O | NOT_TESTED | No platform profiler trace or process resource baseline. IPC count and algorithmic timings cannot establish these metrics. |
| Windows WebView2 | NOT_TESTED | No Windows runtime was available. Chromium on Linux is not WebView2 validation. |
| Android WebView/device | NOT_TESTED | No SDK/device/emulator was exercised. Android mock-script/frontend tests are not native Android validation. |
| Private real-server Sync integration | NOT_TESTED | The separate server binary was not supplied; its ignored tests were not run. Local HTTP fixture sync tests did run. |

Inspected `README.md`, `PRODUCT.md`, `DESIGN.md`, build/test configuration, stage/frame loader, history/Saved projections, viewer refresh, Nearby queue/encoding, frame/thumbnail cache, raw fetch admission, history/Saved persistence, and sync reconciliation. No UI decisions were changed, so the local UX decision ledger was not updated.

## Validation and independent review

Successful commands:

```text
npm run typecheck
npm run lint
npm test                       196 passed
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml    240 passed; 22 ignored
git diff --check
```

Initial sandbox attempts failed because existing tests spawn subprocesses or bind loopback sockets. Reruns with those capabilities enabled passed. A changed retry expectation was updated: after a failed native save, all retained entries are now resent because individual files may have been written before failure. No failed final check is being hidden by excluding a test.

Independent review used a separate default-model agent, read-only, in two rounds. Round one reproduced a P2 partial-write bug in the new unchanged-save fast path: after one file wrote and another failed, Clear could incorrectly skip pruning. The correction invalidates both the success flag and saved projection on failure, forcing a full reconciliation. A regression was observed failing before the correction and passing afterward. The reviewer then independently verified partial repair rollback to previous bytes, retry, queued retry with pinned clear, and queued empty clear, and found no remaining actionable issue. The review also confirmed Rust operation ordering/source identity and reproduced the large benchmark gains. Review checks mocked native I/O; neither round claimed platform or paint validation.

## Follow-up work and monitoring

1. Profile actual cold/warm launches on each supported platform using an isolated synthetic profile, fixed saved selection, and a local fixture server. Record process start → controls enabled → restored frame decoded → paint separately. Report OS-cache state rather than claiming a cold launch after merely restarting the app.
2. Measure full draw/restore with deterministic locally served images, then a separately labelled live upstream sample. Keep request/queue time, backend byte transfer, decoder time and presentation time separate; retain cooldown/backoff unchanged. Add device-scale image dimensions and Android codec coverage before altering decode or binary transfer.
3. Large collection switching still costs about 69–92 ms for two switches in this fixture. Profile repeated operation-ID stringification, uncollected checks and repeated full-list projections before adding generation-scoped indexes. Check sync invalidation and concurrent save operations if introducing them. No speculative state cache was added here.
4. Measure pinned-thumbnail startup bytes and process retention with realistic JPEGs. Startup currently reads every saved thumbnail and expands bytes into base64; pinned Saved thumbnails have no ordinary-cache cap. Consider lazy native thumbnail access only after measuring it, preserving persistence, aliases, clear recovery and offline behavior.
5. Capture main-thread and renderer traces for zoom/pan, progressive Nearby loading, and encrypted sync under realistic device load. Do not remove existing transitions or transactional `fsync` operations to improve a score. History selection still persists the existing whole-file representation; changing that needs a separate durability design and measured disk workload.

Use `npm test` in CI for deterministic complexity/recovery guards: alias lookup must not iterate the cache, unchanged snapshots must issue zero IPC, and partial failures must reconcile. Keep the release Rust and browser benchmarks as local or scheduled CI artifacts on a fixed runner; compare medians/P95 and dataset scaling against a baseline from the same runner, with an initial warning-only budget for timing noise. The scripts operate on synthetic local data, retain no user history, and add no telemetry, analytics, external endpoints, or production instrumentation.

## Native application validation — 2026-10-30

### Method and scope

This extension runs the actual Tauri Rust application and its real frontend under Linux WebKitGTK 2.54.2. It uses release executables, real native IPC, real files and durability operations, real image decoding, and the existing animation and request-admission paths. It is not a component benchmark or a Chromium substitute. Installer/AppImage packaging overhead is excluded: these are Cargo release executables with embedded frontend assets.

`performance/native-build.mjs` prepares disposable source copies under `/tmp`, at the original baseline commit or the current working source. Only those copies receive the report/config commands, frontend probes, and loopback source URLs. The production checkout does not import the instrumentation. The build copies its executable before another variant reuses dependency artifacts. `production.patch` and its SHA-256 identify the working-source delta. No commits, publication, telemetry, user profiles, or upstream Prnt.sc requests are involved. The updater endpoint is disabled identically in both copies. Sync remains disconnected; its real startup and persisted-view refresh commands still execute. The fixture preaccepts the risk acknowledgement, so human consent time is excluded. The window uses the repository configuration (requested 1440×900); physical display scaling and GPU presentation are not independently measured.

`performance/native-run.py` creates isolated XDG data, cache, and config roots. Each profile has 100, 1,000, or 10,000 native History entries and Saved records, sixteen-byte deterministic operation IDs, ten collections, and 80% collection membership. Ten thousand 31,532-byte JPEG thumbnails represent approximately 301 MiB on disk. Final comparisons append a unique four-byte JPEG trailer per entry, giving distinct data URLs while preserving decoded pixels; this prevents repeated identical string/decoder cache entries from flattering retention results. The image fixture is a deterministic 758,969-byte, 1920×1080 JPEG, transported through the real binary frame commands. The fixture hashes, build identity, and cache state are recorded with each run.

Each final matrix cell uses three sequential fresh processes: one fresh-profile launch and two reopens of that profile. The OS page cache and GPU/desktop session are uncontrolled. **Fresh-profile/process-cold and warm reopen are measured; a genuinely disk-cold boot is NOT_TESTED.** Creating and writing fixtures warms their filesystem pages. There is no startup P95 claim from three launches.

Process launch → enabled Draw controls is the observable time-to-interactive proxy. Restored display requires the blob-backed 1920-pixel image, a successful decode, and the image stage shown; readiness then includes two animation-frame callbacks. These are presentation opportunities, not compositor/GPU presentation timestamps. The initial static placeholder is excluded. Local restoration excludes upstream latency.

Dialog timing includes the real opening path and two frame callbacks. Closing uses the existing exit animation and is outside the `historyOpenOnly`/`savedOpenOnly` measurements. Each interaction has three warmups and 20 retained samples per process, with samples pooled across three runs and nearest-rank P95. Collection and pagination rows are **pairs** of transitions, with frame opportunities between them. Repeated navigation uses real selection persistence, frame transport, decode, and transitions; it retains the intentional loader timing. Nearby requires all nine ready tiles with decoded images. The first progressive pass opens at the upper fixture boundary, so four neighbours lack initial history and disk previews; subsequent profile reopens can use their persisted previews. Zoom uses the real Ctrl+wheel handler; pan uses Shift+arrow handlers. Synthetic DOM events do not validate physical pointer capture or touch hardware.

Resource observations sample the app and descendant WebKit web/network processes from `/proc` every 250 ms. RSS is summed across processes and therefore counts shared resident pages more than once; it is not private heap, PSS, GPU VRAM, or a leak measurement. CPU seconds accumulate each observed PID's lifetime ticks, including children that exit before the app. Sampling may miss short-lived peaks. Object-URL probes retain only URL strings and byte counts, not Blob objects. Long-session work is a bounded soak, not a claim about hours or days of use.

Function-traced builds run separately from the final untraced timing matrix. Their inclusive function spans, IPC wall times, frame intervals and resource counters identify expensive paths; async wall spans include waits and must not be summed as CPU time. Raw reports and Chrome trace-event exports are local artifacts. Builds, tests, and other benchmark variants are not run concurrently with native measurements.

```bash
# Dependencies: the project toolchain, Linux WebKitGTK/GTK, a desktop session, Python + Pillow.
node performance/native-build.mjs /tmp/rf-native-before --ref=42091246d6a5d36b4a9b66d1bc22b04134c2e007
node performance/native-build.mjs /tmp/rf-native-after

# Repeat for 100, 1000, 10000, sequentially, using fresh output directories.
python performance/native-run.py /tmp/rf-native-before --count 1000 --runs 3 --samples 20 --unique-thumbnails --output /tmp/rf-before-1000
python performance/native-run.py /tmp/rf-native-after --count 1000 --runs 3 --samples 20 --unique-thumbnails --output /tmp/rf-after-1000
python performance/native-summary.py /tmp/rf-before-1000 /tmp/rf-after-1000 > /tmp/rf-summary.json

# Separate profiling build; no production instrumentation is enabled.
node performance/native-build.mjs /tmp/rf-native-trace --trace
python performance/native-run.py /tmp/rf-native-trace --count 10000 --runs 1 --samples 8 --unique-thumbnails --output /tmp/rf-trace-10000

# Bounded retention soak, for both before and after, in separate output directories.
python performance/native-run.py /tmp/rf-native-after --count 1000 --runs 1 --samples 3 --long-ms 180000 --unique-thumbnails --output /tmp/rf-soak-after
```

### Confirmed native causes and implementation

1. **Pinned-thumbnail transport dominates large-profile startup.** A preliminary real-app run with the previous optimizations still took 57,279 ms at `load_thumbnail_cache`, reached 6,273 MiB tree RSS, and could not restore before the harness's original readiness deadline. The original-baseline repeats reproduced the same class of stall without function tracing. Loading JPEG bytes as JSON number arrays causes substantial transport/parser work, followed by per-byte JavaScript conversion and base64 allocation. The native command now returns encoded JPEG data URLs, and the frontend consumes them directly. This keeps existing filenames, offline data, exact aliases, load order, pinning, migration, clear generations, partial-write reconciliation and save commands. `base64` 0.22.1 was already present transitively and is now an explicit Rust dependency. Rust and frontend wire-contract regressions were observed failing before implementation and passing afterward.

2. **Repeated Saved projections spend measurable time formatting operation IDs.** A distinct-URL, 10,000-entry trace attributed 15–25 ms to `uncollectedItems` and up to 25 ms to collection filtering. These paths repeatedly mapped every byte through `toString(16)` and `padStart`, allocating temporary arrays. A disposable direct-nibble encoder reduced two-switch median from 86.5 to 70 ms (All saved ↔ an empty collection in that preliminary fixture; populated-collection follow-up below) and traced uncollected projection from 15 to 8 ms. The production version uses `charAt` for strict TypeScript bounds and preserves identical ordered lowercase hex keys. Regression coverage compares all byte values with Node's independent hex encoder and verifies leading zeros, identity separation and rereads after input mutation. There is no generation cache, projection index, or additional invalidation state.

3. **The previous Rust projection improvement reaches real persisted refresh.** Baseline IPC and native refreshed dialogs, rather than the isolated Rust loop alone, are compared below. The sync refresh state machine, cryptography, conflict resolution, transactional writes, and stale-domain rejection were not modified.

### Rejected changes and evidence limits

A disposable variant sent the encoded JSON as a binary Tauri response and parsed it with `TextDecoder`/`JSON.parse`. In the same distinct-URL trace fixture, readiness was 8,356 ms versus 8,666 ms for inline encoded JSON, tree RSS 3,181 versus 3,280 MiB, and whole-workload CPU 18.98 versus 18.82 seconds. A single comparison cannot distinguish the small timing/memory differences from noise, and CPU did not improve. The extra protocol/parsing change is **not in production**. The benchmark-only `--binary-thumbnails` flag preserves this experiment.

The compact response still eagerly loads an unbounded pinned cache. Hundreds of MiB of thumbnails still require substantial memory and startup work; no constant-memory or instant-start claim is made. Lazy file access/chunk streaming would need a separate recovery/pruning design and broader platform proof. No speculative persistent caches or indexes were added.

Preliminary v4 runs are retained as exploratory evidence only. Their `restored` field incorrectly saw the static placeholder, and early Nearby readiness counted image nodes rather than all decoded tiles. The reviewer identified the readiness weaknesses; the final v6 builds require a shown decoded blob image and all nine ready, decoded Nearby tiles. Final comparisons use those corrected builds. Preliminary readiness fields are not used as final restore-display measurements.

### Final matched native matrix

All startup numbers below are milliseconds **from process launch**, including GTK/Tauri setup before the WebView time origin. Warm values are the two actual reopens, shown as a range. There is no statistical startup-tail claim.

| Entries | Fresh controls before → after | Fresh restored image before → after | Fresh readiness (+2 rAF) before → after | Warm readiness before → after |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 467 → 371 | 464 → 369 | 508 → 417 | 509–544 → 405–417 |
| 1,000 | 1,863 → 593 | 1,859 → 590 | 1,887 → 610 | 1,888–1,890 → 572–576 |
| 10,000 | 61,196 → 8,368 | 61,176 → 8,350 | 61,917 → 8,409 | 59,440–59,828 → 8,393–8,519 |

Each interaction cell is **median / P95 ms**, from the v6 matrix (60 retained samples for opening/paging; 30 refreshes; 36 navigations). These are end-to-end in-app paths through real native state and rendering opportunities, with synthetic local content.

| Interaction | Entries | Before | After |
| --- | ---: | ---: | ---: |
| History opening | 100 | 22 / 25 | 21 / 39 |
| History opening | 1,000 | 23 / 26 | 22 / 26 |
| History opening | 10,000 | 39.5 / 46 | 31 / 36 |
| Saved opening | 100 | 22 / 24 | 21 / 23 |
| Saved opening | 1,000 | 24 / 26 | 23 / 67 |
| Saved opening | 10,000 | 40 / 46 | 31 / 34 |
| Saved Next + Previous | 100 | 50 / 51 | 50 / 52 |
| Saved Next + Previous | 1,000 | 50 / 51 | 50 / 51 |
| Saved Next + Previous | 10,000 | 79.5 / 84 | 52 / 147 |
| Native persisted-view refresh, Saved dialog open | 100 | 19 / 41 | 20 / 43 |
| Native persisted-view refresh, Saved dialog open | 1,000 | 34 / 35 | 36 / 48 |
| Native persisted-view refresh, Saved dialog open | 10,000 | 579 / 620 | 61.5 / 150 |
| Navigation, transport, decode, selection, loader and 2 rAF | 100 | 37 / 789 | 37.5 / 787 |
| Navigation, transport, decode, selection, loader and 2 rAF | 1,000 | 51 / 789 | 39 / 787 |
| Navigation, transport, decode, selection, loader and 2 rAF | 10,000 | 137 / 153 | 52.5 / 787 |

**Tail regressions are retained.** Small datasets do not show a consistent opening/refresh improvement. The 1,000-entry Saved opening P95 worsened in this matrix; at 10,000 entries one optimized run had sustained slower pagination and early refresh samples (pagination 103–172 ms rather than the other two runs' mostly 50–67 ms). It contributes to the pooled 147 ms P95. A separate trace follow-up is reported below; no outlier was removed and a faster median is not presented as universal smoothness.

The 10,000-entry navigation P95 also worsens, despite less blocking work. Its real `get_frame_by_id` IPC spans rise from roughly 1–8 ms to 239/258 ms in the slow samples. The existing loader then waits until its 150 ms delay plus 600 ms entrance completes, yielding approximately 787 ms total navigation. This is consistent with the unchanged request-admission bucket being reached sooner by the faster pipeline. During those optimized navigations, maximum rAF gaps are 32–34 ms; baseline maximum gaps are 117–179 ms, with 15 gaps over 50 ms per run. The long wait is not a 787 ms blocked main thread. The admission policy and loader/reduced-motion timing were preserved.

Resource values are medians of each process's run-level observations, not summed across different runs. Startup CPU is approximate, ending at the last 250 ms sample before readiness.

| Entries | Peak tree RSS before → after, MiB | Startup CPU time before → after, seconds |
| ---: | ---: | ---: |
| 100 | 706 → 691 | 0.31 → 0.31 |
| 1,000 | 1,217 → 844 | 2.54 → 0.84 |
| 10,000 | 6,224 → 3,000 | 65.06 → 10.39 |

At 10,000 entries the complete workload uses median 86.87 → 23.16 CPU seconds. One representative warm run splits that into native app 16.24 → 5.31 seconds, WebKit web process 70.59 → 16.41 seconds, and network process 0.04 → 0.04 seconds. This includes all measured interactions; it is not a percentage utilization of every CPU core. RSS reductions at 100 entries are within run variability; no small-profile memory win is claimed.

Scroll and Ctrl+wheel/keyboard-pan phases have P95 rAF intervals of 17–18 ms at 10,000 entries in both variants, maxima 17–21 ms and no intervals over 50 ms. This short scripted workload supplies no reason to change those animations. Optimized refresh gaps improve substantially but one run still reaches 110 ms. These callback intervals are not GPU presented FPS, touch/drag testing, or proof that every interaction is smooth.

Fresh 10,000-entry Nearby warm-grid completion (all nine decoded images) is 5,272 → 495 ms; the progressive boundary pass is 7,444 → 636 ms. Reopens using persisted previews finish the progressive pass in 37–53 ms. The sample count is only three per cell, and first-pass work differs from warmed reopens; they are reported separately rather than as a broad Nearby P95 speedup.

### Populated collections, retention, and tail follow-up

The v6 collection fixture's first normalized collection was empty. Its switch measurements are not used as populated-collection evidence. The v7 driver selects an actual membership's collection and asserts that the chosen grid contains members. Its follow-up uses 40 retained switch/pagination samples per variant:

| Populated two-switch workload | Before median / P95 | After median / P95 |
| --- | ---: | ---: |
| 1,000 entries | 50 / 51 ms | 43 / 54 ms |
| 10,000 entries | 114 / 115 ms | 70 / 71 ms |

The large-library improvement reproduces with visible collection content. At 1,000 entries the median is lower but P95 is slightly worse; no universal tail-latency improvement is claimed. The original Chromium 1,000-entry P95 result is a different component/engine workload and cannot be declared fixed from these native results alone.

A separate repeat of the original Chromium component workload used the baseline and final source in the same Chromium 152/Electron 44 browser session. At 1,000 entries, the collection-switch pair measured 25.4/26.7 → 15.7/19.8 ms median/P95; at 10,000 it measured 94.0/101.7 → 63.3/76.3 ms. The earlier optimized 47.5 ms P95 did not reproduce. This repeat uses mocked IPC, tiny images and forced layout, so it is supplementary component evidence, not native verification. No trace establishes the cause of the historical outlier, and no speculative collection cache was added. Raw observations are in `chromium-component-repeat.json`.

The untraced 10,000-entry pagination repeat measured 82/83 → 70/71 ms, with a 117 ms optimized maximum. A separate function/GC-logged trace measured 50/64 ms, with `renderHistoryPage` taking 18–22 ms and logged JavaScriptCore pauses at most 2.512 ms (maximum logged cycle 3.216 ms). The earlier sustained 103–172 ms episode did not reproduce. This trace supplies no evidence for blaming long GC pauses, adding an index, or changing rendering architecture. The original tail regression remains part of the evidence; its cause is unconfirmed and the desktop/CPU environment was not isolated.

Both native three-minute navigation soaks completed **548 navigations**, cycling through 180 frames under the existing admission policy. Every checkpoint obeyed the 20-frame/32 MiB cache and at-most-22-live-URL assertions. At steady state each actually held 20 cached blobs, 20 URLs and 15,179,380 encoded bytes. After 15 seconds idle those counts remained bounded; explicit release left zero blobs and zero URLs in both variants.

| Soak observation | Before | After |
| --- | ---: | ---: |
| Complete soak workload CPU time | 59.89 s | 54.04 s |
| Peak tree RSS, including startup | 1,238 MiB | 840 MiB |
| RSS at navigation checkpoints 100–500 | 764–786 MiB | 760–780 MiB |
| RSS after idle | 741 MiB | 746 MiB |
| Nearest live RSS sample after URL release | 706 MiB | 698 MiB |
| Navigation-phase rAF P95 / maximum | 18 / 94 ms | 18 / 27 ms |
| Navigation-phase intervals >50 ms | 5 | 0 |

There is **no demonstrated steady-session RSS improvement or accumulating URL leak** in this fixture. Revocation does not force immediate WebKit allocator/decoder/GPU release, and active image elements may retain decoded content. The RSS summarizer ignores absent/zero-resident exit samples when matching release checkpoints, while still counting final observed CPU ticks. A regression test covers both uncompressed and compressed artifacts; it failed before the accounting correction and passed afterward. The original raw samples are retained. No full-image cache or URL-lifetime production change was justified.

### Native Android slice and rejected runs

The SDK and emulator were installed outside PATH. A new isolated `rf-performance` AVD ran the actual x86_64 debug Tauri APK under Android 15, 16,384-byte pages and Android WebView 124.0.6367.219, with 6144 MiB RAM and SwiftShader. Only `emulator-5580` was addressed; no physical device was authorized or used. The same deterministic local JPEGs, native History/Saved files, populated collections, IPC probe and v7 workload were used. APK hashes and source provenance are retained. This is native Android WebView evidence, separate from both the Chromium component repeat and the Linux release matrix.

Two baseline processes completed at each of 100 and 1,000 entries. The optimized APK completed one matched fresh-profile process at each size and an earlier standalone 100-entry pilot. Each completed process exercised History/Saved opening, populated collection switching, pagination, real persisted refresh, navigation/full-image decoding, scroll, zoom/pan, all-nine-tile Nearby readiness and explicit blob release. Reported fixture counts match their profiles, and every completed report ends with zero cached blobs and zero live object URLs. Eight samples per interaction follow three warmups. End-of-run `dumpsys meminfo` is retained; Android CPU and peak process-tree RSS were not measured.

| WebView-origin readiness, seconds | Baseline fresh / reopen | Optimized fresh / reopen |
| --- | ---: | ---: |
| 100 entries | 2.573 / 2.445 | 2.105 / CRASHED |
| 1,000 entries | 8.486 / 6.885 | 3.857 / NOT_TESTED |

The separate optimized 100-entry pilot measured 2.050 seconds. These are descriptive observations from a small, unreliable emulator slice; **no verified Android performance improvement is claimed**. Android readiness starts at WebView time origin, not process launch. The constant benchmark config launch=0 makes the raw Linux-only `launchToTimeOrigin` field unusable on Android. Activity `am start -W` timings are retained separately and are not time to interactive. No Android 10,000-entry, release APK, physical-device or long-session comparison was accepted.

The available image crashed `system_server` twice during initial probing, including before an app workload. After recovery, the optimized 100-entry reopen crashed after 35 seconds in WebView's native `MemoryInfra` thread, with SIGTRAP and `libmonochrome_64.so` frames; it produced no completed report and is retained as a rejected run. The repository's existing `.github/actions/android-smoke/action.yml` already documents this Android 15 experimental-image failure and uses an Android 16 image instead. That image is not installed locally. The observed stack and system crashes support an environment limitation; they do not establish a regression caused by the production patch. No application change was made to suppress the crash or alter runtime behavior.

Earlier harness attempts also seeded the wrong Android directory (`files/` rather than Tauri's app data root), encountered an overwritten prepared frontend, and reused generated Kotlin outputs across disposable project paths. They supply no accepted performance results. Corrected construction and reproduction commands are in [performance/ANDROID.md](performance/ANDROID.md); selected reports, filtered crash stacks, exit records and summaries are in [the Android artifact directory](performance/results/native/android). Windows WebView2 remains NOT_TESTED.

### Current correctness, review and platform status

The complete production gates passed after the source changes:

```text
npm run typecheck
npm run lint
npm test                                    202 passed; 0 failed
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml    240 passed; 22 ignored
PYTHONDONTWRITEBYTECODE=1 python performance/test_native_summary.py
```

The new native thumbnail wire-contract assertion and frontend startup regression were observed failing on the old representation and passing after the compact response. Existing migration, partial-write failure/retry, deletion-only pruning, alias pinning, queued-clear, stale refresh, collection conflict/Undo, encryption/convergence, focus, keyboard, reduced-motion, cancellation and admission tests passed. Tests intentionally log errors for simulated failures; no final failing test was excluded. The ignored tests include external/private-server and manually invoked workloads; they are not native platform evidence. Final verification repeated all six production gates successfully after the Android work. The first sandboxed repeat blocked workflow tests from spawning Bash (`EPERM`); rerunning the complete sequence with shell/local-server permission passed unchanged. Command outcomes and counts are retained in `performance/results/native/verification.json`.

Independent review used the configured default Codex model. An automatic source-disclosure review initially blocked delegation; the user explicitly approved the scoped reviewer access, after which review proceeded. Round one found the two harness-readiness defects described above; both were corrected and the affected native matrix rerun. Round two independently checked the complete production delta, matched its patch hash to the measured build, and confirmed ordering/source identity, unchanged hex keys and bytes, deletion/partial-write/retry/clear behavior, and absence of new invalidation state. It found no actionable production issue and required honest empty-collection labeling and retention of the navigation/pagination tails.

The final independent review reproduced the Linux matrix/follow-up and Android summaries from compressed raw reports, confirmed the exact production patch/hash, and found no actionable production defect. It accepted the report's limited conclusions and the disclosure of empty collections, latency tails, Android failures and clock/platform limits. It found one P2 harness weakness: `goTo()` catches failures internally, so resolving its promise did not itself prove navigation succeeded. The retained frame-transfer/selection counts and cache growth showed no indication that this weakness corrupted the results, but those older runs must not be described as having the new per-navigation assertions.

The current v8 harness now waits for displayed-image decoding and checks the target index, settled loading state, image stage, visible stage, fixture dimensions and exact target-cache blob URL after every navigation, including the Nearby setup. The soak counter increments only after those checks succeed. Four regressions failed without the guard and passed with it, covering stale valid images, failed persistence, decode errors and hidden/incomplete/wrong target fixtures. TypeScript, Biome and the complete frontend suite passed again (202 tests); production source and its already-passed Rust gates are unchanged. The old v7 driver is archived alongside v6 for provenance. A new actual Tauri/WebKitGTK release smoke at 100 entries completed the full workload with these guards, including 16 successful navigations in a short three-second soak and release to zero URLs/blobs. Its `v8-guard-smoke-100` artifacts validate the harness fix; they are not pooled into the timing matrix or used for new performance claims. Android was not rerun with v8.

| Platform/path | Current status | Limit |
| --- | --- | --- |
| Linux Tauri / WebKitGTK | VERIFIED for these release-process fixtures | Actual app, IPC, file persistence, decode and callback stability; no installer or GPU presentation timestamp |
| Native Windows WebView2 | NOT_TESTED | No native Windows/WebView2 runtime was exercised; Linux Chromium or Wine is not a substitute |
| Native Android WebView | PARTIALLY_VERIFIED | Actual debug APK/WebView completed 100/1,000-entry workloads; unstable experimental image, one rejected reopen crash, no reliable speedup claim, no 10,000-entry/release/physical-device/soak comparison |
| Disk-cold OS boot | NOT_TESTED | Filesystem cache was uncontrolled; fresh-profile/process and warm reopens are measured |
| Encrypted private-server Sync upload/download → paint | NOT_TESTED | Native persisted refresh and disconnected startup were timed; server/crypto correctness fixtures passed separately |
| Physical drag/touch, native assistive technology, reduced-motion timing on real hardware | NOT_TESTED in this performance extension | Existing semantics and tests preserved; scripted wheel/keyboard pan is narrower evidence |
| Hours/days, 4K/mixed codecs, corrupt real-world libraries, constrained mobile memory | NOT_TESTED | The bounded JPEG soak demonstrates repeated eviction/revocation, not every long-session scenario |

The strongest verified gains are large-cache startup, peak startup RSS/CPU, real persisted refresh and large populated-collection switching. The uncapped eager pinned cache still makes the 10,000-entry launch take over eight seconds and use substantial memory. Intermittent UI tails remain; the faster median does not establish universal smoothness. There is no evidence-backed reason here to change encryption, durability, native admission, loader/animation timing, projection ownership, or the bounded full-image lifecycle.

### Retained evidence

See [native artifacts and index](performance/results/native/README.md), [matrix summary](performance/results/native/matrix-summary.json), [follow-up summary](performance/results/native/followup-summary.json), and [the measured production patch](performance/results/native/production.patch). Raw JSON is gzip-compressed without changing its contents; `native-summary.py` reads compressed or original reports. Only synthetic reports/logs are retained, never profile directories or generated identities. The matrix uses v6; populated switching, soaks and Android use v7. Archived v6/v7 drivers preserve the workloads used for those results; v8 adds the review-requested navigation-success assertions.

Environment additions: Python 3.14.8, Pillow 13.0.0, kernel 7.3.0-4-cachyos, with the previously documented Linux machine/toolchain and existing desktop session. The resumed Android build/final host gate run used Node 26.12.1; the earlier Linux matrix used the version documented above. No commit or publication was performed.
