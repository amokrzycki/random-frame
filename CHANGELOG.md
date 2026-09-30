# Random Frame release notes

## 0.6.0

### Sync between devices

- Added optional Sync on Linux and Windows for history, favorites, and Seen IDs, the list of viewed frames used to skip repeats. No account is required.
- Turn on Sync to create a recovery key, or enter an existing key to link another device. The app shows a new key once and requires confirmation that you saved it before closing the setup dialog.
- Linked devices sync when the app starts and when you choose Sync now. Local browsing still works offline. Settings, activity statistics, Prnt.sc exploration results, and thumbnail files stay on the device.
- Sync merges additions and removals from linked devices. Clearing history or favorites removes the entries known to that device when the others next sync; entries added on an offline device may appear later.
- Added status messages for pending changes, the last successful sync, and connection or setup errors. The More button and Sync menu entry show an indicator when Sync needs attention. Recoverable errors have a retry action.
- Leave Sync disconnects the current device and removes its stored pairing credentials. Local history, favorites, and Seen IDs remain, as does the encrypted data on the server. Rejoining requires the recovery key.
- Snapshots are encrypted and authenticated on the device with XChaCha20-Poly1305. The root secret is stored in the system credential store, with separate encryption and authentication keys derived using HKDF-SHA256.
- Added validation of recovery keys, snapshots, server responses, and revision numbers. Concurrent uploads retry after merging the latest data. A server revision older than one already accepted by the device is rejected.

### History and favorites

- History now shows the newest frames first. Favorites show the most recently starred frames first. Frame numbers and page ranges follow that order.
- Remove a single frame from its history tile, with Delete on a focused tile, or with Remove this frame in the frame ID menu. Undo restores its original position. Removing a frame leaves favorites, Seen IDs, and activity statistics unchanged.
- Replaced hold-to-clear with a two-step confirmation for clearing history or favorites. The confirmation shows how many entries will be removed and explains which data is kept. A double-click cannot confirm the action immediately.
- Added Undo for clearing history, clearing favorites, and removing a favorite. Z or Ctrl+Z restores the last favorite removed from the main viewer.
- Clearing history resets Frames drawn, Today, the activity streak, and daily activity results. Favorites, their cached thumbnails, Seen IDs, and local Prnt.sc exploration progress survive the clear and subsequent restarts.
- Drawing pauses while Undo is available after clearing history. A pending clear is completed on the next launch if the app closes before it finishes; a failed clear restores the previous view.
- Missing thumbnails are fetched as tiles approach the visible part of the history grid, with up to three requests at once. Loading tiles show a placeholder, and unavailable previews use a striped fallback. Fetching a thumbnail does not record a view or change statistics.
- Favorite thumbnails are kept outside the cache's 300-preview budget for other frames. If local storage fills up, ordinary thumbnails are discarded first. The app reports when previews cannot be saved.
- The history dialog keeps a stable height across its tabs and empty states. Opening it focuses the current frame, and arrow keys move between tiles. Pagination remains available for larger collections, with the existing 10, 25, 50, and 100 entries per page.
- Added a one-time tip about the F shortcut after the first draw, skipped if favorites already exist.

### Enlarged image view

- Added previous and next history navigation inside the enlarged view, using buttons or the left and right arrow keys. The caption shows the frame ID and its position in history.
- Added Save and Favorite controls, including the S and F shortcuts, without closing the enlarged view.
- Added a 1:1/Fit control and click-to-zoom. Ctrl+scroll or a trackpad pinch adjusts zoom up to 16 times the fitted size while keeping the image point under the cursor in place.
- Pan a zoomed image by dragging, scrolling, or pressing Shift+arrow keys. Changing frames resets zoom to fit.
- Clicking the image now changes zoom. The close button, Escape, and a click on the dialog backdrop close the view.
- The Saved image notification now includes Show in folder to reveal the downloaded file.

### Interface and accessibility

