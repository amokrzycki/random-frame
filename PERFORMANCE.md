# Performance audit — 2026-10-29, extended 2026-10-30

The October 29 phase below records four component optimizations and their original verification boundaries. The **October 30 native validation extension** adds real Linux Tauri/WebKitGTK release-process measurements, further evidence-backed changes, and current limitations. Its internal thumbnail-load IPC format supersedes the prior phase's unchanged-IPC statement; disk files, save commands, sync formats, image retrieval, admission limits, and motion remain unchanged. The **demand-loaded thumbnail phase** replaces that eager startup load with per-file access; its measurements supersede the startup and pinned-thumbnail rows above. Committed baseline for the final phase: `d6e3c100b428a3be25df49a32cda62c18c92b1e5`.

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
4. ~~Measure pinned-thumbnail startup bytes and process retention with realistic JPEGs. Startup currently reads every saved thumbnail and expands bytes into base64; pinned Saved thumbnails have no ordinary-cache cap. Consider lazy native thumbnail access only after measuring it, preserving persistence, aliases, clear recovery and offline behavior.~~ **Addressed in the final phase below**: startup now lists keys only and reads one file per visible tile. Pinned entries still have no in-memory cap; see that phase's remaining limitations.
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

## Demand-loaded thumbnails — 2026-10-30 (final phase)

### Root cause

The previous phase had already replaced the number-array wire format with encoded data URLs, but startup still called `load_thumbnail_cache`, which read **every** thumbnail file and returned all of them as base64 strings. At 10,000 pinned Saved thumbnails (31,532-byte JPEGs, about 301 MiB on disk) the frontend received roughly 420 MiB of data-URL strings and retained them in two Maps. The existing `trace-compact-10000` artifact shows the cost directly: `load_thumbnail_cache` took **8,024 ms of the 8,329 ms** WebView-origin readiness time. A matched v8 rerun of the previously optimized build reproduced **8,588 ms** median readiness (8,332–9,492 ms), **10.63 s** startup CPU, and **2,587 MiB** startup peak tree RSS.

Only one of those thumbnails is needed to show a restored frame, and none is needed until History, Saved, Nearby, or Stats is opened. The eager load was therefore unnecessary work and retained memory for the entire session.

### Alternatives considered and rejected

| Alternative | Why it was not chosen |
| --- | --- |
| Keep eager loading; improve transport again | Already tried in the prior phase (`trace-binary-10000`: 8,356 ms vs 8,666 ms, no CPU win). The remaining cost is reading, decoding, encoding and retaining the whole library, not just JSON framing. |
| Load only pinned Saved thumbnails at startup | The pinned Saved set is exactly the unbounded set causing the problem. |
| Warm a bounded prefix (for example the newest 200) | Still leaves an unbounded remainder, adds a second cache tier, and does not remove the 10,000-file stall. |
| Start the eager load after readiness, in the background | Would still perform the same I/O, allocate the same strings, compete with the first interactions, and make readiness a misleading metric. |
| Replace the file cache with a database/index | Not required: the directory listing plus existing filenames already answer "which keys exist" in 16 ms at 10,000 entries. Changing persistence would add migration risk for no measured benefit. |
| Keep the eager cache solely to keep Stats/Nearby warm | Measured startup cost dominates; demand hydration brings warm Nearby back to parity (below). |

### Implemented architecture

**Rust (`src-tauri/src/thumbnail_cache.rs`)**

- `list_thumbnail_cache()` returns `(key, file size)` pairs, oldest first by modification time. It filters empty/oversized/invalid files and reads **no image bytes**. The size and order let the frontend keep the existing ordinary-cache bounds without decoding anything.
- `read_thumbnail_cache(key)` validates the key, reads exactly one file, and returns its JPEG data URL. It does not scan the directory; the frontend resolves leading-zero aliases against the listed keys, so a missing canonical file never triggers an O(directory) scan on the request path.
- `save_thumbnail_cache(entries, keep)` is unchanged. `keep` now includes unloaded keys, so a file is never pruned merely because this session did not read it.
- Filenames, leading-zero alias spellings, the 128 KiB per-file limit, atomic `.tmp` writes, `.tmp`/orphan pruning and unchanged-file mtime preservation are unchanged.

**Frontend (`src/client/frame-cache.ts`)**

