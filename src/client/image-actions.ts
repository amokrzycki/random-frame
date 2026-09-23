import { Image } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { describeError } from "./errors.js";
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

// Resolves true only once the file is written; a cancelled dialog or failure is false.
export async function saveImage(id: string, blob: Blob): Promise<boolean> {
  const extension = imageExtension(blob.type);
  try {
    const path = await save({
      title: "Save image",
      defaultPath: `random-frame-prntsc-${id}.${extension}`,
      filters: [{ name: "Image", extensions: [extension] }],
    });
    if (!path) return false;
    await writeFile(path, new Uint8Array(await blob.arrayBuffer()));
    toast.success("Saved image");
    return true;
  } catch (error) {
    toast.error(describeError(error, "The image could not be saved. Try again.").message);
    return false;
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
    toast.error(describeError(error, "The image could not be copied. Try again.").message);
  }
}
