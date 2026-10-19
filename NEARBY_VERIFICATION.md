# Nearby Frames verification — 2026-10-19

Implementation is integrated on `feat/nearby-frames`. Release verification is **incomplete**: Windows and manual screen-reader/forced-colors checks remain, and Android native stress encountered intermittent unresolved WebView crashes. Two-consumer native sweeps completed, but a later native crash was also recorded after a bounded run; matching the client queue is not claimed to fix the runtime failure. Nothing was committed, pushed or published. The input plan under `docs/` is locally excluded by the existing `.git/info/exclude`; it was updated in place without changing those exclusions.

## Implemented behavior

- Checked base-36 windows have nine fixed positions, explicit endpoint placeholders and exact ±4 centers with five-ID overlap. The viewer anchor appears immediately and remains Current as the numerical center changes.
- Preview checks use the real exploration journal without History, Seen, Saved or Activity effects. Full-image selection carries explicit Nearby intent through both loader stages and every retry, then accepts History/Seen with no Draw operation. Statistics project frames from original keyed Draw operations.
- Snapshot v4 enforces the semantic boundary. Frozen v3 decoding rejects v4; legacy ingestion and the mandatory startup receipt preserve historical Seen. Numeric consent4 gates new publication. Exact prepared v3 administrative requests replay unchanged with their original consent before the separate v4 decision.
- Shared native raw jobs, membership cancellation, stale-response guards, 2-preview/3-total admission, source cooldown, one decoder, limited codecs and pixels, 27 preview entries, and a one-item 15MB/30s raw handoff bound work. Shared ordinary JPEG caches have 300-entry/8MiB caps and preserve Saved numeric aliases.
- The dialog follows the existing chrome, focus and Back owners. Stable 3-column 4:3 wells, reserved captions/feedback, keyboard navigation, interrupted/hidden/reduced motion and native Android insets are integrated. Expired binary handles re-resolve at most once.

## Automated and native results

Commands use installed Rust 1.99.0. Sandbox restrictions on local listeners, subprocesses and Android caches required escalated execution; those calls were approved automatically.

| Check | Result | Local evidence |
| --- | --- | --- |
| `npm run lint` | Pass, no errors/warnings | `/tmp/nearby-final-lint.log` |
| `npm test` | 185 passed | `/tmp/nearby-final-node.log` |
| `cargo fmt --check --manifest-path src-tauri/Cargo.toml` | Pass | `/tmp/nearby-final-fmt.log` |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --workspace --all-targets --all-features -- -D warnings` | Pass | `/tmp/nearby-final-clippy.log` |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace --all-features` | 235 passed; 20 opt-in tests excluded | `/tmp/nearby-final-rust.log` |
| `RF_SYNC_SERVER_BIN=… cargo test … real_server_ -- --ignored` | 11 passed against actual HTTP/SQLite server, including v3 replay→consent4, two-device exploration-only Restore/restart | `/tmp/nearby-final-real-server.log` |
| Configured legacy real-server cases | Five passed across isolated runs; fixed-root v1 case required a fresh database | `/tmp/nearby-all-real-sync.log`, `/tmp/nearby-v1-e2e-final.log` |
| `npx tauri build --no-bundle` | Linux release build passed | `/tmp/nearby-final-linux-build.log` |
| Linux release startup | Stayed running for the six-second isolated-profile check; existing GTK titlebar warning | `/tmp/nearby-linux-startup.log` |
| `npx tauri android build --debug --target aarch64 --apk --ci` | Pass | `/tmp/nearby-final-arm64-build.log` |
| arm64 APK permissions/ABI/16KiB ZIP+ELF gates | Pass | `/tmp/nearby-final-arm64-apk.log`; APK `/tmp/nearby-arm64-final.apk` |
| x86_64 Android build and APK gates | Pass | `/tmp/nearby-final-x86-build.log`, `/tmp/nearby-final-x86-apk.log` |
| 16KiB Android interaction smoke | Passed full image, immediate Current, initial eight/two-active checks, four new checks after shift, Back/focus return, unchanged inspection History/Activity, Current no-op, native acceptance and explicit loader intent | `/tmp/nearby-android-smoke-final.log` |
| 16KiB resource run | Nine-invoke diagnostic repeats crashed in WebView `MemoryInfra`; matching two-consumer 18-window native calibration passed. All Nearby, bounded resource/trim and media-emulated reduced-motion checks passed; subsequent existing secure-storage cold-start liveness check failed with native WebView crash | `/tmp/nearby-final-bounded-android.log`, `/tmp/nearby-android-resources.log` |

