# Sync v2 persistence and compatibility

PR 1 implements the data and migration layer. Device identity, roster publication,
new Sync status APIs, and the dialog are documented below where they affect joining.

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

Committed `.json.bak` files from interrupted Windows replacements are recoverable
on every platform, including after moving a profile to Linux. A backup migration
receipt also blocks reimport if its committed destination is missing. Corrupt
backups fail closed rather than becoming empty state.

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

## First join: Restore versus Merge

`join_sync(recoveryKey, mode)` takes an explicit `mode` (`"restore"` or `"merge"`; Rust
`JoinMode`). There is no default and no boolean: a missing or unknown mode is rejected
before anything runs. After either join completes, the device is a normal participant
and every later sync is the same CRDT sync. Recovery keys, credentials, the envelope
and the snapshot format are unchanged.

**Restore**: the remote state wins for pre-join domains its schema represents.
Meaningful local state requires an explicit choice; neither radio is preselected.
**Merge**: CRDT union of the remote and the whole local state, previous deletions
included. The 2026-10-05 incident shape (remote 5,752 History; local 3 additions and
1,214 removals matching remote operations) gives 5,752 under Restore and 4,541 under
Merge. Both are covered by `sync/join_mode_tests.rs`.

### Merge

Unchanged: GET, `merge_remote`, stage this device's last sync, `push_with_retries`.
Additions, removals and Activity operations union, preferences resolve by register
stamp, CAS retries merge the newer remote into local, and schema-downgrade checks apply.

### Restore

V2 Restore replaces every synchronized domain (Seen, History and removals, Favorites
and removals, Exploration, Activity and removals, preferences, device roster).
V1 Restore is a schema-aware migration to v2, using `DecodedSnapshot::represents`:

| Domain | V1 capability | Restore source |
| --- | --- | --- |
| Seen | Represented | Remote; never copy the local Seen collection |
| History and History removals | Represented | Remote; discard local additions and tombstones |
| Favorites and Favorite removals | Represented | Remote; discard local additions and tombstones |
| Exploration | Unsupported | Validated, durable local v2 records |
| Activity and Activity removals | Unsupported | Validated, durable local v2 operations and removals |
| Preferences | Unsupported | Local v2 registers, including explicit values and their stamps |
| Device roster and metadata | Unsupported | Register only this device from its identity; discard stale roster records |

The existing persistence invariant still reconciles Seen from retained viewed History
and Exploration evidence. This can derive Seen IDs from preserved Exploration, but
never copies unrelated local Seen additions. It keeps the migration, restart and
third-device results consistent. Reconciliation never creates Activity.

Local Activity keeps operation IDs, LegacyImport IDs, buckets and removals exactly;
it is neither rebuilt from History nor re-imported from browser counters. Empty local
unsupported domains remain empty, without synthetic operations. This is replacement
by domain capability, not CRDT union: all represented local domains are discarded.
Device identity, thumbnails, Sync credentials/config, schema floors and publication
receipts remain device-local and untouched.

Sequence, in `engine::join_inner` and `cas::restore_with_retries`:

1. GET the remote envelope.
2. Authenticate, decrypt, decode, and apply the downgrade rules (`decode_remote`,
   shared with Merge). Any failure returns here with local state unchanged.
3. For an upgrade, capture one validated local snapshot after all imports are durable.
   Build the upload with `restore_target` from the latest remote schema's represented
   domains and only unsupported local content, plus this device's roster record and
   last-sync register. V2 Restore reads no local content.
4. PUT with `If-Match`, using the existing publication/schema-floor receipts.
5. On 412, GET the latest remote and go back to step 2 with the same mode, up to
   the same three attempts. Latest v1 continues the same migration using the captured
   local state. Latest v2 is fully authoritative, including empty Activity, Exploration
   and preferences: preserved local domains are no longer injected. Downgrade checks
   still prohibit a subsequent v1. No retry imports represented local domains. A final
   conflict returns `conflict` with local content unchanged.
