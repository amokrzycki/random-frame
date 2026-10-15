# HEAD integration with collections

## Recovery points

- Original client base: `c91d61053c82a6341e77956de031291e4d342689`.
- Reviewed HEAD implementation checkpoint: `38b73a1`, branch `backup/sync-head-before-collections-20261015`.
- Rebased onto fetched `origin/main`: `a70723566872261cad513f77316152a4a5e46d54` (collections, PR #68).
- Additional exact source archives, binary patches and SHA-256 manifests: `/tmp/sync-head-integration-20261015/{client,server}.{tar.gz,patch,json}`. Ignored builds, credentials and application data are excluded.
- Server starting commit: `0b31e6bbc37d818ae7df941bc15217e5c61dec6b`, local reference `backup/sync-head-server-before-collections-20261015`. Its existing Cargo version/lock and README edits are preserved separately in the server archive; no source or contract change is needed.

## Change map and invariants

- `sync/managed.rs`, `admin.rs`, `engine.rs`, `state.rs`: group-scoped upgrade consent, actual decoded schemas, monotonic accepted/config/publication floors, exact-request journal replay, HEAD actions and status. Protocol and control remain v2; the server's minimum schema remains 2; new plaintext snapshots are v3.
- `sync/reconcile.rs`, `cas.rs`: retained main's schema-aware Restore/Merge for v1–v3, including schema changes during retry. Managed Sync now uses the same domain-aware Restore target and captures durable local state before retry.
- `persistence/transaction.rs`: retained main's complete library merge/replace journal. A Restore operation receipt is committed inside that transaction so later local edits survive replay after an admin-journal cleanup failure.
- Snapshot, crypto, transport: collection codec/CRDT remains main's; membership HPKE and managed AEAD remain HEAD's. The authenticated control is server-authoritative, not independently signed. Collection content stays inside encrypted payloads. No server collection model or SQL migration is introduced.
- IPC, `sync-api.ts`, `sync-dialog.ts`, HTML/styles/fakes: both upgrade and key-update states, HEAD actions, collection counts and Restore/Merge copy coexist. Recovery retries freeze their code just as joins freeze invitation and mode. Saved, organizer, navigation and cache remain main's implementations.
- Equality assertions now include collection names/registers, assignment records and both sets of tombstones. Existing HEAD security and collection persistence tests are retained.

## Verification

Current-run logs are in `/tmp/sync-head-integration-20261015`. Final command results and environmental limits are reported in the completion message; earlier thread results are not counted.

Run full client CI with `npm ci`, `npm run lint`, `npm test`, `cargo fmt --check --manifest-path src-tauri/Cargo.toml`, `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --workspace --all-targets --all-features -- -D warnings`, `cargo test --locked --manifest-path src-tauri/Cargo.toml --workspace --all-features`, and `npx tauri build --no-bundle`.

Managed E2Es spawn their own loopback HTTP server and temporary SQLite with `RF_SYNC_SERVER_BIN=/absolute/path/to/random-frame-sync-server cargo test --locked --manifest-path src-tauri/Cargo.toml sync::managed_collections_tests::real_server -- --ignored`. They cover offline convergence, empty collections, names, memberships/deletions, old managed v2 consent and Restore/Merge, migration without resurrection, accepted PUT/restart downgrade, CAS schema changes, replay after applied Restore and write failure, damaged ciphertext and HTTP size rejection. The existing membership E2Es now carry a complete library through legacy migration, pairing, multiple rotations, recovery and lost responses.

No production deployment, real group operation, push or PR is part of this integration. Whole-server SQLite rollback remains the pre-existing procedural boundary described in the server deployment documentation.

## Results from this integration run

- `npm ci`: passed; `npm run lint`: passed; `npm test`: 158 passed.
- Rust 1.99.0 workspace/all-features: 210 passed, 19 opt-in tests excluded from the default command. Seventeen of those were run separately: 15 local HTTP/SQLite E2Es, isolated desktop keyring roundtrip, and snapshot scaling through 1,000,000 IDs; all passed.
- Client Rust fmt and workspace/all-targets/all-features Clippy with warnings denied: passed.
- Server fmt, Clippy with CI flags, 14 tests, and locked build: passed. Server HEAD and the three existing edited files match the original backup hashes.
- `npx tauri build --no-bundle`: passed.
- Android x86_64 debug build and full smoke on the 16 KiB emulator: passed, including force-stop persistence and corrupted Keystore ciphertext preserving local data and refusing a replacement group.
- Android ARM64 debug build, APK identity/ABI/permissions/16 KiB alignment check, and ARM64 Clippy with CI flags: passed.
- Browser: inspected HEAD and upgrade dialogs with mocked IPC at desktop and 360 px. Verified scrolling without horizontal overflow, exact-member remove confirmation focusing Cancel, Escape returning focus, and Later closing with zero approval/upload calls. Native Android smoke uses the real IPC and a local storage-only HTTP mock; security E2Es use the real server.
- Final comparison against fetched main and the pre-rebase checkpoint found no conflict markers or unrelated source changes. Collections' store, organizer, navigation and cache implementations remain those from main; the full library equality check now covers all collection domains.

Not run: the production HTTPS/service-control test, forensic tests needing private incident profiles, native Windows runtime, or a physical Android device. No production or real-group operations were performed. The existing whole-SQLite-restore security limitation remains procedural. A pending exact request rejected by a custom server size limit is retained for retry; the integration verifies that neither the local library nor the prior remote payload is lost.