- `diskKeys` is a `Map<key, bytes>` of files known to exist; `deletedKeys` tracks pending prunes; `discardedKeys` remembers images that failed to decode this session.
- `initializeThumbnailCache()` lists keys only. The first reconciliation still runs at startup, so crash artifacts and `.tmp` files are pruned as before.
- `ensureThumbnail()` resolves in order: memory → stored file → source. A stored file is used as-is, so offline History/Saved tiles never reach the network.
- `hydrateThumbnail()` is disk-only and is used by Stats and Nearby. It does not share `ensureThumbnail`'s pending map, so a disk miss cannot swallow the source fallback.
- `cacheThumbnailIfMissing()` lets the stage skip both reading and regenerating when a file already exists; showing a frame never rewrites a thumbnail.
- `trimThumbnails()` keeps the existing ordinary-cache budget (300 entries / 8 MiB) across **unloaded disk files first, then loaded entries**, so the oldest file is evicted, not the one just read. Pinned Saved thumbnails remain exempt (existing semantics). `trimLoadedThumbnails()` enforces only the in-memory bound during hydration.
- `clearThumbnails()` prunes unloaded non-retained files too; the existing clear generation rejects stale in-flight reads; `retainedAfterClear` is cleared after a successful save. Partial-write retries still resend the complete loaded cache and keep unloaded files.
- `collections-dialog.ts` re-ensures only the frames in the Undo batch, not every Saved item.

**Consumers**

- History/Saved keep the existing `IntersectionObserver` + three-at-a-time loader; only the visible page's tiles are requested. Pagination still cancels queued work for the page being left.
- Nearby hydrates a saved tile from disk when native evidence says its preview exists, otherwise it resolves through the existing backend/handle path.
- Stats hydrates the visible ledger page (at most 14 days × 6 thumbnails) before rendering; "Show earlier days" is serialized so rapid activation cannot duplicate or skip days.

No dependencies were added. The command names and wire shapes are internal; disk formats, save semantics, sync behavior, aliases, animations and admission limits are unchanged.

### Measured results

Method is the same as the native extension above: Linux Tauri/WebKitGTK release executables, isolated synthetic profiles, 100/1,000/10,000 native History and Saved entries, ten collections, 80% membership, 31,532-byte distinct JPEG thumbnails, three sequential fresh processes per cell (one fresh-profile launch plus two reopens), 20 retained interaction samples per process, v8 navigation-success assertions. "Before" is the previously optimized commit `d6e3c10`; "after" is the same commit plus `v9-demand.patch` (SHA-256 `5af416c82ee3929b6461be933fc26efc5b255d6beb859fff8be757e21efa04f5`). The before binary predates the new cold-open one-shot samples; its warm `historyOpenOnly`/`savedOpenOnly` rows are the comparison for first-use latency.

Startup is process launch → restored image shown + two animation-frame callbacks. Peak RSS is sampled at 250 ms intervals; the startup column stops at readiness. Medians are across the three processes; ranges are shown because three launches do not support a P95 claim.

| Entries | Readiness before | Readiness after | Startup peak RSS before | Startup peak RSS after | Startup CPU before | Startup CPU after |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 393 ms (385–408) | 367 ms (354–371) | 453 MiB | 452 MiB | 0.30 s | 0.30 s |
| 1,000 | 558 ms (551–570) | 381 ms (369–390) | 828 MiB | 453 MiB | 0.84 s | 0.31 s |
| 10,000 | 8,588 ms (8,332–9,492) | 520 ms (512–619) | 2,587 MiB | 452 MiB | 10.63 s | 0.31 s |

At 10,000 entries the whole measured workload (all interactions) used **22.57 → 12.02 CPU seconds**; whole-workload peak tree RSS was **2,587 → 935 MiB**. The startup trace build shows `list_thumbnail_cache` at **16 ms**, `save_thumbnail_cache` at **5 ms**, and **zero** `read_thumbnail_cache` calls before readiness. The same trace records 23 on-demand reads during the first History open.

Interactions are **median / P95 ms**, pooled across the three processes (60 retained samples for opening/paging, 30 refreshes, 36 navigations). Nearby uses only three samples per cell, so its P95 is the maximum.

