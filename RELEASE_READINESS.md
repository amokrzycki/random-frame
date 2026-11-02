# Release readiness — 2026-11-01

## Final update — remaining test-infrastructure P3s closed (2026-11-01, HEAD `625b425` plus working tree)

**Classification: TEST_INFRASTRUCTURE only. No production change. Rust suite gate: PASS on Linux. Overall recommendation unchanged: READY_WITH_LIMITATIONS.** Both P3 items left open by the previous update are now closed. Nothing is committed, pushed, tagged or published.

### What changed (all test-only)

- `src-tauri/src/sources/prntsc/fetch.rs`: both loopback fixtures now classify the source's own `GET /page/<id>` and `GET /asset/<id>` requests. Foreign connections (`GET /`, TLS `ClientHello`, empty or non-GET requests) receive 404, are never counted and can never consume the pause test's first 403/429 response. Each connection is handled in its own task, so a silent probe cannot block an application request. Every app request still counts, so a genuine duplicate remains visible to the existing exact-count and error-kind assertions. Injected probes run before and during both tests; assertions that the probe count did not change sit beside the original expectations.
- `src-tauri/src/test_support.rs` (new, `#[cfg(test)]` only): one classifier and one bounded probe shared by the Nearby and raw-fetch fixtures, replacing two copies. Probe replies time out after five seconds, so a future classification regression fails instead of hanging.
- `src-tauri/src/nearby.rs` (`#[cfg(test)] mod tests` only): `Traffic` now uses the shared classifier for pages, assets and foreign traffic; responses follow the same classification. The established request-count, ordered-ID, asset and user-agent assertions are unchanged.
- `src-tauri/src/lib.rs` (`#[cfg(test)]` only): `CHILD_SPAWN` remains the gate, now exposed through `child_spawn_guard()` with the same poison-safe locking. The profile-lock fixture still holds it for the child's whole life because it waits for exit.
- `src-tauri/src/sync/membership_tests.rs`, `src-tauri/src/sync/tests.rs` (test-only): every child spawn in the ignored real-server tests now takes the same gate across the fork/exec window only: the managed-sync server fixture, the two-device server fixture, and the SSH service helper. The SSH gate is released before `wait()`. Child cleanup (`kill`/`wait` in `Drop`) and all cross-process locking tests are unchanged.

### Deterministic regression evidence

- With the counter restored to "every accepted connection", `shared_jobs_coalesce_and_last_consumer_cancels_all_admission` fails deterministically: `left: 3, right: 1` after the injected probes (fixed code passes).
- With the pause response restored to "first accepted connection", `upstream_pause_keeps_nearby_explicit_and_library_thumbnails_respect_cooldown` fails deterministically: `left: None, right: Some(0)` because the probe consumed the 403 (fixed code passes).
- `test_support::recognises_only_application_requests` covers pages, assets, bare `GET /`, empty id, query string, non-GET method, TLS bytes and an empty connection.
- The Nearby and profile-lock regressions from the previous update are unchanged and pass; the ignored real-server tests now also use the lock gate.

### Verification on the final code

| Check | Result |
| --- | --- |
| `cargo fmt --check` | PASS |
| Exact CI Clippy: `--locked --workspace --all-targets --all-features -- -D warnings` | PASS |
| Exact CI Rust tests: `--locked --workspace --all-features` | PASS; 243 passed, 22 ignored, 3/3 consecutive runs after the final edit |
| Full suite across the whole change sequence | 8 consecutive PASS (5 before helper consolidation, 3 after) |
| Nearby fixtures (`nearby::tests`) | PASS; 2/2 |
| Raw-fetch fixtures and classifier (`sources::prntsc::fetch::tests`, `test_support`) | PASS; 3/3 |
| Profile-lock fixture (`tests::profile_lock_blocks_other_processes_until_exit`) | PASS |
| Ignored real-server Sync tests with the pinned server binary `5fc35ae` | PASS; 11/11, three runs (including after the shared-helper and SSH changes) |
| `git diff --check` | PASS |
| Frontend checks | NOT_RERUN: no frontend, TypeScript, package or build input changed |

