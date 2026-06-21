import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { TorrentSourceManager } from '../torrent-source';
import {
  DuplicateTorrentCandidate,
  StoredTorrentStats,
  TorrentFileResponse,
  TorrentResponse,
  TorrentStoreStats,
} from './types';
import { env } from '@/env';
import { dirname, resolve } from 'node:path';
import { formatBytes } from '@/utils/bytes';
import { globSync } from 'glob';
import { TorrentServerSdk } from './torrent-server.sdk';
import { sleep } from '@/utils/sleep';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export class TorrentStoreService {
  private torrentServerUrl: string = `http://localhost:${env.TORRENT_SERVER_PORT}`;
  private torrentServerInstance: ChildProcessWithoutNullStreams | null = null;
  private torrentServerSdk: TorrentServerSdk = new TorrentServerSdk(
    this.torrentServerUrl,
  );
  private statsFilePath = resolve(env.ADDON_DIR, 'config/torrent-stats.json');
  private storedStats = new Map<string, StoredTorrentStats>();
  private statsInterval: NodeJS.Timeout | null = null;

  constructor(private torrentSource: TorrentSourceManager) {
    this.loadStoredStats();
  }

  public async startServer() {
    if (process.env.NODE_ENV === 'production') {
      const executablePath = resolve(
        import.meta.dirname,
        '../../../torrent-server/torrent-server',
      );
      this.torrentServerInstance = spawn(executablePath, [
        '-p',
        `${env.TORRENT_SERVER_PORT}`,
        '-d',
        env.DOWNLOADS_DIR,
      ]);
    } else {
      let isServerUp = false,
        retryCount = 0;
      while (!isServerUp && retryCount < 5) {
        try {
          retryCount++;
          console.log(`Looking for torrent server. Try #${retryCount}`);
          await sleep(1000);
          await fetch(this.torrentServerUrl);
          isServerUp = true;
          console.log('Found torrent server.');
        } catch {
          console.log(`Server is not up yet. Retrying in 1 second`);
        }
      }
    }
    this.startStatsPersistence();
  }

  private checkServer() {
    if (this.torrentServerInstance === null && process.env.NODE_ENV === 'production') {
      throw Error(
        'The torrent server is not running. You need to initialize it first. This is a bug, please create an issue on github.',
      );
    }
  }

  public async addTorrent(torrentFilePath: string): Promise<TorrentResponse> {
    this.checkServer();
    const torrent = await this.torrentServerSdk.addTorrent(torrentFilePath);
    return this.mergeStoredStats(torrent);
  }

  public async getTorrent(infoHash: string): Promise<TorrentResponse | null> {
    this.checkServer();
    const torrent = await this.torrentServerSdk.getTorrent(infoHash);
    return torrent ? this.mergeStoredStats(torrent) : null;
  }

  public async markPlaybackActive(infoHash: string): Promise<void> {
    this.checkServer();
    await this.torrentServerSdk.markPlaybackActive(infoHash);
  }

  public async deleteTorrent(infoHash: string): Promise<void> {
    this.checkServer();
    this.storedStats.delete(infoHash.toLowerCase());
    this.saveStoredStats();
    return await this.torrentServerSdk.deleteTorrent(infoHash);
  }

  public async getAllTorrents(): Promise<TorrentResponse[]> {
    this.checkServer();
    const torrents = await this.torrentServerSdk.getAllTorrents();
    this.updateStoredStats(torrents);
    return torrents.map((torrent) => this.mergeStoredStats(torrent));
  }

  public async getStoreStats(): Promise<TorrentStoreStats[]> {
    this.checkServer();
    const torrents = await this.getAllTorrents();
    const stats = torrents
      .map(
        (t) =>
          ({
            hash: t.infoHash,
            name: t.name,
            size: formatBytes(t.size),
            downloaded: formatBytes(t.downloaded),
            uploaded: formatBytes(t.uploaded),
            ratio: t.ratio.toFixed(2),
            progress: `${(t.progress * 100).toFixed(2)}%`,
          }) satisfies TorrentStoreStats,
      )
      .sort((a, z) => a.name.localeCompare(z.name));
    return stats;
  }

  public async getDuplicateTorrentCandidates(): Promise<DuplicateTorrentCandidate[]> {
    this.checkServer();
    const torrents = await this.getAllTorrents();
    const readyTorrents = torrents.filter(
      (torrent) => torrent.progress >= 0.999 && torrent.ratio >= 1,
    );

    const groups = new Map<string, TorrentResponse[]>();
    for (const torrent of readyTorrents) {
      const duplicateKey = this.getDuplicateKey(torrent);
      if (!duplicateKey) {
        continue;
      }
      const group = groups.get(duplicateKey) ?? [];
      group.push(torrent);
      groups.set(duplicateKey, group);
    }

    return [...groups.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([duplicateKey, group]) => {
        const sorted = [...group].sort((a: TorrentResponse, z: TorrentResponse) => {
          const ratioDiff = z.ratio - a.ratio;
          if (ratioDiff !== 0) {
            return ratioDiff;
          }
          return z.size - a.size;
        });
        const [keep, ...deletable] = sorted;
        return { duplicateKey, keep: keep!, deletable };
      });
  }

  private getDuplicateKey(torrent: TorrentResponse): string | null {
    const mediaFile = [...torrent.files]
      .filter((file: TorrentFileResponse) => this.isMediaFile(file.name))
      .sort((a: TorrentFileResponse, z: TorrentFileResponse) => z.size - a.size)[0];
    const name = mediaFile?.name ?? torrent.name;
    const normalized = name
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const resolution = normalized.match(/\b(2160p|1080p|720p|480p)\b/)?.[1] ?? 'unknown';
    const episode = normalized.match(/\bs\d{1,2}e\d{1,2}\b/)?.[0] ?? '';
    const qualityIndex = normalized.search(
      /\b(2160p|1080p|720p|480p|uhd|bluray|blu ray|web dl|webdl|webrip|hdtv|hdr|dv|dovi|x265|x264|h265|h264)\b/,
    );
    const titlePart = qualityIndex >= 0 ? normalized.slice(0, qualityIndex).trim() : normalized;
    if (!titlePart) {
      return null;
    }

    return [titlePart, episode, resolution].filter(Boolean).join('|');
  }

  private isMediaFile(fileName: string): boolean {
    return /\.(mkv|mp4|avi|mov|m4v)$/i.test(fileName);
  }

  private loadStoredStats(): void {
    if (!existsSync(this.statsFilePath)) {
      return;
    }
    try {
      const rawStats = JSON.parse(readFileSync(this.statsFilePath, 'utf-8')) as StoredTorrentStats[];
      this.storedStats = new Map(
        rawStats.map((stat) => [stat.infoHash.toLowerCase(), stat]),
      );
      console.log(`Loaded ${this.storedStats.size} persisted torrent stats.`);
    } catch (error) {
      console.error('Failed to load persisted torrent stats:', error);
    }
  }

  private saveStoredStats(): void {
    try {
      mkdirSync(dirname(this.statsFilePath), { recursive: true });
      writeFileSync(
        this.statsFilePath,
        JSON.stringify([...this.storedStats.values()], null, 2),
      );
    } catch (error) {
      console.error('Failed to save persisted torrent stats:', error);
    }
  }

  private startStatsPersistence(): void {
    if (this.statsInterval) {
      return;
    }
    this.statsInterval = setInterval(async () => {
      try {
        const torrents = await this.torrentServerSdk.getAllTorrents();
        this.updateStoredStats(torrents);
      } catch (error) {
        console.error('Failed to refresh persisted torrent stats:', error);
      }
    }, 30_000);
  }

  private updateStoredStats(torrents: TorrentResponse[]): void {
    let changed = false;
    const updatedAt = new Date().toISOString();

    for (const torrent of torrents) {
      const key = torrent.infoHash.toLowerCase();
      const previous = this.storedStats.get(key);
      const uploaded = Math.max(previous?.uploaded ?? 0, torrent.uploaded);
      const ratio = Math.max(previous?.ratio ?? 0, torrent.ratio);

      if (!previous || previous.uploaded !== uploaded || previous.ratio !== ratio) {
        this.storedStats.set(key, {
          infoHash: torrent.infoHash,
          name: torrent.name,
          size: torrent.size,
          uploaded,
          ratio,
          updatedAt,
        });
        changed = true;
      }
    }

    if (changed) {
      this.saveStoredStats();
    }
  }

  private mergeStoredStats(torrent: TorrentResponse): TorrentResponse {
    const storedStats = this.storedStats.get(torrent.infoHash.toLowerCase());
    if (!storedStats) {
      return torrent;
    }
    return {
      ...torrent,
      uploaded: Math.max(torrent.uploaded, storedStats.uploaded),
      ratio: Math.max(torrent.ratio, storedStats.ratio),
    };
  }

  public getFileStreamingUrl({
    infoHash,
    filePath,
  }: {
    infoHash: string;
    filePath: string;
  }) {
    return this.torrentServerSdk.getFileStreamingUrl(infoHash, filePath);
  }

  public async loadExistingTorrents(): Promise<void> {
    this.checkServer();
    console.log('Looking for torrent files...');
    const savedTorrentFilePaths = globSync(`${env.TORRENTS_DIR}/*.torrent`);
    console.log(`Found ${savedTorrentFilePaths.length} torrent files.`);
    await Promise.allSettled(
      savedTorrentFilePaths.map((filePath) => {
        return this.addTorrent(filePath);
      }),
    );
    console.log('Torrent files loaded and verified.');
  }

  public deleteUnnecessaryTorrents = async () => {
    this.checkServer();
    console.log('Gathering unnecessary torrents...');
    const deletableInfoHashes = await this.torrentSource.getRemovableInfoHashes();
    console.log(`Found ${deletableInfoHashes.length} deletable torrents.`);
    deletableInfoHashes.forEach(async (infoHash) => {
      const torrent = await this.getTorrent(infoHash);
      if (torrent) {
        this.deleteTorrent(infoHash);
        console.log(`Successfully deleted ${torrent.name} - ${torrent.infoHash}.`);
      }
    });
  };
}
