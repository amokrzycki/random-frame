# Random Frame

A minimalist gallery of random public images for Windows, Linux and Android, shown one at a time. Built with Tauri 2, a plain HTML/CSS/TypeScript interface, and a Rust backend.

Images come from [prnt.sc](https://prnt.sc/). The Rust backend resolves variable-length lowercase alphanumeric identifiers in Prnt.sc’s base-36 identifier range and fetches the image, since the source blocks cross-origin framing.

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
- Optional Sync of history, saved frames, collections and assignments, Seen IDs, exploration progress, Activity Stats, and preferences between devices with one 24-word code

### Nearby Frames

Use the Nearby Frames action beside Draw to inspect four source IDs before and after the current image. Previous 4 and Next 4 move in base-36 source order; Current marks the viewer image even after the center moves. The current image appears immediately, and previews fill independently. Retry a failed tile; confirmed unavailable IDs stay distinct from source, decoder and storage errors.

Preview checks update IDs checked only. They do not add History, Seen IDs or Draw activity. Opening a thumbnail uses its full image and adds History/Seen with no Draw. Closing preserves the viewer and its History/Saved navigation. Completed checks survive restart, History clearing and Sync; grid position and thumbnails are not synced.

Sync keeps thumbnail availability separate from viewed frames. 

### Saved collections

Click the star or press `F` to keep a frame in All saved. For an already saved frame, the same action opens Collections. Select any number of collections, or leave all unchecked to keep it without a collection. New names stay in the form until Apply; Cancel creates nothing. The whole form commits together, and a failed Apply keeps the choices available for retry.

History → Saved lets you browse All saved, an individual collection, or Without a collection when that filter has images. Create, rename and delete collections there. Deleting a collection keeps its images saved. In a collection, open a tile’s Collections form to move the image: choose a destination, then Apply. Its other collections stay selected. Remove from all saved removes the global save and its assignments, with Undo; it leaves history and downloaded files alone. Clear all saved is available only in All saved and keeps empty collections.

Saved frames retain links and metadata rather than permanent copies of the source images; an upstream image can disappear.

## Keyboard shortcuts

Outside dialogs and menus, use these shortcuts. Toolbar arrows move within the focused toolbar; menu arrows move between its choices. `?` also closes its own shortcut sheet.

| Key | Action |
| --- | --- |
| `N` | Draw a new random image |
| `Space`, `Enter` | Draw when no control has focus |
| `←` / `→` | Previous / next frame in the active History or Saved view, including a selected collection |
| `S` | Save the current image to a file |
| `C` | Copy the current image on supported platforms |
| `F` | Save frame to the library or open Collections |
| `H` | Open History |
| `T` | Open Stats |
| `?` | Toggle Keyboard shortcuts |
| `Esc` | Close a dialog or cancel a draw |

Open the image to inspect it in the enlarged view, which follows the same active History or Saved list. There, `←` / `→` step frames, `S` saves an image file, and `F` saves the frame or opens Collections. Use the zoom buttons, actual-size control, or `Ctrl` + scroll to zoom; `Shift` + arrows pans a zoomed image. On touch screens, pinch to zoom and drag to pan.

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

Sync needs a server endpoint. Set `RANDOM_FRAME_SYNC_BASE_URL` to a validated HTTPS URL for production, or a loopback HTTP URL for local testing, before launching or building the app. Without it, the gallery still works locally and Sync setup reports that the server is not configured. Sync is opt-in. Seen IDs, history, saved frames, collections and assignments, exploration progress, Activity Stats, theme, and history page size are sent only as an encrypted snapshot.

Start a new Sync on the device that should become the administrator. It shows one code of 24 words. On every other device choose Join a Sync and enter that code; there is nothing to approve. The same code works for any number of devices until the administrator removes a device or chooses New code. Choose Restore to adopt the data already in Sync, or Merge to keep this device's changes and previous deletions; an empty device uses Restore. The administrator can show the code again, replace it, remove devices, or end the Sync for everyone. Removing a device changes the group key, so the old code stops working and a new one is created; the remaining devices pick up the new key on their own, even after several offline changes. Any other device can leave. The administrator cannot leave, only end the Sync. If the administrator's device is lost, the remaining devices start a new Sync and Merge. Local copies and saved image files remain on removed devices; downloaded data cannot be erased remotely. The device list comes from the server and marks the Administrator and This device; Last synced does not mean online.

With Sync connected, the app tries to upload changes shortly after you make them. It also tries to sync at startup and when you choose Sync now. Returning to the app tries to sync waiting changes immediately; when nothing is waiting, return checks run at most once every 15 minutes. When you close or leave, the app briefly tries to finish waiting changes. Anything unfinished stays queued for a later attempt.

The code is a 32-byte seed shown as 24 BIP-39 English words. HKDF-SHA256 derives from it an invitation ID, a secret and an X25519 key pair. The administrator seals the group key to that public key and registers the ID, a hash of the secret and the sealed key with the server, which never learns the seed. A joining device looks the code up with the secret, opens the group key, creates its own device keys, seals the group key to itself and joins. Group key, epoch and key ID are bound by HPKE and the snapshot envelope; HTTPS and the authenticated group endpoints establish server authority. Journal replay verifies the exact request, and a join whose response was lost is confirmed through the server's operation record. The wire contract is the server repository's README.

Every publication preserves the whole library, including empty user collections, name registers, memberships, and tombstones. Restore makes every remote domain authoritative; the snapshot distinguishes available IDs from viewed IDs. A transaction receipt prevents replay of an already applied Restore from erasing subsequent local edits.

The client keeps its Sync credentials in one OS keyring entry (the Android Keystore adapter and backup exclusions on Android). `sync-journal.json` contains only operation metadata and hashes; the exact encrypted request is journaled before HTTP and survives a lost response or restart. Images saved to files are not backed up.

HPKE is pinned to [`hpke` 0.13.0](https://github.com/rozbb/rust-hpke): its RFC 9180 X25519/HKDF-SHA256/ChaCha20Poly1305 implementation and standard DeriveKeyPair supply the missing primitive. It uses the same RustCrypto AEAD/HKDF/zeroization families as the rest of the client and no native cryptography dependency; tests cover Appendix A.2 and the selected suite's official vectors. `rand` 0.9 is used only for HPKE's rand_core 0.9 API. The 24-word encoding uses the [`bip39`](https://crates.io/crates/bip39) crate and is tested against the official Trezor 256-bit vectors.

A stale whole-server SQLite restore can reactivate removed devices and old codes. There is no automatic detection; the server operator must block public Sync outside SQLite before a restore and verify a current, complete, consistent state before unblocking it. See the server's `deploy/README.md`.

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

CI also runs the local real-server Sync tests against `random-frame-server` commit
`4accca2ce8dd18b97bf072e03d42118261e57f9e`. The server repository is private, so set
the app repository's `SYNC_SERVER_READ_TOKEN` secret to a token with read-only
Contents access to `amokrzycki/random-frame-server`. This job runs on main pushes
and same-repository pull requests; fork pull requests do not receive the credential.
To run the same tests locally after building that server:

```bash
RF_SYNC_SERVER_BIN=/absolute/path/to/random-frame-sync-server cargo test --locked --manifest-path src-tauri/Cargo.toml ::real_server_ -- --ignored
```

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
