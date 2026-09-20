import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export async function checkForUpdate(): Promise<void> {
  let update: Awaited<ReturnType<typeof check>>;
  try {
    update = await check();
  } catch {
    return;
  }
  if (!update) return;

  const banner = document.createElement("div");
  banner.className = "update-banner";
  banner.role = "status";

  const message = document.createElement("span");
  message.textContent = `Update ${update.version} available`;

  const installButton = document.createElement("button");
  installButton.type = "button";
  installButton.textContent = "Install & restart";
  installButton.addEventListener("click", async () => {
    installButton.disabled = true;
    installButton.textContent = "Installing…";
    try {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          installButton.textContent = total ? `Installing… ${Math.round((downloaded / total) * 100)}%` : "Installing…";
        }
      });
      await relaunch();
    } catch {
      installButton.disabled = false;
      installButton.textContent = "Install & restart";
      message.textContent = "Update failed. Try again later.";
    }
  });

  const dismissButton = document.createElement("button");
  dismissButton.type = "button";
  dismissButton.className = "update-banner__dismiss";
  dismissButton.textContent = "Dismiss";
  dismissButton.addEventListener("click", () => banner.remove());

  banner.append(message, installButton, dismissButton);
  document.body.append(banner);
}
