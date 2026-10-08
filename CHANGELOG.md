# Random Frame release notes

## 0.7.0

### Random Frame on Android

- Random Frame now runs on Android phones with a 64-bit ARM processor (Android 7.0 or newer). Download the APK from the release page, allow your browser or file manager to install apps, then open the file.
- The Android app doesn’t update itself. Install a newer APK over the old one; you don’t need to uninstall first.
- Your history stays on the phone, but it’s left out of Android backups, so uninstalling deletes it. Turn on Sync to keep it across devices.
- Android Back closes an open menu or dialog first, then cancels a pending draw, and only then leaves the app.
- Saving an image on Android confirms the save without a Show in folder button, because the file picker doesn’t give a folder to open.
- The layout is polished for phone-sized and touch screens. Tooltips no longer pop up when you tap.

### A Sync dialog that shows where things stand

- The status line says what’s happening in plain words: Sync is off, Sync completed, Sync couldn’t connect, or Sync needs attention. Errors say whether anything was changed.
- The dialog shows when this device last synced and lists what Sync covers.
- The Devices list shows devices from past syncs, with their names and when each one joined and last synced. It doesn’t show which devices are online.
- Name this device from the Sync dialog.
- Show the recovery key again whenever you need it. Before, it could only be shown once.
- Leave Sync is now Disconnect this device. Your data on this device and on the server stays as it is.

### Choose how a device joins

- When you connect with a recovery key, pick Restore or Merge. Restore replaces this device’s synced data with the copy in Sync. Merge combines both, including previous deletions on this device, which may remove items your other devices still have.
- If this device already has data, you choose the mode yourself. A device with no saved data takes the copy in Sync automatically.

### More is synced now

- Sync now includes Activity Stats, IDs checked, your theme, and your history page size, along with history, favorites, and Seen IDs. Stats and IDs checked used to stay on each device.
- When you clear history, linked devices remove it, and their stats, the next time they sync. Favorites and Seen IDs stay. Changes made while a device was offline may appear later.
- On Android, Sync also runs when you return to the app, if the last sync was at least 15 minutes ago.
- The privacy policy covers Android and the newer Sync data, including the device list.

### Small fixes

- A history clear is saved before Undo is offered, so a clear interrupted by a restart finishes on the next launch.

## 0.6.6

### A new loading screen

- The spinning ring is now a camera viewfinder that pulls into focus while a frame loads. The previous image stays on stage, slightly dimmed and blurred, and the new one sharpens into place when it arrives.
- The Draw button no longer swaps its label for a spinner. The label stays readable and dims a little while a draw is in progress.
- Each draw shows a short caption, such as "Restoring frame 12…" when you go back through history. Captions are mostly plain or archive-themed, with the occasional joke. A caption doesn't repeat within a session, and a draw that takes more than a few seconds switches to a second caption once.
- Quick draws skip the loading screen, so nothing flashes. When the frame ID changes, its button now resizes smoothly.
- With reduced motion turned on, the viewfinder stays still and the captions fade in. The animation pauses while the window is hidden.

## 0.6.5

### Thumbnail storage

- Thumbnails are now saved as local files instead of browser storage. Existing thumbnails are moved automatically, and thumbnails for favorites are kept when older history thumbnails are removed.

## 0.6.4

### History and favorites

- History and Favorites now show the date and time of each entry. The date is shown in your local time zone, and the time is shown in 24-hour format.
- When you leave history or favorites, the app remember your tab selection and scroll position. You can also use the keyboard to move between tabs and through the list.
- When you click on a favorite, the app switches from the general history to the favorites so you can switch between them more easily; tapping the “draw” button switches you back to the general history.

## 0.6.3

### Toasts and other feedback

- Toast are fixed now, they stop appearing below the controls.

## 0.6.2

### A simpler way to get around

- History and Save are easier to reach. The More menu now includes Stats, and the keyboard shortcuts are grouped by what you’re doing.
- Move through history with the arrow keys, jump to a history page, and use the keyboard to browse or remove frames. Clear history and favorites from below the list.
- Choose System, Light, or Dark theme on the privacy page too.