| Interaction | Entries | Before | After |
| --- | ---: | ---: | ---: |
| History opening (warm) | 100 | 20 / 22 | 19 / 20 |
| History opening (warm) | 1,000 | 20 / 21 | 19 / 20 |
| History opening (warm) | 10,000 | 31 / 38 | 26 / 27 |
| Saved opening (warm) | 100 | 20 / 23 | 19 / 20 |
| Saved opening (warm) | 1,000 | 20 / 22 | 19 / 20 |
| Saved opening (warm) | 10,000 | 31 / 37 | 27 / 29 |
| Saved Next + Previous | 100 | 50 / 51 | 70 / 72 |
| Saved Next + Previous | 1,000 | 70 / 71 | 70 / 71 |
| Saved Next + Previous | 10,000 | 54 / 68 | 67 / 70 |
| Populated two-collection switch | 100 | 50 / 51 | 53 / 54 |
| Populated two-collection switch | 1,000 | 50 / 51 | 53 / 70 |
| Populated two-collection switch | 10,000 | 65 / 70 | 70 / 82 |
| Native persisted-view refresh | 1,000 | 36 / 38 | 37 / 38 |
| Native persisted-view refresh | 10,000 | 58 / 65 | 59 / 83 |
| Nearby warm grid (3 samples) | 100 | 53 / 93 | 47 / 143 |
| Nearby warm grid (3 samples) | 1,000 | 46 / 128 | 42 / 175 |
| Nearby warm grid (3 samples) | 10,000 | 54 / 504 | 60 / 504 |
| Nearby progressive boundary (3 samples) | 1,000 | 42 / 266 | 55 / 251 |
| Nearby progressive boundary (3 samples) | 10,000 | 49 / 661 | 44 / 616 |
| Navigation, transport, decode, 2 rAF | 100 | 37 / 787 | 37 / 787 |
| Navigation, transport, decode, 2 rAF | 1,000 | 37 / 787 | 37 / 787 |
| Navigation, transport, decode, 2 rAF | 10,000 | 51 / 789 | 37 / 797 |

First actual thumbnail-consuming views were measured before the sampled loops, because their warmups would hide the one-time cost:

| First cold view | 100 | 1,000 | 10,000 |
| --- | ---: | ---: | ---: |
| History rendered / visible tiles ready | 49 / 85 ms | 51 / 85 ms | 59 / 101 ms |
| Saved rendered / visible tiles ready | 34 / 67 ms | 34 / 66 ms | 51 / 83 ms |

The first History open's visible-tile completion is 66–75 ms slower than the same session's warm open (85 vs 19 ms at 100/1,000 entries; 101 vs 26 ms at 10,000) because it performs 23 disk reads at 7–23 ms each with three in flight. That is the deliberate first-use cost of not reading 10,000 files at launch; it is bounded by the visible page and remains far below the 8.6 s the previous build spent before readiness.

### Correctness and regression testing

The change keeps the existing test suites and adds focused coverage:

- `test/thumbnail-demand.test.mjs` (14 tests): 10,000-key initialization with zero reads; concurrent request deduplication; disk hit never reaches the source; missing/unreadable file fallback; clear pruning unloaded files; pinned survival; stale in-flight read rejection; eviction and rehydration; stage reuse without rewriting; discard-then-re-add; hydrate-versus-ensure; clear during an in-flight save; self-eviction; legacy-value precedence; alias preservation; hydrate-only memory bound; pinned discard not resurrected.
- `test/stats-ledger.test.mjs`: rapid "Show earlier days" activation renders distinct pages without duplicates or skipped days.
- Test doubles now enforce the native `entry ∈ keep` rule, so a frontend save that omits a written entry fails the test.
- Existing migration, partial-write failure/retry, deletion-only pruning, alias pinning, queued clear, stale refresh, collection conflict/Undo, focus, keyboard, reduced-motion, cancellation and admission tests still pass.

Final gates:

```text
npm run typecheck
npm run lint
npm test                                    217 passed; 0 failed
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml    241 passed; 22 ignored
```

The native harness now asserts that startup issues at most two `read_thumbnail_cache` calls (the measured runs issue zero), that `list_thumbnail_cache` ran, and that every navigation lands on the decoded target. A visible-tile completion predicate measures the first cold History/Saved open.

### Independent review

Two review rounds used a separate default-model reviewer, read-only. Round one found no P0 but a P1 and several P2 issues in the first implementation:

- P1: a thumbnail discarded after a decode failure and then re-added stayed in `deletedKeys`, so `keep` omitted it while `entries` included it. The native save rejected the request forever. Fixed by keeping re-added keys, clearing the pending prune when fresh bytes are stored, and adding the `entry ∈ keep` assertion to test doubles.
- P2: hydration could evict the thumbnail it had just read (fixed by oldest-disk-first, loaded-last trim order); a clear during an in-flight save could be resurrected (fixed by snapshotting the prunes covered by each save and filtering the post-save key set); `hydrateThumbnail` shared `ensureThumbnail`'s pending map and could swallow the source fallback (fixed by a direct disk read); Stats lost ledger thumbnails on a fresh launch (fixed by page hydration); discarding a pinned tile could delete the offline copy (fixed by pruning only non-pinned keys).
- P3s fixed: legacy `localStorage` could override a newer disk file; `cacheThumbnailIfMissing` did not capture the clear generation; `retainedAfterClear` was not cleared after a successful save; the legacy migration save did not use the same in-flight-prune bookkeeping.

