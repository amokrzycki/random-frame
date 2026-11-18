# Random Frame release notes

## 1.0.0

### One deliberate draw at a time

- Random Frame draws one public Prnt.sc image at a time instead of an endless feed. Press `N` or click Draw, step back through the session with the arrow keys, and keep what is worth keeping.
- The Prnt.sc source blocks cross-origin framing, so the app’s Rust backend resolves the source page and fetches the image on your device. The upstream service may rate-limit repeated requests; errors are explained plainly, and earlier history is never lost to them.
- Nearby Frames inspects four Prnt.sc IDs before and after the current image in a 3×3 gallery. Preview checks update IDs checked only; opening a preview adds History and Seen without a Draw.

### History, Stats and Saved

- History keeps every drawn frame. Remove a frame with Undo, or clear everything through an untimed review: Undo keeps the data, Finish clearing commits it, and closing or restarting before choosing Finish cancels the review.
- Stats count Frames drawn, Today, the activity streak and daily results, and reset with History. Prnt.sc IDs checked survive clearing and restarts.
- The star or `F` saves a frame to the library without a collection; the same action on a saved frame opens Collections. A frame can belong to several collections or none. Deleting a collection or its last assignment keeps the global save. Global removal and Clear all saved offer Undo and keep history and downloaded files.
- Saved frames retain source links and metadata, not permanent copies of upstream images, so an upstream image can disappear. Images saved to files stay where you saved them.

### Sync across devices

- Optional Sync shares history, saved frames, collections and assignments, Seen IDs, exploration progress, Activity Stats, theme and history page size between devices. Everything is encrypted on the device before it leaves; the server stores only encrypted data and membership records, and images saved to files are not backed up.
- The device that starts a Sync is its administrator and shows one code of 24 words. Other devices join by entering the code; there is nothing to approve, and the same code works for any number of devices.
- Joining chooses Restore, which takes the copy already in Sync, or Merge, which combines this device’s data and its previous deletions. A device with nothing saved joins with Restore.
- The administrator can show the code again, replace it with a New code, remove devices, or end the Sync for everyone. Removing a device changes the group key: the old code stops working, a new code is created, and the remaining devices pick up the new key on their own. Any other device can leave, keeping its local data.
- With Sync connected, changes upload shortly after you make them, at startup, on demand, and when you return to the app; closing gives waiting changes a few seconds to finish, and anything unfinished stays queued.
- The device list comes from the server and marks the Administrator and This device. Last synced is a record of past activity, not online presence.

### On your platform

- Random Frame runs on Windows, Linux and Android (64-bit ARM, Android 7.0 or newer). Installed desktop copies update themselves; on Android, install a newer APK over the old one.
- Light and dark themes follow the system or your choice, with keyboard access, visible focus, reduced-motion and high-contrast support throughout.
