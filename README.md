# Random Frame

A minimalist desktop gallery for random public images, shown one at a time. Built with Tauri 2, a plain HTML/CSS/TypeScript interface, and a Rust backend.

Images come from [prnt.sc](https://prnt.sc/). The Rust backend resolves each random six-character identifier and fetches the image, since the source blocks cross-origin framing.

## Features

- Draw a random image, or step to the previous or next adjacent Prnt.sc identifier
- Local browsing history with pagination, jump-to-frame, and hold-to-clear
- Exploration and daily viewing statistics
- Save the image, copy it to the clipboard, copy the source link, or open the source page
- Enlarged image view
- Light and dark themes
- Custom title bar and window controls
- Automatic updates from GitHub Releases
- Optional Sync of seen progress between devices, using a recovery key

### Keyboard shortcuts

| Key                 | Action                         |
| ------------------- | ------------------------------ |
| `N`, `Space`, `Enter` | Draw a new random image      |
| `←` / `→`           | Previous / next frame in history |
| `Esc`               | Close dialogs                  |

## Download

Installers for Linux (`.deb`, AppImage) and Windows (NSIS, MSI) are published on the [Releases](https://github.com/amokrzycki/random-frame/releases) page. Installed copies update themselves.

## Development

Requires Node.js (see `.nvmrc`), npm, Rust, and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npx tauri dev
```

`npm run dev` only watches and rebuilds the static frontend; Tauri runs the application.

Sync needs a server endpoint. Set `RANDOM_FRAME_SYNC_BASE_URL` to a validated HTTPS URL for production, or a loopback HTTP URL for local testing, before launching or building the app. Without it, the gallery still works locally and Sync setup reports that the server is not configured. Sync is opt-in; history, favorites, settings and statistics remain local. Save the recovery key when enabling Sync: the app cannot show it again automatically.

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

Random Frame has no accounts, analytics, telemetry, or ads. Settings, history, favorites and statistics stay on your device. Optional Sync sends encrypted seen progress to a Sync server; its operator cannot read the plaintext ID list but can see connection metadata, sync ID, transfer size and timing. The app also connects to prnt.sc for images and GitHub for updates. Files are saved only where you choose.

See the full [privacy policy](privacy.html), which is also available inside the app.

## Content warning

Images come from an external, unmoderated source and may be inappropriate or disturbing. The source may also rate-limit requests.

## Disclaimer

Random Frame is an independent project. It is not affiliated with or endorsed by prnt.sc or Lightshot. All displayed images belong to their respective owners.

## Contact

contact@amokrzycki.ovh

## License

[MIT](LICENSE) © 2026 Adrian Mokrzycki ([amokrzycki](https://github.com/amokrzycki))