Round two verified the original repros still fail on the old logic and pass now, then found two remaining P2s: hydrate-only paths could grow the in-memory cache past its bound (fixed with `trimLoadedThumbnails`, verified 1,000 hydrates ≤ 300), and rapid "Show earlier days" could duplicate rows (fixed by serializing page renders, covered by `stats-ledger.test.mjs`). It also found a P3 where a pinned discarded tile could be re-read (fixed with `discardedKeys`) and a P3 legacy-migration bookkeeping race (fixed). A final round found one P3: a Stats page queued before a persisted-view refresh could advance the refreshed ledger; the render queue now captures the generation at enqueue and drops stale pages. The round-three repro now renders 14 rows after a refresh while a normal double activation still renders 30 distinct days. No unresolved actionable production defect remains from these reviews.

### Remaining limitations

- ~~Pinned Saved thumbnails are still exempt from the in-memory count and byte bounds.~~ **Superseded by the bounded-memory phase below**: every clean thumbnail, pinned or not, now counts toward a 300-entry / 16 MiB memory bound.
- `trimThumbnails`/`trimLoadedThumbnails` are O(favorites + known disk keys) when the bound is exceeded. With 10,000 pinned entries this is noticeable per save or per hydrated tile, though it is not on the startup path.
- Stats ledger hydration can issue up to 84 disk reads per page. Paging through a very large ledger therefore performs many sequential local reads; it does not start source requests.
- Pagination at 100 entries regressed from 50 to 70 ms median per Next + Previous pair. At 1,000 entries it is unchanged (70 ms); at 10,000 it also regressed (54 to 67 ms). These timers include frame callbacks and do not isolate disk reads from layout or scheduling. The existing cancellation behavior was preserved.
- Nearby's first-ever grid in a fresh profile still takes about 0.5 s because four boundary neighbours have no history or disk preview and are fetched from the fixture source. Warm reopens are about 60 ms at 10,000 entries.
- Startup peak RSS, whole-workload peak RSS and CPU are process-tree sums with shared pages counted per process, not PSS/private heap or GPU VRAM. The desktop session and OS page cache were not isolated; disk-cold boot is still NOT_TESTED.
- Android and Windows were not rerun for this phase. The change is platform-neutral Rust/frontend code, but only Linux WebKitGTK is verified here.
- Duplicate canonical and leading-zero alias files can both remain on disk; `discardThumbnail` removes only the exact spelling it matched. `discardedKeys` is session-scoped, so after a restart a pinned file that failed to decode can be read again until a replacement is written.
- `trimLoadedThumbnails` can evict an older memory-only thumbnail that has not yet been persisted when the in-memory bound is exceeded (newest entries survive; the debounced save normally runs first). A lost entry is regenerated or re-fetched on demand.
- No compositor/GPU presentation timestamp, physical touch/drag, assistive-technology or long-session soak was added for this phase.

### Retained evidence

Final artifacts are under [performance/results/native](performance/results/native):

- `v9-demand-baseline-{100,1000,10000}`: previously optimized commit `d6e3c10` rerun with the v8 driver.
- `v9-demand-final-{100,1000,10000}`: measured demand-loaded build.
- `v9-demand-trace-10000`: function/IPC trace of the final build.
- `v9-demand-summary-*.json`: recomputed summaries.
- `v9-demand.patch`: exact production delta and SHA-256 used by the final builds.

Raw JSON is gzip-compressed without changing its contents. The native runner's fixture hashes and build provenance are in each `metadata.json`; no profile directories, identities or user data are retained.

## Bounded thumbnail memory — 2026-11-01 (final phase)

### Problem

After v9, startup no longer reads the library, but every Saved thumbnail a view had ever loaded stayed in `thumbnails` for the whole session (pinned entries were exempt from every bound). The readiness assessment measured 600 → 1,744 MiB process-tree PSS at 10,000 Saved entries and classified it P2. A second strong reference compounded it: `savedThumbnails` held the same data-URL strings, so evicting from `thumbnails` alone would have freed nothing.

### Representations traced

