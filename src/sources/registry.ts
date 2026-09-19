import { internetArchiveSource } from "./internet-archive.js";
import { prntscSource } from "./prntsc.js";
import type { RandomSource } from "./types.js";
import { SourceError } from "./types.js";

export const sources: readonly RandomSource[] = [prntscSource, internetArchiveSource];

export function selectSource(
  requested = "prntsc",
  random = Math.random,
  registered: readonly RandomSource[] = sources,
): RandomSource {
  if (requested === "mixed") {
    const available = registered.filter((source) => source.available);
    const source = available[Math.floor(random() * available.length)];
    if (!source) throw new SourceError("No sources are currently available", 503, 503);
    return source;
  }

  const source = registered.find(({ id }) => id === requested);
  if (!source) throw new SourceError(`Unknown source: ${requested}`, 400, 400);
  if (!source.available) throw new SourceError(`${source.id} source is not available yet`, 501, 501);
  return source;
}
