import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
const resolvedImages = new Map();
const files = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/navigation.js": ["navigation.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/assets/noto-serif-display.woff2": ["assets/noto-serif-display.woff2", "font/woff2"],
};

function makeId() {
  return Array.from({ length: 6 }, () => characters[Math.floor(Math.random() * characters.length)]).join("");
}

function decodeHtml(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&#x2F;", "/").replaceAll("&#47;", "/");
}

export function isAllowedImageUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return protocol === "https:" && (hostname === "image.prntscr.com" || hostname === "i.imgur.com");
  } catch {
    return false;
  }
}

export function extractImageUrl(html) {
  const patterns = [
    /<img[^>]+id=["']screenshot-image["'][^>]+src=["']([^"']+)["']/i,
    /<img[^>]+src=["']([^"']+)["'][^>]+id=["']screenshot-image["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match && isAllowedImageUrl(decodeHtml(match[1]))) return decodeHtml(match[1]);
  }
  return null;
}

async function resolveImage(id) {
  if (resolvedImages.has(id)) return resolvedImages.get(id);

  const page = await fetch(`https://prnt.sc/${id}`, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
    },
    signal: AbortSignal.timeout(12_000),
  });
  if (!page.ok) throw new Error(`Prnt.sc returned status ${page.status}`);

  const imageUrl = extractImageUrl(await page.text());
  if (!imageUrl) throw new Error("No image was found at this address");

  resolvedImages.set(id, imageUrl);
  if (resolvedImages.size > 100) resolvedImages.delete(resolvedImages.keys().next().value);
  return imageUrl;
}

async function fetchImage(id) {
  const imageUrl = await resolveImage(id);
  const image = await fetch(imageUrl, {
    headers: {
      accept: "image/avif,image/webp,image/png,image/jpeg,*/*",
      referer: `https://prnt.sc/${id}`,
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
    },
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = image.headers.get("content-type") || "";
  const contentLength = Number(image.headers.get("content-length") || 0);
  if (!image.ok || !contentType.startsWith("image/") || contentLength > 15_000_000) {
    throw new Error("The source did not return a valid image");
  }
  return { image, contentType };
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function serveImage(response, id, cacheControl = "private, max-age=600") {
  const { image, contentType } = await fetchImage(id);
  const body = Buffer.from(await image.arrayBuffer());
  if (body.length > 15_000_000) throw new Error("The image is too large");
  response.writeHead(200, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": cacheControl,
    "x-prntsc-id": id,
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");

    if (url.pathname === "/api/random") {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await serveImage(response, makeId(), "no-store");
          return;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    }

    if (url.pathname.startsWith("/api/image/")) {
      const id = url.pathname.slice("/api/image/".length);
      if (!/^[a-z0-9]{6}$/.test(id)) return sendJson(response, 400, { error: "Invalid image identifier" });
      await serveImage(response, id);
      return;
    }

    const asset = files[url.pathname];
    if (asset) {
      const [name, contentType] = asset;
      response.writeHead(200, { "content-type": contentType, "cache-control": name.endsWith(".woff2") ? "public, max-age=31536000, immutable" : "no-cache" });
      response.end(await readFile(join(root, name)));
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (!response.headersSent) sendJson(response, 502, { error: error.message || "The image could not be loaded" });
    else response.destroy(error);
  }
});

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  server.listen(port, () => console.log(`Random Frame is running at http://localhost:${port}`));
}
