# Sync v2 persistence and compatibility

PR 1 implements the data and migration layer. Device identity, roster publication,
new Sync status APIs, and the new dialog remain separate work.

## Protocol

Recovery keys, HKDF labels, credentials, encrypted envelope version 1, endpoints,
and revision/CAS are unchanged. The plaintext writer publishes `RFSNAP` version 2.
The decoder accepts versions 1 and 2 and reports unknown versions separately.
The frozen v1 codec and binary snapshot/envelope fixtures prove that an old writer
cannot read a published v2 snapshot. Its previously prepared v1 PUT loses CAS;
a subsequent GET fails its decoder before another PUT can be prepared.

The v2 binary format uses little-endian integers. After the 8-byte magic and u32
schema version, sections appear in this order:

1. Seen: u32 count, u64 identifiers.
2. History: u32 count, 16-byte operation ID, u64 order, u64 last-view milliseconds,
   u16-length UTF-8 day, u8 inferred flag, then source, ID, and URL strings.
3. History removals: u32 count, 16-byte operation IDs.
4. Favorites: u32 count, 16-byte operation ID, u64 added milliseconds, source,
   ID, and URL strings.
5. Favorite removals: u32 count, 16-byte operation IDs.
6. Exploration: u32 count, source and ID strings, u8 evidence bits.
7. Activity: u32 count, 16-byte operation ID, u8 variant. Discovery (0) contains
   source and ID strings, u8 outcome (1 viewed / 2 rejected), u64 milliseconds,
   and a day string. LegacyImport (1) contains u64 lifetime total and a u32 count
   of day strings with two u64 counts (viewed, rejected).
8. Activity removals: u32 count, 16-byte operation IDs.
9. Theme and page-size registers, each with a u8 presence flag. A present register
   contains u64 logical clock, 16-byte operation ID, then its string/u16 value.
10. Devices: u32 count, 16-byte device ID, metadata register (clock, operation ID,
    display-name/platform strings), u64 joined milliseconds, and an optional
    last-sync register containing a u64 timestamp.

All strings have u16 byte lengths. Collections use canonical key order; malformed
counts, duplicate keys, invalid days/preferences, conflicting operation payloads,
counter overflow, and trailing bytes are rejected before any store is changed.
Activity is summed only after operation-ID deduplication and removals. Exploration
combines evidence by OR and displays Viewed before Rejected before Unknown.

V2 retains all history and removals. Only the upload is bounded by the existing
64 MiB encrypted envelope budget. Exceeding it leaves local state intact and
reports `body_too_large`. No destructive compaction is performed.

## Local migration and recovery

Legacy files remain untouched. Atomic versioned destinations are import receipts:
`history-v3.json`, `favorites-v3.json`, `exploration-v2.json`, `activity-v2.json`.
`state-migration.json` also records completed imports. Activity import IDs and
legacy browser migration/repair flags share the atomic Activity file save.
Identical aggregates from separate installations receive different operation IDs.
V2 never repairs/clamps Activity using an incomplete history projection.

Preferences and preserved device records live in `preferences.json`. There is
no local identity and no roster entry is created by PR 1. Theme localStorage is
an early-render/Privacy cache; Rust registers are authoritative for app preferences.
History frame-day DTOs carry source/ID keys and saved source days, rather than
reconstructing ledger associations from the destination timezone.

A shared persistence lock and `state-transaction.json` journal protect discovery,
accepted frames, remote merges, session-history import, and combined clear.
The journal saves concrete IDs and effects before applying stores. Each effect
is idempotent. Incomplete transactions replay before any coordinated read/write
or snapshot export. JSON writes sync the temporary file and, on Unix, the parent
directory after rename. Seen's append API also syncs its log before success.

`prepare_history_clear` freezes known history/Activity operation IDs in
`history-clear.json`. `commit_history_clear` and `cancel_history_clear` are
idempotent by request ID. Restart commits prepared requests from interrupted Undo
windows. Committed requests never remove later, unknown operations. A legacy
browser clear marker uses one persistent request receipt, so repeated marker
recovery cannot clear newer data. Favorites, Seen, and Exploration survive clear.

Session-history import is one journaled batch and receipt; retry/restart cannot
partially import or resurrect it after clear. Browser Stats and explicit
preferences finish before startup sync. Tauri export commands also reject
`migration_pending` until `complete_state_imports` succeeds, covering manual Sync
setup during startup or after an import failure.

Config retains the highest accepted plaintext schema next to its revision floor.
`sync-schema-floor.json` additionally journals the accepted floor per Sync ID with
the merge itself, so crash or partial pairing failure cannot reopen a downgrade
window. Before each PUT, `sync-publication.json` records its base revision. A lost
response or failed floor save allows retry at that same revision, but requires v2
at later revisions. A known CAS rejection clears the attempt; a successful PUT
durably sets floor 2 before pairing/config saves. This deliberately fails closed
if an unanswered upgrade races with a later v1 write. Recovery/leave never exports
these device-local receipts.

## Verification

```sh
cargo test --manifest-path src-tauri/Cargo.toml --locked
npm test
npm run lint
```

To exercise the three-device test against the unchanged server, start its existing
binary on loopback with a temporary database and run:

```sh
RANDOM_FRAME_SYNC_E2E_URL=http://127.0.0.1:18787 \
  cargo test --manifest-path src-tauri/Cargo.toml --locked \
  unmodified_server_recovers_complete_v2_state_on_a_third_device -- --ignored
```

The default suite keeps this external-server test ignored. Existing secure-storage
and production-server integration tests keep their existing environment requirements.
Downgrading to a v1-only client is unsupported after publishing v2; use a v2-capable
fix for rollback. Exported image files are not included in snapshots.
