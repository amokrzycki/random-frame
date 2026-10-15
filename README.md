# Random Frame

A minimalist gallery of random public images for Windows, Linux and Android, shown one at a time. Built with Tauri 2, a plain HTML/CSS/TypeScript interface, and a Rust backend.

Images come from [prnt.sc](https://prnt.sc/). The Rust backend resolves variable-length lowercase alphanumeric identifiers in Prnt.sc’s legacy base-36 range and fetches the image, since the source blocks cross-origin framing.

## Features

- Draw a random image, revisit frames in History, or explore neighboring Prnt.sc source IDs
- Local browsing history and a Saved library with collections, pagination, jump-to-frame, and retryable Undo
- Clear History & Stats through an untimed review: Undo keeps the data; Finish clearing commits it. Closing or restarting before choosing Finish cancels the review.
- Exploration and daily viewing statistics
- Save images and open or copy source links; copy images to the clipboard on supported desktop platforms
- Enlarged image inspection with actual-size, button and wheel zoom, plus touch pinch and pan
- Light and dark themes
- Custom desktop title bar and window controls; Android Back closes the active surface
- Automatic desktop updates from GitHub Releases; Android updates by installing a newer APK
- Optional Sync of history, saved frames, collections and assignments, Seen IDs, exploration progress, Activity Stats, and preferences between devices, with device approval and a separate administration code

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


Collections use snapshot v3 with the existing encrypted envelope and HTTP API. Before upgrading an existing v1/v2 Sync, the app asks you to update your other devices and explicitly choose Upgrade Sync. Later leaves local edits waiting; no replacement v2 snapshot is uploaded. Older apps stop syncing after the upgrade, but keep their local data. A new Sync requires collection-capable clients from the start. The known-device list does not confirm their app versions or presence.

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
