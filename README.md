# Random Frame

A minimalist desktop gallery for random public images, shown one at a time. Built with Tauri 2, a plain HTML/CSS/TypeScript interface, and a Rust backend.

Images come from [prnt.sc](https://prnt.sc/). The Rust backend resolves each random six-character identifier and fetches the image, since the source blocks cross-origin framing.

## Features

- Draw a random image, or step to the previous or next adjacent Prnt.sc identifier
- Local browsing history with pagination, jump-to-frame, and two-step clear
- Exploration and daily viewing statistics
- Save the image, copy it to the clipboard, copy the source link, or open the source page
- Enlarged image view
- Light and dark themes
- Custom title bar and window controls
- Automatic updates from GitHub Releases
- Optional Sync of history, favorites, Seen IDs, exploration progress, Activity Stats, and preferences between devices, using a recovery key

### Keyboard shortcuts

| Key                 | Action                           |
| ------------------- | -------------------------------- |
| `N`, `Space`, `Enter` | Draw a new random image        |
| `←` / `→`           | Previous / next frame in history |
| `S`                 | Save the current image           |
| `C`                 | Copy the current image           |
| `F`                 | Add or remove a favorite         |
| `H`                 | Open History                     |
| `?`                 | Toggle Keyboard shortcuts        |
| `Esc`               | Close dialogs                    |

## Download

Installers for Linux (`.deb`, AppImage) and Windows (NSIS, MSI) are published on the [Releases](https://github.com/amokrzycki/random-frame/releases) page. Installed copies update themselves.

## Development

Requires Node.js (see `.nvmrc`), npm, Rust, and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npx tauri dev
```

`npm run dev` only watches and rebuilds the static frontend; Tauri runs the application.

Sync needs a server endpoint. Set `RANDOM_FRAME_SYNC_BASE_URL` to a validated HTTPS URL for production, or a loopback HTTP URL for local testing, before launching or building the app. Without it, the gallery still works locally and Sync setup reports that the server is not configured. Sync is opt-in. Seen IDs, history, favorites, exploration progress, Activity Stats, theme, and history page size are sent only as an encrypted snapshot. Start a new Sync on your first device and save its recovery key; use Connect this device with that key on another device and choose how it joins: Restore replaces this device's synced data with the copy in Sync and publishes nothing from before, while Merge combines both, including previous deletions on this device. The key can be shown again from the Sync dialog. The dialog shows the status, when this device last synced, and the devices known from past syncs (not whether they are online). Images saved to files are not backed up.

| Command             | Description                           |
| ------------------- | ------------------------------------- |
| `npm run build`     | Typecheck and build the frontend      |
| `npx tauri build`   | Build the desktop app and installers  |
| `npm test`          | Run the frontend tests                |
| `npm run lint`      | Check formatting and code quality     |
| `npm run typecheck` | Check TypeScript types                |

Rust checks:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Privacy

Random Frame has no accounts, analytics, telemetry, or ads. Settings and statistics are stored on your device. Optional Sync sends an encrypted snapshot of Seen IDs, history, favorites, exploration progress, Activity Stats, and preferences to a Sync server; its operator cannot read the plaintext contents but can see connection metadata, sync ID, transfer size and timing. The app also connects to prnt.sc for images and GitHub for updates. Files are saved only where you choose.

See the full [privacy policy](privacy.html), which is also available inside the app.

## Content warning

Images come from an external, unmoderated source and may be inappropriate or disturbing. The source may also rate-limit requests.

## Disclaimer

Random Frame is an independent project. It is not affiliated with or endorsed by prnt.sc or Lightshot. All displayed images belong to their respective owners.

## Contact

contact@amokrzycki.ovh

## License

[MIT](LICENSE) © 2026 Adrian Mokrzycki ([amokrzycki](https://github.com/amokrzycki))

Sync v2's binary format, local migration, clear/replay rules, and compatibility checks are documented in [docs/sync-v2.md](docs/sync-v2.md).
