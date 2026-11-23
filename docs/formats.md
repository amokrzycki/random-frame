# On-disk and on-wire formats in 1.0

This is the format policy for the 1.0 release. There is exactly one format per
store. Nothing is converted: a file that is not the current format fails closed
with a recoverable error, and no reader rewrites it.

## Local stores (profile directory)

Each store is a single JSON file with a `version` field. Loading rejects any
other version instead of converting:

| Store | File | Version |
|---|---|---|
| Favorites and collections | `favorites-v4.json` | 4 |
| History | `history-v3.json` | 3 |
| Activity | `activity-v2.json` | 2 |
| Exploration | `exploration-v2.json` | 2 |
| Preferences | `preferences.json` | 2 |

The numeric suffixes in the file names above are part of the file name, not
protocol versions.
Preferences rejects versions above 2 and writes 2; every other store accepts
exactly its own version and nothing else.

Writes are crash-safe: a complete `.tmp` file is promoted over the target and a
damaged file can be recovered from the `.bak` copy (`persistence/io.rs`). The
transaction journal (`state-transaction.json`) replays or discards an interrupted
multi-store change on the next start.

## Sync snapshot

The device-independent snapshot is a binary envelope with an eight-byte header:
`RFSNAP` followed by the format version byte and a reserved zero byte. The
current header is `RFSNAP\x01\x00`. A client that meets a higher version byte
reports the `unsupported_version` Sync error, which the UI shows as a
non-retryable message asking the user to update the app; anything else that is
not the exact current header is rejected as invalid.

## Changing a format

A future format change is a release action, not a runtime path:

1. Add the new layout under a new version marker (store `version`, or a new
   snapshot header byte) and write a golden fixture for it.
2. A superseded version stops being read at the same moment the new one ships. No data is converted on disk or on the wire; a
   user who needs the new format updates the app.
3. A client that receives or reads a version it does not know reports it
   (snapshot: `unsupported_version`; stores: recoverable load error) instead of
   guessing.

## Golden fixtures

The Sync snapshot layout is pinned by `src-tauri/src/snapshot/fixtures/golden.bin`,
decoded byte-for-byte by the snapshot tests. Any field-order or layout change
breaks that test and must ship with a new fixture and a new version marker.