Default Rust opt-ins were not silently treated as tested. Eleven were run with the real server binary and five against configured local endpoints. Production HTTPS/SSH, an unlocked desktop keyring, historical incident profiles and the manual size benchmark were not configured.

Focused regressions include real persistence restart/journal failures, Restore and two-device no-Seen convergence, frozen old-reader incompatibility, queued cancellation/coalescing/caps against local HTTP, explicit 403/429 retry, native codec/orientation/first-frame/pixel limits, cache/TTL cleanup, selection retry intent, dismissal during work, Saved alias pinning, one-shot expired-handle recovery, malformed cached JPEG validation/recovery, and original Draw-day attribution through legacy numeric aliases. A concurrency test originally asserted server arrival immediately after permit acquisition; its wait now observes both events. The WebView driver now rejects disconnect/error and bounds evaluation at 60 seconds; its crash regression was observed RED→GREEN.

## Android resource and accessibility evidence

The existing `rf16k` AVD ran read-only, preserving its saved profile. Android reported page size 16384 and approximately 2.4GiB total physical memory to the guest (`hw.ramSize=2G` configuration). Preview transport in the UI interaction fixture is synthetic; acceptance, History and Activity commands are native. The resource test separately persists 41 valid local 2048×2048 JPEG fixtures and resolves them through the real native decoder/cache, with no source fallback. Two sweeps of nine windows exercise cache eviction beyond 27 IDs. Twelve UI reopen/close cycles leave no gallery-created object URLs or image nodes.

In the final bounded run, app-process PSS was 149,000KiB before stress, peaked at a sampled 163,445KiB, and was 159,623KiB after close/critical trim. RSS was 280,380→302,972 peak→299,292KiB. These are sampled app-process values, not an aggregate WebView-renderer or hard allocation guarantee. The viewer remained responsive after `RUNNING_CRITICAL` trim. Encoded frontend data URLs add approximately 4/3 base64 character overhead (up to roughly 10.7MiB of characters for the 8MiB ordinary JPEG budget, potentially more resident string storage).

The repeated run failed with SIGTRAP in WebView 124.0.6367.219 `libmonochrome_64.so`, thread `MemoryInfra`, with no Rust frames. Root cause is **not established**. Idle current-app memory sampling and repeated DevTools attachment passed. An untouched-HEAD export also passed 80 samples without and 80 samples with the same synthetic IPC bridge; this does not identify the intermittent failure. The final two-consumer run passed the feature, memory/trim, media-emulated reduced-motion and no-startup-traversal checks, then failed the existing damaged-Keystore cold-start liveness gate with the same native crash. Crash logs are `/tmp/nearby-android-crash-logcat.txt` and `/tmp/nearby-android-exit-info.txt`. The failure also occurred without the fixture bridge/UI and without binary reads. The same large-canvas/cache setup on untouched HEAD passed 120 samples without Nearby commands; its populated-profile cold start also passed 80 samples (`/tmp/nearby-baseline-populated-cdp.log`). This comparison does not establish an external-only cause. A subsequent native stress run using exactly two concurrent resolves/reads, matching the production gallery, passed all 18 windows; PSS settled at 155,584KiB and RSS 294,460KiB. The failure is not labeled fixed or attributed to WebView alone: `/tmp/nearby-latest-exit-info.txt` also records a later native crash after a completed bounded run. Correlation with the burst diagnostic is insufficient to establish the root cause.

Installed TalkBack was enabled temporarily and restored afterward. The actual Android WebView accessibility tree and native hierarchy expose “Nearby Frames” as a dialog, concise open/retry labels, “Current frame abc123”, static unavailable text, named Previous/Next controls and one summary (“5 previews available, 1 unavailable, 2 need retry”). Evidence: `/tmp/nearby-native-ax.jsonl`, `/tmp/nearby-talkback-2.xml`, `/tmp/nearby-talkback-service.txt`. This proves native semantics, **not** a completed spoken TalkBack usability pass. WebView 124 continued to report reduced motion as false with all three Android animation scales disabled. The renderer reduced-motion test uses explicit media emulation; propagation of the OS preference remains unverified on a current engine/device. Desktop screen reader and actual forced-colors OS behavior remain unverified.

## Bounded visual review

