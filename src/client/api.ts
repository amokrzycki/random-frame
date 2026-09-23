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