### Clearer feedback

- Drawing says what it’s doing, and the Draw button stays unavailable if your history can’t load. Try again from the error message when you’re ready.
- Save, update, and other messages have a clearer place on screen. Update errors explain whether the download failed or the app needs to be restarted.
- Stats now show streaks in days and label frames as drawn. The daily list is called “Days you drew.”

### Small fixes

- Favorites and history have clearer labels, and removing a frame can be undone with Z or Ctrl+Z.
- The enlarged view opens with its Close button ready, and the window controls work with the keyboard.
- Selecting an email address on the privacy page opens your email app. If that doesn’t work, the page shows the address to use.

## 0.6.1

### Smoother interactions

- Refined loading transitions to reduce flicker and keep the Draw button and stage in sync.
- Added subtle transitions to menus, Sync panels, empty and error states, and press feedback for controls.
- Adjusted these effects for reduced motion settings.

## 0.6.0

### Your collection across devices

- Use More > Sync to share your history and favorites between devices without creating an account. Random Frame also remembers which images you have already seen, so they can be skipped in future draws.
- Save the recovery key shown during setup. You need it to connect another device or rejoin later, and the app cannot show it again.
- Sync runs when you open the app or choose Sync now. Your collection is encrypted before it leaves your device. Settings and statistics stay local.
- Removing history or favorites also removes those entries from linked devices when they next sync. New entries added while another device was offline may appear later.
- Check when you last synced and whether changes are waiting. The More button shows a warning when Sync needs attention. You can disconnect a device while keeping its local collection.

### More control over history and favorites

- History shows the newest images first, and Favorites shows the most recently starred first.
- Remove individual images from history and bring them back with Undo. You can remove an image from its preview, press Delete on a selected preview, or choose Remove this frame from the frame ID menu.
- Clearing history or favorites now asks you to confirm with a second click. Undo lets you reverse the clear, or restore a favorite you just removed. Z or Ctrl+Z also restores the last favorite removed from the main view.
- Clearing history resets your activity statistics but keeps favorites and the record of images already checked. Drawing pauses briefly while Undo is available.
- Missing previews load as you browse history. Favorite previews are kept when you clear history and take priority when storage space runs low.

### A closer look at images

- Move between images, save them, and add them to Favorites without leaving the enlarged view. Left and right arrows browse history; S saves and F toggles a favorite.
- Click an image to zoom, or use Ctrl+scroll or a trackpad pinch. Choose Fit to return to the full image. Drag to move around a zoomed image, or use Shift+arrow keys.
- After saving an image, choose Show in folder to find the downloaded file.

### Easier to navigate

- History and Stats are now in the top bar. More brings together Sync, keyboard shortcuts, release notes, theme choices, and the privacy policy.
- Click the frame ID to copy or save the image, open its source, jump to a place in history, explore nearby Prnt.sc images, or remove the current frame.
- Choose System to have the app follow your computer's light or dark theme automatically.
- Updated the app icon, fonts, colors, and layout. Text and controls have clearer contrast, and button hints appear on hover or keyboard focus.
- Improved keyboard navigation in menus, history, and dialogs, along with support for reduced motion and high contrast settings.

### Drawing and statistics

- Press Escape to cancel a pending draw and return to the previous image. Loading indicators appear more smoothly, with less flickering.
- Random draws skip images already seen on this device or shared through Sync. If no new image is found, the app asks you to try again.
- When Prnt.sc temporarily limits access, the app explains the wait and shows a countdown. You can still browse earlier images.
- Stats more clearly separate your drawing activity from the Prnt.sc addresses checked. Daily results reflect activity on this device, and syncing history does not increase your local totals.
- Improved recovery when saved data cannot be loaded, including a Try again action at startup.

### What's new after an update

- Release notes appear after an in-app update and restart. You can reopen them anytime through More > What's new.
- Updated the privacy policy to explain optional Sync, what it shares, and what stays on your device.
