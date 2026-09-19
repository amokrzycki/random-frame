import type { RandomItem, RandomSource, SourceAsset } from "./types.js";
import { SourceError } from "./types.js";

function unavailable(): never {
  throw new SourceError("Internet Archive source is not configured yet", 501, 501);
}

export const internetArchiveSource: RandomSource = {
  id: "internet-archive",
  available: false,
  async getRandomItem(): Promise<RandomItem> {
    unavailable();
  },
  async fetchAsset(): Promise<SourceAsset> {
    unavailable();
  },
};