6. After the server accepted the PUT, `PersistentState::replace_synchronized` writes
   the uploaded snapshot through the existing `state-transaction.json` journal
   (`replace: true`). Each store step is set-to-target, so a crash replays the journal
   at the next start and finishes the replacement. Half-local, half-remote state is
   never exported (`snapshot()` runs recovery first).
7. Only then are the secret and `sync-config.json` saved, as in Merge. If pairing
   fails, the device holds exactly the uploaded target plus its roster record and no
   credentials; retrying either mode is safe, and no pre-join deletion can leak.

This orders the replacement after the PUT rather than before it: a failed or refused
publication leaves the old local state completely untouched, and the upload is by
construction exactly what local will hold. Changes made on this device while the join
request is in flight count as pre-join state and are replaced; the dialog is modal and
disables the join controls while the operation runs, as for every Sync action.

Device roster: the remote roster is kept as is. This device adds or refreshes only its
own record (identity from `device-identity.json`, never a remote one) with a fresh
last-sync register. Records that merely existed in the local roster from an old
installation are not published under Restore; Merge keeps publishing them as before.

### Nothing pre-join can come back after Restore

- Every store file is rewritten with the target; the Seen append log
  (`prntsc-seen.log`) is deleted, since startup replays it.
- Legacy sources (`activity.json`, `history.json`, `favorites.json`,
  `prntsc-explored.txt`) are only read while their versioned destination is missing.
  All destinations already exist and carry receipts before a join is possible, so a
  restart cannot re-import them.
- The remaining legacy import paths are closed by the replacement itself: Activity's
  `migrated` flag (browser counter migration), the `session-history` receipt (browser
  session import) and the preferences `imported` flag (localStorage preferences).
- Prepared "clear history" requests (`history-clear.json`) hold pre-join operation
  IDs; they are voided so a later commit cannot publish those deletions.
- V2 preferences become remote values, including "unset"; v1 preserves local registers.
- V1 preserves the migrated Activity ledger; restart uses the durable v2 ledger rather
  than legacy files or browser counters. `imports_ready` remains mandatory for summary,
  create, join and startup Sync. Browser History, Activity and preferences import before
  `complete_state_imports()`; failures keep the gate closed.

### Local summary

`get_sync_join_summary` returns aggregate counts only (History, Favorites, previous
deletions across History/Favorites/Activity) and `meaningful`. A device has meaningful
local synchronized state according to `SyncSnapshot::has_meaningful_synchronized_state`:
any Seen, History, History removal, Favorite, Favorite removal, Exploration record,
Activity operation (including LegacyImport), Activity removal, explicit preference
register, or roster record for another device. Only the automatic self roster record
is excluded; explicit default-valued preferences still count. A tombstone-only device
is not empty. No visible History length, installation age or platform decides emptiness.

For meaningful or unknown state, both native radios start unchecked and submit stays
disabled until a deliberate selection. The form handler also rejects an absent mode
and a still-loading summary, so Enter cannot choose a default. A failed join keeps the
selected mode and retries exactly that choice. Success, cancel and dialog reset return
to neutral. Button text never decides the mode. Truly empty state skips the choice and
uses automatic Restore. Fake-DOM tests verify form guards and native accessible markup;
they cannot simulate browser radio arrow keys or implicit Enter submission.

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

Debug builds can opt into numeric snapshot diagnostics with
`RANDOM_FRAME_SYNC_DIAGNOSTICS=1`. Before upload, after remote decode and after
merge report schema, lengths, collection counts, Activity projection and operation
variant counts. Upload/decode lengths are measured; after-merge envelope length
is the planned serialized size plus the fixed 52-byte overhead. No keys, tokens,
identifiers, URLs or plaintext contents are logged; release builds exclude this
instrumentation.

The [October 5 incident investigation](sync-v2-incident-2026-10-05.md) records the
exact History tombstone lineage, intact Activity, payload measurements, migration
backup fix, regression coverage and deployment checks. The real-server tests now
include a 5,752-view legacy import and three distinct pre-join discoveries.
