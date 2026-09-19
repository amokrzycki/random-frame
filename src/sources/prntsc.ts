import type { RandomItem, RandomSource, SourceAsset } from "./types.js";
import { SourceError } from "./types.js";

const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
const resolvedImages = new Map<string, string>();

function makeId(): string {
  return Array.from({ length: 6 }, () => characters[Math.floor(Math.random() * characters.length)]).join("");
}

function decodeHtml(value: string): string {
  return value.replaceAll("&amp;", "&").replaceAll("&#x2F;", "/").replaceAll("&#47;", "/");
}

function validateItemId(id: string): void {
  if (!/^[a-z0-9]{6}$/.test(id)) throw new SourceError("Invalid image identifier", 400, 400);
}

export function isAllowedImageUrl(value: string): boolean {
  try {
    const { protocol, hostname } = new URL(value);
    return protocol === "https:" && (hostname === "image.prntscr.com" || hostname === "i.imgur.com");
  } catch {
    return false;
  }
}

export function extractImageUrl(html: string): string | null {
  const patterns = [
    /<img[^>]+id=["']screenshot-image["'][^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]+id=["']screenshot-image["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];

  for (const pattern of patterns) {
    const value = html.match(pattern)?.[1];
    if (value) {
      const decoded = decodeHtml(value);
      if (isAllowedImageUrl(decoded)) return decoded;
    }
  }
  return null;
}

async function resolveItem(id: string): Promise<RandomItem> {
  validateItemId(id);

  let mediaUrl = resolvedImages.get(id);
  if (!mediaUrl) {
    const page = await fetch(`https://prnt.sc/${id}`, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
      },
      signal: AbortSignal.timeout(12_000),
    });
    if (!page.ok) throw new SourceError(`Prnt.sc returned status ${page.status}`, page.status);

    mediaUrl = extractImageUrl(await page.text()) ?? undefined;
    if (!mediaUrl) throw new SourceError("No image was found at this address", 404);

    resolvedImages.set(id, mediaUrl);
    if (resolvedImages.size > 100) {
      const oldest = resolvedImages.keys().next().value;
      if (oldest) resolvedImages.delete(oldest);
    }
  }

  return {
    id,
    source: "prntsc",
    mediaUrl,
    sourcePageUrl: `https://prnt.sc/${id}`,
  };
}

async function fetchAsset(item: RandomItem): Promise<SourceAsset> {
  const response = await fetch(item.mediaUrl, {
    headers: {
      accept: "image/avif,image/webp,image/png,image/jpeg,*/*",
      referer: item.sourcePageUrl ?? "https://prnt.sc/",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get("content-type") || "";
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (!response.ok) throw new SourceError(`The image host returned status ${response.status}`, response.status);
  if (!contentType.startsWith("image/") || contentLength > 15_000_000) {
    throw new Error("The source did not return a valid image");
  }
  return { response, contentType };
}

export const prntscSource: RandomSource = {
  id: "prntsc",
  available: true,
  getRandomItem: () => resolveItem(makeId()),
  validateItemId,
  getItem: resolveItem,
  fetchAsset,
};
