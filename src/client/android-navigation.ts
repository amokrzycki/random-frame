import { onBackButtonPress } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { dialogs, dismissTopLayer } from "./dialogs.js";
import { cancelDraw } from "./frame-loader.js";

/** Finishes the Android activity, as the system Back would from the first screen. */
export function exitApp(): Promise<void> {
  return invoke("exit_app");
}

// While this listener is registered, Tauri hands every Back press to it instead of the WebView. The
// gallery keeps no history entries of its own, so Back that nothing else claims always leaves the app.
export async function bindAndroidNavigation(): Promise<() => void> {
  const listener = await onBackButtonPress(() => {
    if (dismissTopLayer()) return;
    if (!dialogs.some((dialog) => dialog.open) && cancelDraw()) return;
    void exitApp();
  });
  return () => void listener.unregister();
}
