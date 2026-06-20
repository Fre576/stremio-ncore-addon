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

export interface AddTorrentRequest {
  path: string;
}

export interface DuplicateTorrentCandidate {
  duplicateKey: string;
  keep: TorrentResponse;
  deletable: TorrentResponse[];
}
