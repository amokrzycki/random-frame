import { Image } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { toast } from "./toast.js";

function imageExtension(mimeType: string): string {
  const subtype =
    mimeType
      .split(";", 1)[0]
      ?.trim()
      .toLowerCase()
      .replace(/^image\//, "") ?? "";
  const aliases: Record<string, string> = { jpeg: "jpg", "svg+xml": "svg", tiff: "tif", "x-icon": "ico" };
  return aliases[subtype] ?? (subtype.replace(/[^a-z0-9]/g, "") || "img");
}

export async function saveImage(id: string, blob: Blob, announcer: HTMLElement): Promise<void> {
  const extension = imageExtension(blob.type);
  try {
    const path = await save({
      title: "Save image",
      defaultPath: `random-frame-prntsc-${id}.${extension}`,
      filters: [{ name: "Image", extensions: [extension] }],
    });
    if (!path) return;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    announcer.textContent = `Saved frame ${id}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image could not be saved";
    toast.error(message);
  }
}

export async function copyImage(blob: Blob): Promise<void> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available");
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    const image = await Image.new(new Uint8Array(data.buffer), bitmap.width, bitmap.height);
    await writeImage(image);
    toast.success("Copied image to clipboard");
  } catch (error) {
    const message = error instanceof Error ? error.message : "The image could not be copied";
    toast.error(message);
  }
}