The real-server runs used `/home/adrian/Repos/random-frame-server` (clean, commit `5fc35ae`, the same pin as CI) with `RF_SYNC_SERVER_BIN`; they exercised actual HTTP and SQLite. The separate production HTTPS E2E tests still require `RF_SYNC_E2E_*`/SSH credentials and were not run.

**Environment note:** `/tmp` is a 32 GiB tmpfs and was 100 % full from previously generated benchmark artifacts. Two full-suite runs failed only with `No space left on device` in `persistence::…history_above_old_cap…`, not an assertion. Re-running with `TMPDIR` on `/home` produced the 5/5 and 3/3 green runs above. CI runners are unaffected; free `/tmp` or point `TMPDIR` elsewhere before running large suites locally.

### Independent review

A separate read-only reviewer found no P0/P1/P2, confirmed the changes are test-only, and reproduced the ENOSPC failure as environmental. Its three P3 notes were fixed: duplicate probe/classifier code was consolidated into `test_support.rs`, the probe gained a timeout, and the SSH child gate was narrowed to the spawn window. The reviewer verified request classification against the actual `with_test_base` URLs, exact-counter coverage for duplicate app requests, no guard held across `await`, poison-safe locking, and unchanged `Server` kill/wait cleanup.

### Working-tree audit and proposed commits (owner approval only)

| Area | State |
| --- | --- |
| Production | No change. Every modified path is `#[cfg(test)]`, inside a test module, or an ignored test. |
| Test-only | `src-tauri/src/test_support.rs` (new), `fetch.rs`, `nearby.rs`, `lib.rs`, `sync/membership_tests.rs`, `sync/tests.rs`. |
| Benchmark infrastructure | No tracked change. Raw evidence remains ignored under `performance/results/` (about 15 MiB), including the flake investigation; not a release input. |
| Documentation | `RELEASE_READINESS.md` updated (untracked). `PERFORMANCE.md` unchanged. |
| Ignored/generated | `src-tauri/target/` (about 28 GiB), `node_modules/`, `dist/`, `performance/results/`, Android generated/build output, `.codegraph/`, `.superpowers/`, `.impeccable/`, `AGENTS.override.md`, `UX_DECISIONS.md`. Keep out of commits. |

Proposed logical commits, preserving existing history (do not rewrite `625b425` or earlier):

1. `test: classify loopback fixture requests` — `test_support.rs`, `fetch.rs`, `nearby.rs`, and the `#[cfg(test)] mod test_support;` line in `lib.rs`.
2. `test: gate remaining child spawns` — `CHILD_SPAWN` helper in `lib.rs`, `sync/membership_tests.rs`, `sync/tests.rs`.
3. `docs: record final test hardening` — `RELEASE_READINESS.md`.

A single combined test commit would also be coherent; the split is only for reviewability.

### Remaining validation gaps

Unchanged from the assessment below: native Windows/WebView2, physical ARM64 Android and release APK, installer/packaging, disk-cold boot, GPU presentation, and physical input/assistive technology are NOT_TESTED. Production HTTPS Sync E2E needs private credentials. The local pinned real-server suite and all ordinary Rust/frontend-adjacent gates pass; no test was excluded to obtain a pass.

---

## Update — intermittent Rust test failures investigated and fixed (2026-11-01, HEAD `d9de34d`)

**Classification: TEST_BUG with an environmental trigger (Nearby test) plus a second TEST_BUG (profile-lock test interaction). No production defect. Release gate for the Rust suite: cleared, with the statistical caveat below. Overall recommendation unchanged: READY_WITH_LIMITATIONS** (platform gaps, and nothing is committed yet).

The earlier note that the Nearby test explained all full-suite failures was incomplete. HEAD had **two** independent intermittent failures:

