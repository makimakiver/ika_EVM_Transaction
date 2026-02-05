export type HLMetaUniverseItem = {
  name: string;
  // The API may include more fields; keep them optional so TS doesn't complain.
  szDecimals?: number;
  maxLeverage?: number;
  onlyIsolated?: boolean;
  [key: string]: unknown;
};

export type HLMetaResponse = {
  universe: HLMetaUniverseItem[];
  [key: string]: unknown;
};