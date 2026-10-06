import { invoke } from "@tauri-apps/api/core";

export interface PlatformCapabilities {
  platform: string;
  sync: boolean;
  desktopWindowControls: boolean;
  updater: boolean;
  imageClipboard: boolean;
}

let capabilities: PlatformCapabilities | null = null;

const flags = ["sync", "desktopWindowControls", "updater", "imageClipboard"] as const;

/** Asks the native side what this build supports. Never guesses: a failed or malformed answer rejects. */
export async function initializePlatform(): Promise<PlatformCapabilities> {
  const value = await invoke<PlatformCapabilities>("get_platform_capabilities");
  if (typeof value?.platform !== "string" || flags.some((flag) => typeof value[flag] !== "boolean"))
    throw new Error("Invalid platform capabilities");
  capabilities = value;
  return value;
}

export function getPlatformCapabilities(): PlatformCapabilities {
  if (!capabilities) throw new Error("Platform capabilities are not initialized");
  return capabilities;
}