| Representation | Owner / lifetime | Before | After |
| --- | --- | --- | --- |
| JPEG file on disk (`diskKeys`) | Native cache; durable | Kept for pinned entries; ordinary entries pruned by the 300-file / 8 MiB disk budget | Unchanged |
| Data-URL string in `thumbnails` | Frame cache | Pinned: never evicted. Ordinary: evicted by the disk budget | Any *clean* entry (bytes known to be on disk) is evictable, oldest use first; bound 300 entries / 16 MiB |
| Same string in `savedThumbnails` ("clean" record) | Frame cache | Retained until the next successful save, independent of `thumbnails` | Always a subset of `thumbnails`; removed with it (`dropLoaded`) |
| Unsaved (dirty) entries | Frame cache | In `thumbnails` until saved | Never evicted (only copy); excluded from the bound so they cannot squeeze out freshly read entries |
| Pending native read | `pendingReads` | One read per `ensureThumbnail` key; `hydrateThumbnail` could duplicate it | One read per stored key, shared by Stats, Nearby and History |
| `<img src=dataURL>` of visible tiles | DOM / WebKit | Own copy of the string and decoded image; independent of the Map | Unchanged. An evicted entry does not invalidate a displayed tile |
| Full-frame Blob URLs | `blobs` / `borrowBlobUrl` | 20 frames / 32 MiB, borrow-counted | Unchanged |

JavaScript object counts are not used as evidence of reclamation: the evidence below is process-tree PSS from `/proc/<pid>/smaps_rollup` of the real WebKitGTK app.

### What the measurements show about WebKit memory

