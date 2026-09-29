import { invoke } from "@tauri-apps/api/core";

interface FrameMetadata {
  id: string;
  source: string;
  sourcePageUrl: string;
  mimeType: string;
}

export interface Frame extends FrameMetadata {
  blob: Blob;
}

function messageFrom(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null && "message" in error) return String(error.message);
  return "The image could not be loaded";
}

async function receiveFrame(
  command: "get_random_frame" | "get_frame_by_id",
  args: Record<string, string>,
): Promise<Frame> {
  try {
    const metadata = await invoke<FrameMetadata>(command, args);
    const bytes = await invoke<ArrayBuffer>("get_frame_image", {
      source: metadata.source,
      id: metadata.id,
    });
    return { ...metadata, blob: new Blob([bytes], { type: metadata.mimeType }) };
  } catch (error) {
    // Keep the backend's error kind so the viewer can explain rate limits and outages plainly.
    const kind = typeof error === "object" && error !== null && "kind" in error ? String(error.kind) : undefined;
    throw Object.assign(new Error(messageFrom(error)), { kind });
  }
}

export function getRandomFrame(source = "prntsc"): Promise<Frame> {
  return receiveFrame("get_random_frame", { source });
}

export function getFrameById(id: string, source = "prntsc"): Promise<Frame> {
  return receiveFrame("get_frame_by_id", { source, id });
}

// The backend's token bucket refills 3/s; a batch outruns it, so wait out local rate limits instead of failing.
export async function getThumbnailBlob(id: string, source: string): Promise<Blob> {
  for (let attempt = 0; ; attempt++) {
    try {
      return new Blob([await invoke<ArrayBuffer>("get_thumbnail_image", { source, id })]);
    } catch (error) {
      const limited = typeof error === "object" && error !== null && "kind" in error && error.kind === "rate-limited";
      if (!limited || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
  }
}
