# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Tauri 2 desktop application with a plain HTML, CSS and TypeScript interface and a Rust backend. The backend resolves public Prnt.sc images because the source blocks cross-origin framing.

## Users

People casually exploring surprising public images in a focused, single-item gallery.

## Product Purpose

Random Frame is intended to aggregate random public media from selectable sources while showing one item at a time. Visitors can move back through the current session, draw a new result, and save the displayed image.

## Positioning

Instead of an endless feed, Random Frame offers one deliberate draw at a time across public media archives.

## Operating Context

The gallery is used as a focused desktop utility in a resizable window, primarily with keyboard and mouse. History can Sync across linked devices and can be cleared; known removals propagate through Sync, while new history created offline may appear later. Saved frames, their collection assignments, and Seen IDs can Sync and survive History clearing. Local activity Stats (Frames drawn, Today, streak, and daily results) reset with History. Prnt.sc exploration progress is durable across History clearing and restarts, and Syncs with the rest. The Sync dialog states what Sync covers, that images saved to files are not backed up, when this device last synced, and server-verified membership for managed groups, with separate Administrator and This device labels. Legacy lists only devices known from past syncs; neither list implies online presence. The administrator approves pairing requests, removes other devices with automatic key rotation, and can dissolve the group. A separate administration code recovers the same logical administrator on a new installation, replacing its previous credentials. Moving legacy creates a new group and leaves the old group unchanged.

## Capabilities and Constraints

- The current implementation uses Prnt.sc and its variable-length lowercase alphanumeric identifiers within the known legacy range.
- Imgur is not a planned provider because new developer accounts cannot currently be registered.
- Wikimedia Commons, Internet Archive, and other sources with accessible APIs remain candidates; provider choice, selection rules, attribution, moderation, and mixed-source behavior are open decisions for the next planning phase.
- Prnt.sc blocks cross-origin framing, so the current app resolves and proxies its public image through the server.
- Previous/next navigation and direct image download are required.
- The star and `F` save an unsaved frame immediately without assigning a collection. For a saved frame they open Collections. A frame can belong to zero or many collections; deleting a collection or its last assignment keeps the global save. Global removal and Clear all saved offer Undo and keep history and downloaded files.
- Existing favorites migrate once into a normal collection named Favourite, which can be renamed or deleted. Saved frames retain source links and metadata, not permanent copies of upstream images.
- Nearby availability is separate from viewing. Sync snapshot v4 enforces that distinction. Existing v1–v3 chains, including managed groups, require fresh Upgrade Sync consent before joining or publishing; Later leaves changes waiting. Older apps stop syncing after the upgrade and retain their local data. New chains require Nearby-capable clients. The device list cannot confirm app versions. Legacy migration and collection-format upgrades are separate operations.

## Vocabulary

- **Saved frame:** A frame kept in the Saved library. Saving does not require a collection; a frame can belong to several collections or none.
- **Collection:** A named way to organize saved frames. Removing a frame from a collection does not remove it from the Saved library.
- **Draw / drawn:** the action and the stat. A frame is drawn; Stats count Frames drawn.
- **Seen IDs:** the synced list of IDs of frames you have viewed, kept to skip repeats. Not a stat.
- **IDs checked:** Prnt.sc exploration, including verified available and unavailable IDs; pending and transient failures do not count. Syncs and survives History clearing.
- **Nearby Frames:** a secondary 3×3 gallery of four Prnt.sc IDs before and after a numerical center. Previous/Next 4 overlap by five IDs; Current always identifies the displayed viewer frame. Checking previews changes only IDs checked. Opening a new frame adds History and Seen without adding a Draw.
- **Adjacent ID:** the Prnt.sc ID just before or after the shown one; distinct from the previous/next frame in history.
- Do not call drawn frames "found"; one word per idea.
- The current Prnt.sc mode can inspect the immediately adjacent base-36 identifiers; successful results join local history.
- The upstream service may rate-limit or block repeated requests; errors must be recoverable without losing earlier history.

## Brand Commitments

The working product name is Random Frame. The interface should feel simple, quiet, and lightly premium. Polish must not compete with the displayed media.

## Evidence on Hand

The supplied Chris Hannah implementation establishes the current Prnt.sc identifier format and warns about rate limiting. Imgur was ruled out because new developer accounts cannot currently be registered. No replacement-provider research, logo, proprietary artwork, performance claim, or commercial proof was supplied.

## Product Principles

- The displayed media is always the focal point.
- One clear action advances exploration; history stays effortless.
- History, saved frames and collections, Seen IDs, exploration progress, Activity Stats, theme, and history page size can Sync. Clearing History & Stats removes known history and Activity operations; saved frames, collections, Seen IDs, and exploration progress remain. Unknown offline changes can appear after Sync.
- Every item keeps a clear link to its source.
- Upstream failures are explained plainly and recover gracefully.

## Accessibility & Inclusion

All actions must be keyboard accessible, have visible focus, and expose loading and error state to assistive technology.
