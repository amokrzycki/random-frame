# Random Frame

A minimalist gallery for viewing random public images, one at a time. Browse local history, visit the source, or download the displayed image.

Images are fetched from [prnt.sc](https://prnt.sc/) by the native Rust backend.

## Getting started

Node.js, npm, Rust, and the [Tauri system dependencies](https://v2.tauri.app/start/prerequisites/) are required.

```bash
npm install
npx tauri dev
```

`npm run dev` only watches and rebuilds the static frontend; Tauri runs the application.

## Commands

- `npm run build` — build the app
- `npm test` — run the tests
- `npm run lint` — check formatting and code quality
- `npm run typecheck` — check TypeScript types

## Content warning

Content comes from an external, unmoderated source and may be inappropriate or disturbing. The source may also rate-limit requests.