- Moved History and Stats into the title bar. The More menu contains Sync, History, Keyboard shortcuts, What's new, Theme, and the privacy policy link.
- Consolidated frame actions in the frame ID menu: jump to a history position, inspect adjacent Prnt.sc IDs, open or copy the source link, copy or save the image, and remove the frame. The main info line keeps the ID, frame count, Favorite, and Draw visible.
- Added a System theme option alongside Light and Dark. System follows operating-system theme changes while the app is open; explicit theme choices remain saved locally.
- Reworked spacing, dialog headings, control shapes, borders, shadows, and the dark palette. Bundled Noto Sans regular and bold fonts for consistent interface text, and replaced the app logo, favicon, and desktop icons with the new R mark.
- Replaced native title tooltips with shared tooltips that appear on hover and keyboard focus, stay above dialogs and menus, and can be dismissed with Escape. The privacy page uses them too.
- Added arrow-key, Home, and End navigation to menus and toolbars. Toolbar navigation no longer also moves through history. Successful jumps close the frame menu; invalid input keeps it open for correction.
- Dialogs contain keyboard focus and restore it when closed. Background tools and update controls are inactive while a dialog is open, while window dragging and window controls remain available.
- Improved text, control, and disabled-state contrast. Added selected-state styling for forced-color modes and updated reduced-motion behavior for the revised controls and loading indicators.
- Updated the empty state, shortcut descriptions, and privacy page layout. The main action is now labeled Draw, and Next is hidden when the newest history frame is shown.

### Drawing and statistics

- Escape can cancel a pending random draw and restore the previous view before the frame is committed to history. Late results from a canceled draw are ignored.
- Loading indicators and dimming wait 200 ms before appearing. Once visible, the loader stays for at least 500 ms to avoid flashing. Restoring a history frame has its own loading message, and the stage spinner now uses a script-driven animation.
- Rate-limit and access-block errors explain the pause while preserving access to earlier frames. Draw shows the cooldown countdown, and Try again returns after the wait ends.
- Random draws now skip both locally explored IDs and synced Seen IDs, including IDs learned during an in-flight request. Exhausting a set of known candidates triggers another attempt or a No new frame message instead of returning a known frame.
- Successful fetches count as viewed only after the frame is accepted into history. Legacy history imports do not count views again, and synced history does not add remote activity to local statistics.
- Stats now distinguish Frames drawn and Activity streak from Prnt.sc IDs checked. The exploration breakdown shows opened, unavailable, and unclassified legacy IDs; the percentage of the known ID space was removed.
- Daily result thumbnails use local viewing times rather than timestamps imported through Sync. Removed the substitute activity bars for days without cached thumbnails.
- Exploration totals and categories are read together. An inconsistent breakdown shows an explanation without hiding the other activity statistics.
- Startup failures now explain that saved history could not be loaded and offer Try again. Initialization rejects duplicate loads and starts automatic Sync only once.

### Release notes

- Added the What's new dialog, using release notes bundled from this changelog for the installed version.
- After a successful in-app update and restart, the app shows that version's notes once, waiting for any existing dialog to close. Notes remain accessible through More > What's new.
- Markdown renders with raw HTML disabled. Web and email links open through the external handler. Missing notes or unavailable local storage do not block startup or a successful update.

### Storage, build, and documentation

- Split Rust persistence into history, favorites, activity, exploration, Seen IDs, and shared I/O modules. Split Sync into transport, cryptography, snapshot parsing, reconciliation, state, and conflict handling.
- Added versioned history and favorite storage with operation IDs and removal records for merging devices. Existing local data migrates automatically, and startup rebuilds Seen IDs from history and previously recorded viewed IDs.
- Added backup recovery for JSON replacement on Windows. Failed replacement restores the previous file instead of deleting it before the new file is installed.
- Local exploration loading now rejects out-of-range IDs, unknown classification markers, and conflicting duplicate records instead of silently accepting them.
- Added a 64 MiB encrypted-transfer limit and bounded snapshot sections. History operations and removal records are capped at 100,000; favorite sections are also bounded. A device offline across more retained removals than the cap can reintroduce old entries.
- Sync requires RANDOM_FRAME_SYNC_BASE_URL at runtime or build time. Production endpoints must use HTTPS; HTTP is allowed for loopback development. Redirects are disabled. The release workflow now passes the configured endpoint from its secret; without an endpoint, the gallery works locally and Sync reports that no server is configured.
- Added Rust cryptography and platform credential-store dependencies, plus markdown-it for release notes. The frontend build now imports Markdown as text and includes the shared tooltip entry point; the test build supports bundled Markdown imports.
- Updated package, Cargo, and AppImage version metadata to 0.6.0. Updated the README, product behavior, design documentation, keyboard shortcut list, and privacy policy for Sync and the revised interface.
- Expanded frontend and Rust regression coverage for Sync, snapshot validation and encryption, storage migration and recovery, history removal and Undo, thumbnail loading and retention, startup retries, focus handling, statistics, and release notes.