Controlled local synthetic imagery was used throughout. No live source grid is required by CI. All matrix cases had nine equal-height wells, valid visible image sources, captions within their wells, visible footer controls, one Current label, and no document/horizontal scrolling. Endpoint cases had four non-actionable boundary slots. Actual browser End/Home/ArrowDown and Escape checks passed; Escape returned focus to the frame-menu button.

| Case | Body scroll | Screenshot in the local browser artifact directory |
| --- | --- | --- |
| Light desktop 1440×900 | No | `browser-screenshot-localhost-mvffswgx-3e42fec4.png` |
| Dark desktop 1440×900 | No | `browser-screenshot-localhost-mvfft690-b179370b.png` |
| All-error 800×600 | Yes | `browser-screenshot-localhost-mvffyoeb-cf104c17.png` |
| Android 375×667 | No | `browser-screenshot-localhost-mvfftlio-2c5bc71e.png` |
| Android 320×568 | Yes | `browser-screenshot-localhost-mvffttkd-ec23c8f7.png` |
| Android landscape 667×375 | Yes | `browser-screenshot-localhost-mvffu722-baa5039e.png` |
| Lower endpoint | No | `browser-screenshot-localhost-mvffuhde-14ae94fb.png` |
| Upper endpoint, Android | No | `browser-screenshot-localhost-mvffuryv-0650ee50.png` |
| 200% text, 800×600 | Yes | `browser-screenshot-localhost-mvffv3xq-f1a24323.png` |

Screenshots live under `/home/adrian/.t3/userdata/browser-artifacts/`. Android targets measured at least 48px. The compact error review found an 18.8px desktop Retry target; it now measures 24px with unchanged footer visibility. The width adjustment below restored all nine visible positions at normal desktop size. The final confirmation checked those concrete defects. Reduced-motion code paths have regression coverage; the renderer check passed with explicit media emulation, and the OS preference propagation gate remains open.

## Decisions, review and remaining gates

The fresh default-model reviewer found no critical issues and one Saved alias pinning issue, which was regraded Important and fixed RED→GREEN across eviction, clear retention and in-flight results. No reviewer findings were deferred. All rulings are retained in the plan ledger:

1. Use the existing clean feature checkout without a new worktree or commits, following the user's instruction. Cost: no additional checkout isolation; all initial edits were ours.
2. Keep the ignored execution ledger because no commits exist to replace it. Cost: its scratch evidence is local, and repository exclusions must not be cleaned away.
3. Treat unrecognized/challenge 200 HTML as operational; only trusted 404/410 classify unavailable until a trustworthy deleted-document fixture exists. Cost: some actual deleted pages may remain retryable.
4. Enrich known exploration evidence during standard successful/rejected checks without adding Activity. Cost if wrong: existing Draw attribution could change; real persistence/Activity regressions cover that boundary.
5. Reserve the longest caption and recovery text in invisible layout material, so arriving errors cannot move tiles. Cost: narrow/large-text galleries use internal scrolling sooner.
6. Replay exact prepared v3 requests under their original consent, then require independent numeric consent4. Cost: v4 chains reject older clients; local downgrade is unsupported. Frozen-reader and real-server evidence justify this architectural boundary.
7. Adjust desktop width from 528px to 532px: rendered Archive Sans needs 132px for the reserved status, while the original caption had 131.3px. Cost: 4px wider dialog; existing type, inset, gaps, height limit and nine visible positions are preserved.
8. Preserve opt-in real-server gates and explicitly run them with their prerequisites. Cost: default `cargo test` alone does not prove deployed Sync behavior.
9. Calibrate native resources with the actual two-consumer client queue rather than nine diagnostic invokes. All 41 IDs, 18 windows, >27-entry eviction and decoder work remain exercised. Cost: intermittent native WebView crashes remain unresolved, including a later exit after bounded stress; native service backpressure under larger queues is still covered by local-HTTP Rust tests.
10. Withhold release-complete status while native crash/platform gates remain open. Cost: release is delayed; no unverified platform outcome is presented as passed.

Remaining required proof: diagnose the intermittent native WebView cold-start/reliability crash with symbolized runtime evidence or an independent current device/engine, then obtain a clean full Android gate and verify Android OS reduced-motion propagation; Windows CI/runtime; manual spoken TalkBack and desktop-reader behavior; actual forced-colors mode. Physical low-memory hardware and production HTTPS integration were not exercised. The project’s ignored Impeccable sidecar remains older than DESIGN.md and was not regenerated as an unrelated design-system change.
