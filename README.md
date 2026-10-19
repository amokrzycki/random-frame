# Random Frame

A minimalist gallery of random public images for Windows, Linux and Android, shown one at a time. Built with Tauri 2, a plain HTML/CSS/TypeScript interface, and a Rust backend.

Images come from [prnt.sc](https://prnt.sc/). The Rust backend resolves variable-length lowercase alphanumeric identifiers in Prnt.sc’s legacy base-36 range and fetches the image, since the source blocks cross-origin framing.

## Features

- Draw a random image, revisit frames in History, or inspect nearby Prnt.sc source IDs in a progressive 3×3 gallery
- Local browsing history and a Saved library with collections, pagination, jump-to-frame, and retryable Undo
- Clear History & Stats through an untimed review: Undo keeps the data; Finish clearing commits it. Closing or restarting before choosing Finish cancels the review.
- Exploration and daily viewing statistics
- Save images and open or copy source links; copy images to the clipboard on supported desktop platforms
- Enlarged image inspection with actual-size, button and wheel zoom, plus touch pinch and pan
- Light and dark themes
- Custom desktop title bar and window controls; Android Back closes the active surface
- Automatic desktop updates from GitHub Releases; Android updates by installing a newer APK
- Optional Sync of history, saved frames, collections and assignments, Seen IDs, exploration progress, Activity Stats, and preferences between devices, with device approval and a separate administration code

### Nearby Frames

Open the frame-ID menu and choose Nearby Frames to inspect four source IDs before and after the current image. Previous 4 and Next 4 move in base-36 source order; Current marks the viewer image even after the center moves. The current image appears immediately, and previews fill independently. Retry a failed tile; confirmed unavailable IDs stay distinct from source, decoder and storage errors.

Preview checks update IDs checked only. They do not add History, Seen IDs or Draw activity. Opening a thumbnail uses its full image and adds History/Seen with no Draw. Closing preserves the viewer and its History/Saved navigation. Completed checks survive restart, History clearing and Sync; grid position and thumbnails are not synced.

Nearby needs Sync snapshot v4 so older apps cannot mistake thumbnail availability for a viewed frame. Update the other devices before choosing Upgrade Sync. Previous collections consent does not approve v4; Later leaves local changes waiting without uploading. Older apps stop syncing and retain their local data. After publication, use a v4-capable fix rather than downgrading Sync or opening the same local data directory with an older binary.

### Saved collections

Click the star or press `F` to keep a frame in All saved. For an already saved frame, the same action opens Collections. Select any number of collections, or leave all unchecked to keep it without a collection. New names stay in the form until Apply; Cancel creates nothing. The whole form commits together, and a failed Apply keeps the choices available for retry.

History → Saved lets you browse All saved, an individual collection, or Without a collection when that filter has images. Create, rename and delete collections there. Deleting a collection keeps its images saved. In a collection, open a tile’s Collections form to move the image: choose a destination, then Apply. Its other collections stay selected. Remove from all saved removes the global save and its assignments, with Undo; it leaves history and downloaded files alone. Clear all saved is available only in All saved and keeps empty collections.

Existing favorites migrate once to a normal collection named **Ulubione**. You may rename or delete it. Saved frames retain links and metadata rather than permanent copies of the source images; an upstream image can disappear.

## Keyboard shortcuts

| Key                 | Action                           |
| ------------------- | -------------------------------- |
| `N`, `Space`, `Enter` | Draw a new random image        |
| `←` / `→`           | Previous / next frame in history |
| `S`                 | Save the current image           |
| `C`                 | Copy the current image           |
| `F`                 | Save frame or open collections         |
| `H`                 | Open History                     |
| `?`                 | Toggle Keyboard shortcuts        |
| `Esc`               | Close dialogs                    |

## Download

Installers for Linux (`.deb`, AppImage) and Windows (NSIS, MSI) are published on the [Releases](https://github.com/amokrzycki/random-frame/releases) page. Installed copies update themselves.

The same release has an Android APK for 64-bit ARM phones (Android 7.0 or newer), `Random-Frame-v<version>-android-arm64.apk`, with its SHA-256 checksum next to it. Allow your browser or file manager to install apps, then open the APK. The Android app does not update itself: install a newer APK over the old one, without uninstalling first. Your history stays on the phone, but it is left out of Android backups, so uninstalling deletes it. Turn on Sync to keep it across devices.

## Development

Requires Node.js (see `.nvmrc`), npm, Rust, and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npx tauri dev
```

`npm run dev` only watches and rebuilds the static frontend; Tauri runs the application.

Sync needs a server endpoint. Set `RANDOM_FRAME_SYNC_BASE_URL` to a validated HTTPS URL for production, or a loopback HTTP URL for local testing, before launching or building the app. Without it, the gallery still works locally and Sync setup reports that the server is not configured. Sync is opt-in. Seen IDs, history, saved frames, collections and assignments, exploration progress, Activity Stats, theme, and history page size are sent only as an encrypted snapshot. Start a new Sync on the device that should become HEAD. Save its separate administration code: it can recover that same logical HEAD on a new installation, replacing the former installation’s access. To connect another device, generate a pairing request there, approve it on HEAD, then redeem the one-use invitation on the requesting device. The invitation lasts 24 hours, or until the group’s key changes; it contains neither the root nor the administration code. Choose Restore to adopt remote data, or Merge to preserve local changes and previous deletions. An empty device uses Restore. HEAD can remove other devices (remaining devices automatically update keys, including after several offline epochs) or dissolve the whole group. Local copies and saved image files remain on removed devices; downloaded knowledge cannot be erased remotely. HEAD cannot disconnect without recovery on another installation or dissolve. The server-verified membership list has separate HEAD and This device badges; Last synced does not mean online.

Existing keys remain on the legacy protocol, without a historical HEAD claim or administration actions. “Move to managed Sync” creates a separate group from the current legacy/local merge, preserving data, operation IDs and deletions. This device becomes its founder; other devices must join again. The old group remains unchanged and may remain accessible. Closing that old ID is a separate one-time operator action with confirmed agreement; creating v2 is not a global cutover. Old servers require an update for managed groups; the client never falls back to legacy credentials.

Membership protocol v2, its authenticated server control, envelope v2, and collection snapshot v4 are independent formats. The server's `snapshotSchemaFloor = 2` is the minimum supported plaintext format, not the format of its opaque current blob; it remains unchanged. There is no separate control signature in this protocol: HTTPS and the authenticated membership endpoint establish server authority, while HPKE and AEAD bind group, epoch and key ID. Clients enforce the maximum of that minimum, their accepted schema, config, and pending publication floor. The journal records the actual prepared schema; replay verifies it against the exact decrypted request and retains the expected revision before HTTP and the accepted revision after success.

All managed publications preserve the whole library, including empty user collections, name registers, memberships, and tombstones. Existing managed v2 groups pause before merge, destructive Restore, rotation, recovery, or a v3 upload until Upgrade Sync is approved for the stable group ID. Invitations and administration codes identify that same group for consent; rotating its data key does not reset approval. Remote v3 needs no repeat approval. Moving legacy checks the old chain's upgrade consent independently before creating a new managed group. Restore keeps only domains absent from an older schema; a CAS retry that observes v3 stops preserving local collections. A transaction receipt prevents replay of an already applied managed Restore from erasing subsequent local edits.

The client stores v2 credentials and pending secrets in a separate OS keyring entry (the existing Keystore adapter and backup exclusions on Android). `sync-admin.json` contains only operation metadata and hashes; the exact encrypted request is journaled before HTTP and survives a lost response/restart. Administration recovery first prepares the new code, then requires confirmation that it was saved before committing. The old code becomes invalid only after successful commit. Images saved to files are not backed up.

HPKE is pinned to [`hpke` 0.13.0](https://github.com/rozbb/rust-hpke): its RFC 9180 X25519/HKDF-SHA256/ChaCha20Poly1305 implementation and standard DeriveKeyPair supply the missing primitive. It uses the same RustCrypto AEAD/HKDF/zeroization families as the existing client and no native cryptography dependency; tests cover Appendix A.2 and the selected suite’s official vectors. `rand` 0.9 is used only for HPKE’s rand_core 0.9 API. Legacy derivation and envelope fixtures remain frozen.

A stale whole-server SQLite restore can reactivate removed credentials and used administration codes. There is no automatic detection in this release. The server operator must block public v2 outside SQLite before restore and verify a current, complete, consistent security state before unblocking it; restoring an old backup alone is insufficient. See the server’s `deploy/README.md`.

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `npm run build`     | Typecheck and build the frontend      |
| `npx tauri build`   | Build the desktop app and installers  |
| `npx tauri android build --debug --target aarch64 --apk` | Build an Android APK (see [Tauri Android setup](https://v2.tauri.app/start/prerequisites/#android)) |
| `npm test`          | Run the frontend tests                |
| `npm run lint`      | Check formatting and code quality     |
| `npm run typecheck` | Check TypeScript types                |

Rust checks:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```


Collections use snapshot v4 with the existing encrypted envelope and HTTP API. Before upgrading an existing v1/v2 Sync, the app asks you to update your other devices and explicitly choose Upgrade Sync. Later leaves local edits waiting; no replacement v2 snapshot is uploaded. Older apps stop syncing after the upgrade, but keep their local data. A new Sync requires collection-capable clients from the start. The known-device list does not confirm their app versions or presence.

## Privacy

Random Frame has no accounts, analytics, telemetry, or ads. Settings and statistics are stored on your device. Optional Sync sends an encrypted snapshot of Seen IDs, history, saved frames, collections and assignments, exploration progress, Activity Stats, and preferences to a Sync server; its operator cannot read the plaintext contents but can see connection metadata, group/member IDs, public keys and membership state, transfer size and timing. The app also connects to prnt.sc for images and GitHub for updates. Files are saved only where you choose.

See the full [privacy policy](privacy.html), which is also available inside the app.

## Content warning

Images come from an external, unmoderated source and may be inappropriate or disturbing. The source may also rate-limit requests.

## Disclaimer

Random Frame is an independent project. It is not affiliated with or endorsed by prnt.sc or Lightshot. All displayed images belong to their respective owners.

## Contact

contact@amokrzycki.ovh

## License

[MIT](LICENSE) © 2026 Adrian Mokrzycki ([amokrzycki](https://github.com/amokrzycki))
