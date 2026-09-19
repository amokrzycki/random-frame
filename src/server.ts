import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sendJson } from "./http.js";
import { takeApiToken } from "./rate-limit.js";
import { extractImageUrl, isAllowedImageUrl } from "./sources/prntsc.js";
import { selectSource } from "./sources/registry.js";
import type { RandomItem, RandomSource, SourceAsset } from "./sources/types.js";
import { SourceError } from "./sources/types.js";

declare const APP_VERSION: string;

export { extractImageUrl, isAllowedImageUrl, selectSource };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Hashed filenames come from esbuild's --metafile output, produced only by the
// production build. In dev (no metafile yet) we fall back to the unhashed paths.
function resolveHashedAsset(metaFile: string, entryPoint: string, devDiskPath: string, devUrl: string) {
  try {
    const meta = JSON.parse(readFileSync(join(root, metaFile), "utf8")) as {
      outputs: Record<string, { entryPoint?: string }>;
    };
    const outPath = Object.keys(meta.outputs).find((path) => meta.outputs[path]?.entryPoint === entryPoint);
    if (outPath) return { disk: outPath, url: `/${outPath.slice(outPath.lastIndexOf("/") + 1)}`, hashed: true };
  } catch {
    // No metafile yet (dev server) — use the unhashed dev build output.
  }
  return { disk: devDiskPath, url: devUrl, hashed: false };
}

const appAsset = resolveHashedAsset("dist/client/meta.json", "src/client/app.ts", "dist/client/app.js", "/app.js");
const themeAsset = resolveHashedAsset(
  "dist/client/meta.json",
  "src/client/theme.ts",
  "dist/client/theme.js",
  "/theme.js",
);
const stylesAsset = resolveHashedAsset("dist/meta-styles.json", "styles.css", "styles.css", "/styles.css");
const hashedDiskPaths = new Set(
  [appAsset, themeAsset, stylesAsset].filter((asset) => asset.hashed).map((asset) => asset.disk),
);

const files: Record<string, readonly [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/privacy": ["privacy.html", "text/html; charset=utf-8"],
  "/privacy.html": ["privacy.html", "text/html; charset=utf-8"],
  [appAsset.url]: [appAsset.disk, "text/javascript; charset=utf-8"],
  [themeAsset.url]: [themeAsset.disk, "text/javascript; charset=utf-8"],
  [stylesAsset.url]: [stylesAsset.disk, "text/css; charset=utf-8"],
  "/assets/noto-serif-display.woff2": ["assets/noto-serif-display.woff2", "font/woff2"],
  // Unbundled dev build only: the browser resolves app.js's relative imports
  // to these paths directly. Absent in the bundled, hashed production build.
  ...(appAsset.hashed
    ? {}
    : {
        "/navigation.js": ["dist/client/navigation.js", "text/javascript; charset=utf-8"],
        "/toast.js": ["dist/client/toast.js", "text/javascript; charset=utf-8"],
      }),
};

export async function getRandomAsset(source: RandomSource): Promise<[RandomItem, SourceAsset]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const item = await source.getRandomItem();
      return [item, await source.fetchAsset(item)];
    } catch (error) {
      const status = error instanceof SourceError ? error.status : undefined;
      if (attempt === 19 || status === 403 || status === 429) throw error;
      if (status === 404) continue;
      await delay(150 * (attempt + 1));
    }
  }
  throw new Error("The image could not be loaded");
}

async function serveAsset(
  response: ServerResponse,
  item: RandomItem,
  asset: SourceAsset,
  cacheControl = "private, max-age=600",
): Promise<void> {
  const body = Buffer.from(await asset.response.arrayBuffer());
  if (body.length > 15_000_000) throw new Error("The image is too large");
  response.writeHead(200, {
    "content-type": asset.contentType,
    "content-length": body.length,
    "cache-control": cacheControl,
    "x-random-frame-id": item.id,
    "x-random-frame-source": item.source,
    ...(item.source === "prntsc" ? { "x-prntsc-id": item.id } : {}),
  });
  response.end(body);
}

export async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/api/random") {
      const source = selectSource(url.searchParams.get("source") ?? "prntsc");
      if (!takeApiToken(response)) return;
      const [item, asset] = await getRandomAsset(source);
      await serveAsset(response, item, asset, "no-store");
      return;
    }

    if (url.pathname.startsWith("/api/image/")) {
      const source = selectSource(url.searchParams.get("source") ?? "prntsc");
      if (!source.getItem) throw new SourceError(`${source.id} does not support item lookup`, 400, 400);
      const id = url.pathname.slice("/api/image/".length);
      source.validateItemId?.(id);
      if (!takeApiToken(response)) return;
      const item = await source.getItem(id);
      await serveAsset(response, item, await source.fetchAsset(item));
      return;
    }

    const asset = files[url.pathname];
    if (asset) {
      const [name, contentType] = asset;
      response.writeHead(200, {
        "content-type": contentType,
        "cache-control":
          name.endsWith(".woff2") || hashedDiskPaths.has(name) ? "public, max-age=31536000, immutable" : "no-cache",
      });
      const body = await readFile(join(root, name));
      response.end(
        name === "index.html" || name === "privacy.html"
          ? body
              .toString()
              .replace("{{VERSION}}", APP_VERSION)
              .replace("{{STYLES_CSS}}", stylesAsset.url)
              .replace("{{THEME_JS}}", themeAsset.url)
              .replace("{{APP_JS}}", appAsset.url)
          : body,
      );
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    if (!response.headersSent) {
      const status = error instanceof SourceError ? error.responseStatus : 502;
      sendJson(response, status, { error: error instanceof Error ? error.message : "The image could not be loaded" });
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  }
}

const server = createServer(handleRequest);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  // biome-ignore lint/suspicious/noConsole: Development logging
  server.listen(port, () => console.log(`Random Frame is running at http://localhost:${port}`));
}
