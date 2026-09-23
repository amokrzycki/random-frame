export interface ErrorCopy {
  title: string;
  message: string;
  // Seconds before another request to the source is worth attempting.
  cooldownSeconds: number;
}

const DEFAULT_TITLE = "This frame would not open.";
const DEFAULT_MESSAGE = "The source may have limited access, or this address may be empty.";

// Errors arrive as Error instances from api.ts or as raw `{ kind, message }` objects from other Tauri commands.
function field(error: unknown, name: "kind" | "message"): string | undefined {
  if (typeof error === "string") return name === "message" ? error : undefined;
  if (typeof error !== "object" || error === null || !(name in error)) return undefined;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === "string" && value ? value : undefined;
}

export function describeError(error: unknown, fallback = DEFAULT_MESSAGE): ErrorCopy {
  const copy = (title: string, message: string, cooldownSeconds = 0): ErrorCopy => ({
    title,
    message,
    cooldownSeconds,
  });
  switch (field(error, "kind")) {
    case "rate-limited":
      return copy(
        "Drawing a little too fast.",
        "Random Frame spaces out requests so Prnt.sc keeps answering. Try again in a moment.",
        2,
      );
    case "upstream-rate-limited":
      return copy(
        "Prnt.sc is limiting requests.",
        "Too many frames were requested in a short time. Wait a few seconds, then draw again.",
        10,
      );
    case "upstream-forbidden":
      return copy(
        "Prnt.sc refused the request.",
        "The source is blocking access for now. Wait a little, then try again.",
        10,
      );
    case "timeout":
      return copy("Prnt.sc took too long to answer.", "The source may be busy. Try again in a moment.");
    case "network":
      return copy("Prnt.sc could not be reached.", "Check your internet connection, then try again.");
    case "not-found":
      return copy(DEFAULT_TITLE, "Nothing is published at this address, or it has been removed.");
    case "no-new-frame":
      return copy("No new frame was found.", "Try drawing again.");
    case "image-too-large":
      return copy(DEFAULT_TITLE, "This image is larger than Random Frame can safely open.");
    case "invalid-response":
      return copy(DEFAULT_TITLE, "Prnt.sc answered, but not with an image Random Frame can show.");
    case "persistence":
      return copy(
        "History could not be saved.",
        "Random Frame could not write to its local data folder. Check the free disk space, then try again.",
      );
    default:
      // Unknown errors carry internal detail; keep it out of the UI.
      console.error(error);
      return copy(DEFAULT_TITLE, fallback);
  }
}
