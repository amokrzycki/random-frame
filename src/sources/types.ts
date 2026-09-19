export interface RandomItem {
  id: string;
  source: string;
  mediaUrl: string;
  sourcePageUrl?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

export interface SourceAsset {
  response: Response;
  contentType: string;
}

export interface RandomSource {
  id: string;
  available: boolean;
  getRandomItem(): Promise<RandomItem>;
  validateItemId?(id: string): void;
  getItem?(id: string): Promise<RandomItem>;
  fetchAsset(item: RandomItem): Promise<SourceAsset>;
}

export class SourceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseStatus = 502,
  ) {
    super(message);
  }
}