**1. `nearby::tests::nearby_service_reuses_overlap_persists_only_checks_and_retries_without_refetch`**
- Signature: `src/nearby.rs:555` `assertion left == right failed: a four-step shift introduces four source jobs`, `left: 13` (or `14`), `right: 12`. Always *more* requests, never fewer.
- Frequency at HEAD (idle machine, host network): isolated 0/30; full suite parallel 3 of 8 runs failed on this test in the first batch, 3/12 and 4/25 in later batches; `--test-threads=1` 3/3. The rate varied widely between batches.
- Cause: the loopback fixture counted every connection that was not `GET /asset/` as a source-page request. Another process on the machine probes freshly opened loopback listeners: a bare `GET /` (`user-agent: node`, `b3`/`traceparent` headers; 314 bytes) and a TLS ClientHello. `ss -tnp` attributes the probe sockets to the `t3code` process; the listener received probes 0.3 s after binding and then roughly every 15 s. That explains `13` (one probe) and `14` (both). Nothing in this repository emits that traffic.
- Evidence it is the only cause: all 4 instrumented failures log exactly 12 genuine `GET /page/<id>` requests, each ID once and each followed by one asset request, plus 1 foreign request. No failing run had a duplicated or missing genuine request. Production Nearby/raw-fetch/limiter code is unchanged and issues each request once (jobs are keyed by ID, the limiter only delays, the test awaits resolves serially).
- Causal A/B on the HEAD binary, full suite, interleaved: host network 7 Nearby failures in 37 runs; private loopback (`unshare -rn`, no scanner) 0 in 37. Deterministic reproduction: the unmodified HEAD test with two probe connections injected before the final count fails with `left: 14, right: 12`, the original signature.
- Not explained: the scanner's timing does not predict the observed failure rate (a ~15 s period against a 1.3 s test predicts ~9 %, observed 16–60 % and 0/30 isolated). The rate was not modelled; causality rests on the request logs and the A/B, not on a timing model. A GitHub runner most likely has no such scanner, so this specific trigger probably would not fail CI at this rate; the fixture was still invalid.

**2. `tests::remote_snapshot_changes_only_seen`, `tests::legacy_history_import_does_not_count_views_again`, `tests::startup_merges_history_and_only_viewed_legacy_exploration` (and any drop-then-reopen test)**
- Signature: `Cannot lock app data; another Random Frame may be running: lock acquisition failed because the operation would block`.
- Cause: `tests::profile_lock_blocks_other_processes_until_exit` spawns children of the test binary. Between fork and exec a child holds a duplicate of every open fd, and a `flock` survives the parent's `close` while any duplicate exists. A parallel test that drops its `AppState` and reopens the same profile in that window fails. Evidence: full suite with the spawning test 7/30 runs hit the error, without it (`--skip`) 0/30; `performance/results/flake-investigation/forkwin.py` reproduces the EAGAIN deterministically at OS level. This does not depend on the network scanner, so it plausibly affects CI as well (observed here about 10–25 % of full runs).

**Files modified (tests only; nothing compiled into release builds changes)**
- `src-tauri/src/nearby.rs` (`#[cfg(test)] mod tests` only): fixture records `/page/<id>`, `/asset/<id>` and foreign requests separately, one task per connection; the test asserts `Resolution::Available` on every resolve (failure message includes variant, kind, retry-after and traffic), asserts exact ordered page and asset ID lists at each phase (overlap IDs never refetched, abc128 fetched once across the retry, four new IDs once each), injects two real-world probes mid-run, and asserts ignored traffic never carries the app's own user-agent (so the filter cannot hide an app duplicate). New unit test `fixture_counts_only_source_requests`.
- `src-tauri/src/lib.rs` (`#[cfg(test)]` only): static `CHILD_SPAWN` mutex; `AppState::new` waits on it, and the profile-lock test holds it while its children run.
- No change to `nearby.rs` production code, `sources/prntsc*`, `rate_limit.rs`, persistence, frontend or the thumbnail-memory work. Frontend checks were not rerun because nothing connected changed.

**Regression evidence**
- With the old counting rule restored, both new Nearby tests fail (extra foreign entries counted as pages); with the fix they pass.
- HEAD test plus injected probes fails `left: 14, right: 12`; the fixed test passes with the same probes.
- Lock flake: 7/30 before the gate, 0 of 120 full runs after (see below). There is no deterministic in-suite regression for the fork window; evidence is the A/B, the OS reproduction and the code reasoning.