v9 retained 401 MiB of data-URL characters at 10,000 entries, about 42 KiB per entry, yet its PSS grew 0.6–1.3 GiB (60–130 KiB per entry), with a large run-to-run spread on the identical binary (closed-idle PSS 1,802 vs 1,117 MiB in two v9 runs). The JS string is therefore at most about a third of the cost. The rest was not separately isolated (decoded images, WebKit's per-URL resource entries and allocator fragmentation are candidates). What is established is the consequence: once the strings are released, PSS stops tracking the visited count (table below), so WebKit does **not** keep an independent per-entry copy beyond the live JS references. Eviction does not give an instant drop: after a traversal PSS decays over seconds and stays in a band of roughly 500–700 MiB, with transient peaks above it during fast paging.

### Design

Smallest change that satisfied the requirements, in `src/client/frame-cache.ts` (no Rust change, no new dependency, no new index):

- **One memory bound over all clean entries**, `MEMORY_LIMIT = 300` and `MEMORY_BYTE_LIMIT = 16 MiB` (encoded bytes). 300 covers two 100-tile pages plus an 84-thumbnail Stats page; the byte cap still admits 128 entries at the 128 KiB per-file maximum. The old ordinary 300 / 8 MiB budget is now only the *on-disk* budget for non-Saved previews.
- **Clean means** `savedThumbnails.get(key) === thumbnails.get(key)` and `diskKeys.has(key)`. Eviction (`trimLoadedThumbnails`) never touches `diskKeys` or `deletedKeys`, so the file stays and `keepKeys()` still lists it: memory eviction cannot prune a file. It needs no pinned set, so it does not add the O(favorites) cost of the old trim.
- **LRU by Map order**: `thumbnailFor` re-inserts on a hit, so tiles being rendered are evicted last. A caller's just-read entry is never its own victim.
- **Dirty entries are never evicted**, and a save marks them clean and then trims, so memory returns to the bound after the write.
- **Failed save** now un-saves only that call's entries instead of clearing every record. Native `save` writes only the call's entries and prunes by `keep`, so those are the only files a failure can half-write; keeping the rest clean keeps them evictable on a failing disk.
- **Deduplicated reads**: `readStoredThumbnail` shares one native read per stored key. After the await, `loadStoredThumbnail` rechecks `diskKeys`, `deletedKeys`, `discardedKeys` and the clear generation, and a newer in-memory value is never overwritten. A read finishing after a prune, discard, Clear or Saved removal therefore cannot resurrect an entry or cancel its pending prune.
- Legacy migration and every `dropLoaded` site (clear, discard, ordinary prune) shrink `thumbnails` and `savedThumbnails` together.
- `stats-dialog.ts`: a ledger strip now draws only the frames that were hydrated (the first six of the day) instead of any later frame that happened to still be in memory, so strips no longer depend on residency.

**Deliberate semantic change.** "Pinned" now means *durable on disk*, not *resident in memory*. Saved thumbnails are evicted from memory like any other clean entry and read back on demand. Consumers already read `thumbnailFor` immediately after the awaited hydrate and copy the string into `img.src`; none relies on residency.

Alternatives rejected: FIFO (no recency, so the page being viewed could be evicted first; the touch costs one delete/set); a separate pinned-LRU tier (second index, same memory policy); evicting by file mtime or a database (persistence change, no measured need); revoking/using blob URLs for tiles (new lifecycle for a problem the plateau shows is solved).

### Method

Linux Tauri/WebKitGTK 2.54.2 release executables built by `performance/native-build.mjs` into disposable `/tmp` copies; isolated synthetic profiles (`performance/native-run.py --mode retention`) with 1,000 / 5,000 / 10,000 Saved entries, distinct 31,536-byte JPEG thumbnails, ten collections, page size 100. The baseline is the committed v9 tree (`--ref=HEAD`); "bounded" is the working tree. Each cell is one fresh process, run **twice** per build (the second run is the "repeat" in the raw artifacts). Workload (`performance/native-retention.mjs`):

1. Complete traversal of every Saved page, scrolling each row so every tile loads and decodes; checkpoint every 1,000 entries.
2. Close Saved, 15 s idle.
3. Second complete traversal, close, 15 s idle.
4. 20 Next + Previous pairs at the middle page; six cold revisits of distant pages via Next/Previous; final 15 s idle.

The process-tree sampler records PSS and RSS every 250 ms from `smaps_rollup`; checkpoints are matched to the nearest live sample. After every run the cache directory is fingerprinted (file count and SHA-256 of names and bytes) and compared with the pre-run fingerprint; the driver fails if a source request occurs or the native file list changes. The first harness round used `openHistory()` to jump to page 0 and silently stayed on the remembered last page, so its second traversal and revisits were no-ops for both builds. It was discarded and the driver now jumps with the real Previous/Next controls and checks the landing page. Results below are from the corrected driver.

```bash
node performance/native-build.mjs /tmp/rf-ret-v9 --ref=HEAD     # baseline
node performance/native-build.mjs /tmp/rf-ret-b2                 # working tree
python performance/native-run.py /tmp/rf-ret-b2 --count 10000 --runs 1 --mode retention --unique-thumbnails --output /tmp/rf-ret-b2-10000
python performance/native-retention-summary.py /tmp/rf-ret-b2-10000
```

### Results (two runs per cell, written run 1 / run 2)

Process-tree PSS in MiB. "Start" is after startup readiness. "Closed" is Saved closed after the first complete traversal; "idle 2" is after the second traversal and 15 s idle.

| Saved | Build | Start | Closed | Idle 2 | Peak PSS | Peak RSS | Live thumbnails (end) | Data-URL chars (end) |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | v9 | 405 / 382 | 554 / 503 | 623 / 513 | 761 / 703 | 990 / 934 | 999 | 40.1 MiB |
| 1,000 | bounded | 403 / 409 | 532 / 518 | 550 / 522 | 667 / 651 | 896 / 882 | 300 | 12.0 MiB |
| 5,000 | v9 | 440 / 429 | 985 / 846 | 1,174 / 1,057 | 1,903 / 1,763 | 2,132 / 1,995 | 4,999 | 200.6 MiB |
| 5,000 | bounded | 438 / 439 | 588 / 572 | 563 / 609 | 1,151 / 937 | 1,379 / 1,172 | 300 | 12.0 MiB |
| 10,000 | v9 | 494 / 474 | 1,802 / 1,117 | 1,929 / 1,825 | 3,139 / 3,441 | 3,369 / 3,673 | 9,999 | 401.2 MiB |
| 10,000 | bounded | 465 / 480 | 653 / 617 | 707 / 610 | 1,117 / 1,112 | 1,348 / 1,347 | 300 | 12.0 MiB |

After the final revisits and idle, v9 held 691 / 618, 1,253 / 933 and 2,641 / 3,010 MiB; bounded held 523 / 501, 800 / 548 and 482 / 575 MiB. Bounded idle PSS sits in a 480–800 MiB band at every library size, while v9 grows with the visited set and, notably, grows further when the second traversal re-renders from its retained strings (10,000 entries: peak 3.1–3.4 GiB, RSS 3.4–3.7 GiB). **Plateau criterion met**: 1,000 → 10,000 entries raises bounded closed-idle PSS by about 100 MiB (532 → 653), within the run-to-run spread, while peak PSS is 1,117 vs 1,150 MiB at 10,000 vs 5,000. Peaks exceed the idle band by roughly 450 MiB during fast paging (decode and allocation churn); that transient does not scale with the library. Closing Saved lowered PSS by only 20–60 MiB in both builds (bounded 10,000: 709 → 653 and 668 → 617 MiB between the end of the first traversal and the closed checkpoint; v9 1,822 → 1,802 and 1,142 → 1,117), and neither returns to the start value because the allocator keeps pages.

Latency, **median / P95 ms** (run 1; run 2 is within a few ms unless noted). Each page transition includes rendering, tile loading and decoding of every visible tile, with frame callbacks; reads are mean native `read_thumbnail_cache` calls per transition.

| Transition | Saved | v9 | Bounded |
| --- | ---: | ---: | ---: |
| Next, first traversal (18 reads, all misses in both builds) | 1,000 | 60 / 61 | 65 / 67 |
| | 5,000 | 94 / 110 | 71 / 77 |
| | 10,000 | 133 / 153 | 75 / 78 |
| Next, second traversal | 1,000 | 113 / 116 (0 reads) | 60 / 69 (18 reads) |
| | 5,000 | 113 / 129 (0 reads) | 77 / 86 (18 reads) |
| | 10,000 | 120 / 137 (0 reads) | 84 / 93 (18 reads) |
| Next / Previous at the middle page | 1,000 | 65 / 83 · 65 / 84 | 41 / 56 · 42 / 48 |
| | 5,000 | 83 / 94 · 83 / 112 | 48 / 67 · 48 / 59 |
| | 10,000 | 81 / 94 · 73 / 87 | 52 / 62 · 52 / 61 |
| Cold revisit of a distant page | 1,000 | 81 / 99 (0 reads) | 52 / 61 (13 reads) |
| | 5,000 | 87 / 92 | 58 / 90 (15 reads) |
| | 10,000 | 94 / 129 | 72 / 91 (15 reads) |

Cache behaviour: in bounded runs the pair test misses only on its first transition (0.9 reads/transition average); a revisit reads only the visible-row tiles (13–15 files), not the whole 100-tile page. Total native reads across both traversals, pairs and revisits were 2,173 / 10,230 / 20,230 (1,000 / 5,000 / 10,000) versus 999 / 4,999 / 9,999 in v9. A full traversal of a library larger than the cache therefore always misses, as intended; each miss is one local file read of about 31 KiB. First-traversal cost no longer grows with library size (75 ms at 10,000, versus 133 ms in v9, whose first-traversal pages carried the growing heap). It is not established why v9's cached transitions are slower than bounded cold ones; the machine was not isolated and no causal attribution is claimed. Pagination latency is therefore not worse under the bound in this fixture.

CPU over the traversal workload (process tree, seconds, two runs): v9 19.8 / 19.7, 80.9 / 83.0, 178.5 / 181.8; bounded 17.3 / 18.0, 64.9 / 65.8, 126.2 / 130.1. Startup readiness (launch to restored image + 2 rAF) is unchanged: 1,000: 180 / 176 vs 178 / 190 ms; 5,000: 230 / 224 vs 220 / 226; 10,000: 297 / 318 vs 301 / 321 ms (v9 vs bounded). Startup still issues zero thumbnail reads beyond the restored frame's.

Durability and offline: in all 12 native runs the cache directory fingerprint (file count and SHA-256 over names and contents) was identical before and after, equal to the fixture (1,000 / 5,000 / 10,000 files), and the driver recorded zero `get_thumbnail_image` source calls, including all post-eviction revisits. Aliases, migration, Clear/Undo, Saved removal, discard, failed and partial saves and generation invalidation are covered by the deterministic tests below, not by the native run (which does not exercise them).

### Tests

New in `test/thumbnail-demand.test.mjs` (after the "Bounded in-memory retention" marker), all deterministic with the native double enforcing `entry ∈ keep`:

- traversal of 1,000 pinned files stays ≤ 300 resident; a later save still keeps all 1,001 files; an evicted file hydrates again with zero source calls;
- an evicted entry re-added with equal bytes is written again (the clean record is dropped with the entry);
- byte bound binds at 128 entries for 128 KiB files and a hydrated 84-thumbnail Stats page is fully readable;
- recently used entries are evicted last;
- four concurrent views share one native read;
- a read landing after the file was pruned, or after a newer in-memory value was stored, neither resurrects nor clobbers;
- 350 unsaved pinned entries survive hydration and do not squeeze out clean entries; they leave memory once written; 320 unsaved entries do not starve an 84-thumbnail Stats page;
- a failed save retries exactly its own entry, and a failing disk does not unbound memory;
- Saved removal plus Clear prunes evicted files, rejects a stale in-flight read and keeps every other file;
- legacy migration of 400 pinned entries ends bounded with all files on disk;
- a cleared entry re-added with the same bytes after an in-flight save is written again (observed to pass with and without the reviewer's stale-record guard, so it only guards the re-add scenario; the guard is a memory hygiene fix).

The first eleven new tests were verified to fail on the v9 `frame-cache.ts` (the stale-read test only after the harness captured bytes when a read starts, as a real file read does); the two later dirty-entry/Stats tests were verified by the mutation below instead. Mutation checks: counting unsaved entries toward the bound fails the two dirty-entry tests; clearing all records on a failed save fails the failed-save test. Existing tests changed: the failed-save retry now expects only the failed call's entries; `history-thumbnails` awaits the lazy hydration of Saved tiles evicted by 301 injected entries and asserts no source call; two test titles no longer say Saved stays "pinned".

### Independent review

A separate read-only reviewer inspected the diff and every consumer. No P0/P1. It found: P2 dirty entries counted toward the bound and could squeeze a Stats page when saves fail (fixed: only clean entries count); P3 a save completing after an entry left memory re-marked it clean (fixed with an identity guard); P3 Stats strips depended on residency (fixed); test weaknesses in the dirty-entry, failed-save and Stats tests (rewritten so they fail under the mutations above). It confirmed no dirty or unwritten entry can be evicted, `keep` always lists evicted files, and that un-saving only the failed call's entries is safe against native `save`. Not acted on: P3 `trimThumbnails` is O(disk keys + favorites) per new thumbnail (existing); `img.src` strings in the retained Stats ledger/last history page stay alive independent of the cap (bounded by what was rendered); a Nearby tile without the native "saved" bit refetches even if its file exists (existing). Its review was read-only, so the primary assessor ran all tests.

### Gates

```text
npm run typecheck                           pass
npm run lint                                pass (141 files)
npm test                                    230 passed; 0 failed
cargo fmt --check                           pass
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings   pass
cargo test --locked --workspace --all-features    241 passed on one run; see below
PYTHONDONTWRITEBYTECODE=1 python performance/test_native_summary.py   pass
```

**Rust flake, not caused by this change.** `nearby::tests::nearby_service_reuses_overlap_persists_only_checks_and_retries_without_refetch` ("a four-step shift introduces four source jobs") failed in about half of the runs today (5/10 standalone; 3 of 5 full runs) with `src-tauri` byte-identical to HEAD, and had passed in the previous assessment. The full suite passed (241) once. It was not investigated or changed here and remains an open release risk until the race is understood.

### Remaining risks

- Windows WebView2, physical Android and Android's WebView memory behaviour were not rerun; the change is platform-neutral frontend code, but only Linux WebKitGTK is measured. Android's earlier 1,000-thumbnail result (about 348 MiB peak) predates the bound.
- Peak PSS during fast paging still exceeds the idle band by about 450 MiB, and JavaScriptCore/WebKit release memory on its own schedule; idle decay is seconds, not instant, and run-to-run spread is ±100–300 MiB. This is a bounded-plateau result, not an hours-long soak.
- A persistently failing disk (or one entry the native side rejects, which fails every later save) leaves unsaved entries unevictable, so memory grows with new thumbnails in that state. The entries are the only copies, and the bound excludes them deliberately.
- Every traversal of a library larger than 300 entries re-reads files: about 18 reads of 31 KiB per page transition. Disk-cold behaviour was not measured (OS cache warm).
- `trimThumbnails` and `keepKeys` remain O(disk keys + favorites) per persist, as in v9.
- Sustained fast paging while thumbnails are first being written leaves up to a full library of unsaved entries in memory until the debounced save; this is unchanged v9 behaviour.

### Retained evidence

[`performance/results/native/v10-bounded-*`](performance/results/native): `baseline-v9`, `baseline-v9-repeat`, `final`, `final-repeat` for 1,000 / 5,000 / 10,000 (run report, 250 ms process-tree samples with PSS/RSS, metadata, disk fingerprints, all gzip), `v10-bounded-summary.json`, and `v10-bounded.patch` (`git diff HEAD -- src`, SHA-256 `7094c5c6d0da2a8efedb5ab115e849f78156f3ad3f79040fac56e29424462910`; it is the production delta measured by the `final` and `final-repeat` builds). Raw profiles are not retained. The discarded first-round runs are not archived.
