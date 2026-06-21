export type InfoHash = string;

export interface TorrentStoreStats {
  hash: InfoHash;
  name: string;
  progress: string;
  size: string;
  downloaded: string;
  uploaded: string;
  ratio: string;
}

export interface TorrentFileResponse {
  name: string;
  path: string;
  size: number;
  progress: number;
}

export interface TorrentResponse {
  infoHash: InfoHash;
  name: string;
  progress: number;
  size: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  files: TorrentFileResponse[];
}

export interface StoredTorrentStats {
  infoHash: InfoHash;
  name: string;
  size: number;
  uploaded: number;
  ratio: number;
  updatedAt: string;
}

export interface AddTorrentRequest {
  path: string;
}

export interface DuplicateTorrentCandidate {
  duplicateKey: string;
  keep: TorrentResponse;
  deletable: TorrentResponse[];
}
export interface DeletableTorrentCandidate {
  infoHash: InfoHash;
  name: string;
  size: number;
  downloaded: number;
  uploaded: number;
  ratio: number;
  progress: number;
  reason: string;
}

export interface DiskSpaceInfo {
  path: string;
  free: number;
  total: number;
  used: number;
  freeFormatted: string;
  totalFormatted: string;
  usedFormatted: string;
  warningThreshold: number;
  warningThresholdFormatted: string;
  isLow: boolean;
  deletableCandidates: DeletableTorrentCandidate[];
}