**Verification on the final code**
- Targeted Nearby test isolated: 40/40 pass. `nearby::` group in parallel: 30/30. Full suite default parallel: 60/60 (twice, 120 total; the first 60 on the code just before a comment/refactor-only change). `--test-threads=1`: 3/3. Exact CI command `cargo test --locked --workspace --all-features`: 242 passed, 22 ignored (twice). `cargo fmt --check` and the exact CI Clippy (`-D warnings`) pass. Android-target Clippy not rerun (changes are `cfg(test)`).
- These are encouraging repeats, not proof the failures are impossible: a 23 % per-run lock failure would produce 0/120 with probability about 1e-14 and a 25 % Nearby rate 0/120 about 1e-15, but a rarer residual flake could remain.

**Independent review:** a separate read-only reviewer found no P0/P1. It confirmed both causes from the logs, reproduced the lock flake itself (1/30 without the gate, 0/50 with), found no hidden production race, no weakened assertion, no deadlock or poisoning gap in the gate, and no production behaviour change. P3: the fixture self-test is more machinery than strictly needed (kept: it pins the classification rule); one comment clarified (done).

**Remaining items (not fixed here)**
- P3: the `fetch.rs` fixtures count every accepted connection and the pause test picks 403/429 by arrival order, so a stray probe could break them; their listeners are very short-lived so they did not fail. Same class, left untouched. **(Closed by the final hardening update above.)**
- P3: the `#[ignore]`d real-server sync tests spawn children without the `CHILD_SPAWN` gate. **(Closed by the final hardening update above.)**
- Raw logs, the instrumentation patch and the final patch: `performance/results/flake-investigation/` (ignored, not tracked). Nothing was committed, pushed or published.

---

Assessment target: `b05c7d0e313bd42a09819f9ffac3c9e918399334`.
Campaign base: `4209124`; v9 base: `d6e3c10`.

**Recommendation at the time: READY_WITH_LIMITATIONS (see the update above for the current state).** The assessed Linux runtime passes; Android debug/emulator workflows pass. This is not a native Windows or physical Android release sign-off. No unresolved data-integrity defect or critical platform regression was identified.

## Update — bounded thumbnail memory (2026-11-01, later the same day)

**Revised recommendation: READY_WITH_LIMITATIONS (unchanged class, narrower limits).** The confirmed P2 below (uncapped pinned-thumbnail retention) is **resolved on Linux/WebKitGTK**. It is not a clean release sign-off: an intermittent Rust test failure (below), the unchanged platform gaps, and a working-tree change that is still uncommitted remain.

