import { HttpStatusCode } from '@/types/http';
import { AddTorrentRequest, InfoHash, TorrentResponse } from './types';
import { rm } from 'fs/promises';

export class TorrentServerSdk {
  private torrentFilePaths = new Map<InfoHash, string>();
  constructor(private readonly url: string) {}

  public async getTorrent(infoHash: InfoHash): Promise<TorrentResponse | null> {
    const req = await fetch(`${this.url}/torrents/${infoHash}`);
    if (!req.ok) {
      if (req.status === HttpStatusCode.NOT_FOUND) {
        return null;
      }
      const responseText = await req.text();
      throw Error(
        `Could not find torrent. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    return (await req.json()) as TorrentResponse;
  }

  public async getAllTorrents(): Promise<TorrentResponse[]> {
    const req = await fetch(`${this.url}/torrents`);
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Failed to get torrents. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    return (await req.json()) as TorrentResponse[];
  }

  public async addTorrent(
    torrentFilePath: string,
    { verify = true }: { verify?: boolean } = {},
  ): Promise<TorrentResponse> {
    const req = await fetch(`${this.url}/torrents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: torrentFilePath, verify } satisfies AddTorrentRequest),
    });
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Could not add torrent. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    const torrent = (await req.json()) as TorrentResponse;
    this.torrentFilePaths.set(torrent.infoHash, torrentFilePath);
    return torrent;
  }

  public async markPlaybackActive(infoHash: InfoHash): Promise<void> {
    const req = await fetch(`${this.url}/playback-limiter/${infoHash}`, {
      method: 'POST',
    });
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Could not mark playback active. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
  }

  public async getPlaybackLimiterStatus(): Promise<{
    active: boolean;
    activeInfoHash: string;
    activeUntil: string;
    activeTimeoutMs: number;
  }> {
    const req = await fetch(`${this.url}/playback-limiter`);
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Could not get playback limiter status. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    return await req.json();
  }

  public async deleteTorrent(infoHash: InfoHash): Promise<void> {
    const req = await fetch(`${this.url}/torrents/${infoHash}`, { method: 'DELETE' });
    if (!req.ok) {
      const responseText = await req.text();
      throw Error(
        `Could not delete torrent. Status code: ${req.status}. Error: ${responseText}`,
      );
    }
    const torrentFilePath = this.torrentFilePaths.get(infoHash);
    if (!torrentFilePath) {
      throw Error(
        `Failed to delete torrent file at path: "${torrentFilePath}". File not found.`,
      );
    }
    try {
      await rm(torrentFilePath);
      this.torrentFilePaths.delete(infoHash);
    } catch (e) {
      throw Error(
        `Failed to delete torrent file at path: "${torrentFilePath}". Error: "${e}"`,
      );
    }
  }

  public getFileStreamingUrl(infoHash: InfoHash, filePath: string): string {
    return `${this.url}/torrents/${infoHash}/files/${filePath}`;
  }
}