What changed (`src/client/frame-cache.ts`, `src/client/stats-dialog.ts`; no Rust, dependency, persisted-format or wire change): in-memory thumbnails are bounded to 300 entries / 16 MiB over *all* clean entries, Saved included, with LRU order. Files are never touched by eviction, the native `keep` set still lists every file, evicted entries read back from disk, native reads are shared, and stale reads cannot resurrect pruned or discarded entries. "Pinned" now means durable on disk, not resident in memory. Full design, rejected alternatives and the semantic change are in [PERFORMANCE.md](PERFORMANCE.md#bounded-thumbnail-memory--2026-11-01-final-phase).

Measured on native Linux release builds, 1,000 / 5,000 / 10,000 Saved, two complete traversals plus revisits, two runs per cell, process-tree PSS, v9 versus bounded, run 1 / run 2:

| Saved | Idle PSS after 2nd traversal, v9 → bounded | Peak PSS, v9 → bounded | Live thumbnails, v9 → bounded |
| ---: | ---: | ---: | ---: |
| 1,000 | 623 / 513 → 550 / 522 MiB | 761 / 703 → 667 / 651 MiB | 999 → 300 |
| 5,000 | 1,174 / 1,057 → 563 / 609 MiB | 1,903 / 1,763 → 1,151 / 937 MiB | 4,999 → 300 |
| 10,000 | 1,929 / 1,825 → 707 / 610 MiB | 3,139 / 3,441 → 1,117 / 1,112 MiB | 9,999 → 300 |

Bounded memory reaches a plateau (about 480–800 MiB idle, about 1.1 GiB peak during fast paging) that no longer scales with the visited library. All 12 native runs preserved every disk thumbnail byte-for-byte (SHA-256 fingerprint before = after), made zero source requests, and started at the same readiness as v9 (about 300 ms at 10,000). Page transitions were not slower: first-traversal Next at 10,000 is 75 ms versus 133 ms median, cold revisits 72 versus 94 ms, Next+Previous 52 versus 81 ms; the price is about 18 local file reads per page of a traversal larger than the cache. JavaScript counts were not used as evidence; PSS was.

Validation: Biome, TypeScript, `npm test` (230 passed), `cargo fmt`, exact CI Clippy and the benchmark-summary test pass. The full Rust suite passed once (241 passed, 22 ignored) but `nearby::tests::nearby_service_reuses_overlap_persists_only_checks_and_retries_without_refetch` failed in about half of today's runs with `src-tauri` byte-identical to HEAD (5/10 standalone, 3/5 full runs). It passed in the earlier assessment, is outside this change, and was not investigated. **Resolve or explain it before tagging a release; CI would intermittently fail.** A separate read-only reviewer found no P0/P1; its P2 (unsaved entries squeezing out a Stats page when saves fail) and two P3s were fixed and covered. New deterministic tests cover eviction, rehydration, shared reads, stale reads, failed saves, Saved removal/Clear, migration and offline reads; eleven of them were verified to fail on v9.

| Priority | Finding after this update |
| --- | --- |
| P0 / P1 | None identified. |
| P2 | Intermittent failure of the Nearby Rust test above (about 50 % today, unchanged code). Android/WebView2/physical-device behaviour of the bounded cache is unmeasured. |
| P3 | Peak PSS during fast paging is about 450 MiB above the idle band; a failing disk leaves unsaved entries unevictable by design; every traversal of a library over 300 entries re-reads files (OS cache warm in these runs); the 100-entry pagination overhead from v9 is not reproduced in this workload but was not re-measured with the earlier harness. Old P2 pinned-memory retention is **closed** for Linux. |

Evidence: `performance/results/native/v10-bounded-*` (compressed reports with PSS/RSS samples, disk fingerprints, summary and patch). Nothing was committed, pushed or published. The body of the assessment below is the original 2026-11-01 report for `b05c7d0` and is retained for provenance; its P2 table row, "Conclusion" paragraph and "no new cache limit" statements are superseded by this update.

---

**Production diff assessment**

The checkout was clean at entry. There was no uncommitted production changeset to assess. The audit therefore covered both performance commits (`4209124..HEAD`), with separate examination of v9 (`d6e3c10..HEAD`).

- The campaign changes 45 tracked paths: 10 runtime source files, two Rust dependency manifests, 17 frontend test/helper files, 14 benchmark/support files, and two documentation/ignore files. Rust regression tests and the ignored projection benchmark live behind `#[cfg(test)]`.
- Runtime changes are the Saved projection grouping, operation-ID formatting, timestamp formatter reuse, thumbnail transport/persistence/demand hydration, and the necessary stage, History/Saved, Undo, Nearby and Stats integration. No unnecessary runtime change was identified. Sync state machines, persisted record formats, source admission, and animation contracts are unchanged.
- The explicit `base64` dependency was already transitive; it supplies the native encoded-thumbnail response. This assessment adds no dependency or production code.
- Benchmark drivers, fixture routing and reporting commands are confined to disposable copies. Raw generated evidence is ignored under `performance/results/`; it is not a tracked release input. Nothing was discarded.
- The archived v9 production patch exactly equals the current production diff: SHA-256 `5af416c82ee3929b6461be933fc26efc5b255d6beb859fff8be757e21efa04f5`. Baseline patch identity also matches. Final raw summaries reproduce, apart from `.gz` filename suffixes. Summaries with patch `4b1fc3e…` describe an intermediate build and were excluded from final conclusions.

**Validation results**

| Check | Result |
| --- | --- |
| Frontend production build and TypeScript | PASS |
| Biome | PASS; 140 files |
| Full frontend suite | PASS; 217 tests, zero failures/skips |
| Focused demand-cache, partial-write, clear/Undo, refresh, Stats and Nearby regressions | PASS; 51 tests |
| Rust formatting | PASS |
| Exact CI Clippy: `--locked --workspace --all-targets --all-features -- -D warnings` | PASS |
| Exact CI Rust tests: `--locked --workspace --all-features` | PASS; 241 passed, 22 intentionally ignored |
| Android ARM64 library Clippy | PASS |
| Native Android x86_64 debug build and APK policy/alignment check | PASS |
| Benchmark summary accounting regression | PASS; one Python test |
| Normal Linux release build | PASS |
| Campaign/current whitespace checks | PASS |

The normal frontend output has 13 files and contains no test bundles, source maps, fixture endpoints or probe markers. The normal 38,163,288-byte Linux release executable contains none of the benchmark report/config commands or fixture environment hooks. Inspection and added-diff secret-signature checks found no credentials/private keys. Temporary instrumentation and synthetic configuration are excluded from those production outputs.

Initial sandbox test attempts failed because subprocess creation and loopback sockets were prohibited. Full reruns with those capabilities passed; no test was excluded to obtain a pass. The private/pinned Sync server is absent, so its ignored integration tests remain **NOT_TESTED**; local HTTP/CAS, merge, rollback, persistence and recovery fixtures passed.

The Linux native workflow smoke exercised real IPC and files: startup with zero thumbnail reads; History/Saved and populated collection switching; decoded Nearby and navigation; Saved removal/Undo; a populated Stats ledger and persisted-view refresh; durable History clear; all 100 pinned files preserved and rehydrated with zero thumbnail source calls. Four ordinary boundary previews were correctly pruned. A separate native filesystem fault test failed the second repair after the first file changed: pruning waited, retry restored previous bytes, and a later empty clear removed all files.

The first workflow fixture had imported History but no draw activity. Stats correctly rendered an empty ledger; the harness's nonempty-ledger assertion was invalid. Adding synthetic Discovery activity made the complete smoke pass. This was a fixture correction, not a product fix. Concurrent/stale Sync refresh and clear/save/read races additionally pass the deterministic frontend/Rust regressions; this is narrower than a real private-server round trip.

**Platform coverage**

| Platform | Coverage |
| --- | --- |
| Linux Tauri / WebKitGTK | Native release executables, real IPC/files/decoding, workflow smoke and resource measurements. Installer, compositor/GPU presentation, physical input and disk-cold boot are NOT_TESTED. |
| Android 15, WebView 124.0.6367.219, x86_64, 16 KiB emulator | Actual debug APK: fresh/reopen runs at 100 and 1,000 items; two complete 1,000-pinned-thumbnail traversals. Zero startup thumbnail reads, bounded full-image URLs, no detected app/system restart. Home/background/resume retained the PID and Saved-file hash; traversal completed afterward. |
| Android release / ARM64 physical device / constrained-memory kill and restore | NOT_TESTED. ARM64 Clippy is compile/lint evidence only. |
| Native Windows WebView2 | NOT_TESTED. No native Windows runtime was available; Wine and Linux Chromium were not used as substitutes. Native Windows IPC, replacement/path behavior and lifecycle remain unverified. |

**Performance findings**

The 100-entry pagination regression reproduces in three fresh processes per version, with 20 retained samples per process: **50 / 51 ms baseline versus 70 / 71 ms v9** (median / P95, Next + Previous pair). Every process reproduced its version's median. Native reads occurred only at the beginning of the v9 phase; the retained warm samples still showed the difference, so ongoing disk I/O alone does not explain it. The 20 ms pair difference is about one 60 Hz frame opportunity across two transitions. A subtle delay is possible; human perceptibility and compositor presentation were not measured. This small absolute cost does not justify extra state, eager warming or cancellation changes. No pagination fix was made.

The previous report's 10,000-entry claim was inaccurate: its final raw data is **54 → 67 ms**, not unchanged/better. The 1,000-entry result remains 70 → 70 ms. `PERFORMANCE.md` now states those results and removes the unsupported causal attribution.

Real Linux release-process traversals scrolled every row of every Saved page, with distinct valid 31,536-byte JPEG files, decoded-image completion checks and no competing builds/emulator. Measurements below are process-tree **PSS**, which apportions shared pages; the original RSS metric counts shared pages repeatedly. Each scale is one bounded session, not an hours/days soak.

| Pinned library | Before traversal, after ordinary smoke work | After full traversal | Closed + 15 seconds idle | Whole-session peak PSS / RSS |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 475 MiB | 652 MiB | 572 MiB | 679 / 911 MiB |
| 10,000 | 600 MiB | 1,841 MiB | 1,744 MiB | 1,929 / 2,161 MiB |

All 1,000/10,000 pinned entries remained loaded, plus three ordinary previews. Encoded URL characters occupied approximately 40.6/401.7 MiB respectively. Closing and revisiting did not increase the thumbnail count; process memory varied with decode/allocation activity (the 10,000-item revisit reached 1,808 MiB PSS). Both runs ended with zero full-image Blobs/URLs and zero thumbnail source calls. Traversal frame-callback gaps were P95 18/24 ms, with isolated maxima 133/136 ms; these are not presented FPS or proof of human perceptibility.

**Conclusion:** 1,000 entries caused no observed failure. At 5,000 visited entries PSS was already 1,183 MiB; at 10,000 the retained 1.7 GiB footprint is a material cost for a memory-constrained machine. No OOM occurred on this host. Growth follows the intentionally uncapped pinned set; idle and a page revisit do not establish an hours-long leak guarantee. v9 removes the startup cost but defers this retention until browsing. No new cache limit or eviction policy was introduced.

Android's 1,000-thumbnail traversal retained 1,003 thumbnails including three ordinary boundary previews, approximately 40.6 MiB of encoded URL characters. No thumbnail source call occurred. Sampled app-plus-associated-renderer PSS peaked at 348 MiB and fell to 298 MiB after closing/idling; the encoded strings remained cached. Sampling began after traversal started, so this is not an Android startup baseline or a complete peak guarantee. The debug emulator showed no failure at this scale; this does not validate 10,000 thumbnails or physical-device memory pressure.

**Independent review**

A separate default-model reviewer inspected the production diff and connected persistence, cache, History/Saved, Undo, Nearby, Stats and refresh callers. It reported no actionable P0–P3 production defect and no production reference to benchmark probes. Its review was read-only and did not independently execute tests or native workloads. The validation above was performed by the primary assessor; platform and long-duration limits remain explicit.

**Unresolved defects and limitations**

| Priority | Unresolved finding |
| --- | --- |
| P0 | None identified. |
| P1 | None identified; no reproduced data loss, incorrect pruning or critical native regression. |
| P2 | *(Resolved on Linux by the update above.)* Known performance limitation: uncapped pinned thumbnails retain substantial memory after thousands of first visits, as measured above. No OOM or persistence failure reproduced; low-memory kill/recovery remains NOT_TESTED. |
| P3 | Reproducible 20 ms pagination-pair overhead at 100 entries; accepted here because the absolute benefit does not justify additional complexity. No functional failure identified. |

Remaining boundaries: first-use thumbnail latency, O(pinned/library-size) trimming, Stats hydration of up to 84 thumbnails per page, session-scoped rejection of corrupt pinned/alias files, occasional frame/navigation tails, and memory-only ordinary thumbnails that can be regenerated after eviction. These are existing documented limits, not newly discovered data-integrity failures. Windows and physical Android coverage gaps remain unverified risks, not passing results. The factual pagination documentation defect was corrected during this assessment.

**Proposed logical commit grouping — owner approval only**

Existing history was not rewritten. If the owner chooses to reorganize the campaign, use these boundaries:

1. Saved projection, operation-key and timestamp improvements with their regressions.
2. Native thumbnail transport and v9 demand loading, all consumer integration and recovery/race regressions together.
3. Synthetic benchmark/native-platform infrastructure and its harness tests.
4. Performance evidence documentation, this readiness report, and ignore rules. Keep raw profiles, identities, APKs, credentials, temporary probes and generated output out of commits/builds.

The only assessment edits are this report and a factual pagination correction in `PERFORMANCE.md`. No commit, push, publication or release was performed. No actual user profile was used for destructive tests.

Evidence: [readiness artifacts](performance/results/readiness-2026-11-01), including provenance, compressed logs/reports, the temporary harness source and the v9 artifact audit. Raw profiles and synthetic identities are excluded from the retained evidence.
