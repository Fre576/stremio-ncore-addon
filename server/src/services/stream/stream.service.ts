import type { Stream } from 'stremio-addon-sdk';
import type { TorrentDetails } from '../torrent-source';
import type { TorrentFileDetails } from '../torrent-source/types';
import type { TorrentFileResponse, TorrentResponse } from '../torrent-store/types';
import { languageEmojiMap } from './constants';
import { rateList } from '@/utils/rate-list';
import { formatBytes } from '@/utils/bytes';
import { ConfigService } from '../config';
import { UserService } from '../user';
import { User } from '@/types/user';
import { Language, Resolution } from '@/db/schema/users';

export class StreamService {
  constructor(
    private configService: ConfigService,
    private userService: UserService,
  ) {}

  public convertTorrentToStream({
    torrent,
    isRecommended,
    deviceToken,
    season,
    episode,
    preferredLanguage,
    storedTorrents,
  }: {
    torrent: TorrentDetails;
    isRecommended: boolean;
    deviceToken: string;
    season: number | undefined;
    episode: number | undefined;
    preferredLanguage: Language;
    storedTorrents: TorrentResponse[];
  }): Stream {
    const config = this.configService.getConfig();
    const torrentFileIndex = torrent.getMediaFileIndex({ season, episode });

    const sourceName = encodeURIComponent(torrent.sourceName);
    const sourceId = encodeURIComponent(torrent.sourceId);
    const infoHash = encodeURIComponent(torrent.infoHash);
    const fileIndex = encodeURIComponent(torrentFileIndex);

    const description = this.getStreamDescription(
      torrent,
      isRecommended,
      {
        season,
        episode,
      },
      preferredLanguage,
      storedTorrents,
    );
    return {
      url: `${config.addonUrl}/api/auth/${deviceToken}/stream/play/${sourceName}/${sourceId}/${infoHash}/${fileIndex}`,
      description,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: torrent.infoHash,
      },
    };
  }

  private getStreamDescription(
    torrent: TorrentDetails,
    isRecommended: boolean,
    { season, episode }: { season: number | undefined; episode: number | undefined },
    preferredLanguage: Language,
    storedTorrents: TorrentResponse[],
  ): string {
    const languageEmoji = languageEmojiMap[torrent.getLanguage()];
    const fileIndex = torrent.getMediaFileIndex({ season, episode });
    const file = torrent.files[fileIndex] as TorrentFileDetails;
    const fileSizeString = formatBytes(file.length);

    const isShow = season && episode;
    let mediaType = '';
    switch (preferredLanguage) {
      case Language.HU:
        mediaType = isShow ? 'sorozat' : 'film';
        break;
      default:
        mediaType = isShow ? 'show' : 'movie';
    }

    let recommendedLine = '';
    if (isRecommended && !torrent.isSpeculated) {
      switch (preferredLanguage) {
        case Language.HU:
          recommendedLine = '⭐️ Ajánlott\n';
          break;
        default:
          recommendedLine = '⭐️ Recommended\n';
      }
    }

    let warningLine = '';
    if (torrent.isSpeculated) {
      switch (preferredLanguage) {
        case Language.HU:
          warningLine = `⚠️ Bizonytalan forrás ⚠️\nEz lehet egy másik ${mediaType}!\n`;
          break;
        default:
          warningLine = `⚠️ Speculated source ⚠️\nThis might be a different ${mediaType}!\n`;
      }
    }

    const downloadStatusLine = this.getDownloadStatusLine({
      torrent,
      fileIndex,
      storedTorrents,
      preferredLanguage,
    });
    const resolution = torrent.getResolution(file.name);
    const typeLine = `${languageEmoji} | ${torrent.displayResolution(resolution)} | ${fileSizeString}\n`;
    const title = isShow ? `${file.name}\n` : `${torrent.getName()}\n`;
    const healthLine = this.getStreamHealthLine({
      torrent,
      resolution,
      fileSize: file.length,
      preferredLanguage,
    });
    return (
      downloadStatusLine + warningLine + recommendedLine + typeLine + healthLine + title
    );
  }

  private getDownloadStatusLine({
    torrent,
    fileIndex,
    storedTorrents,
    preferredLanguage,
  }: {
    torrent: TorrentDetails;
    fileIndex: number;
    storedTorrents: TorrentResponse[];
    preferredLanguage: Language;
  }): string {
    const storedTorrent = storedTorrents.find(
      (item) => item.infoHash.toLowerCase() === torrent.infoHash.toLowerCase(),
    );
    if (!storedTorrent) {
      return preferredLanguage === Language.HU ? '🆕 ÚJ LETÖLTÉS\n' : '🆕 New download\n';
    }

    const storedFile = storedTorrent.files[fileIndex];
    const progress = storedFile?.progress ?? storedTorrent.progress;
    const percent = Math.min(100, Math.max(0, progress * 100));

    if (progress >= 0.999) {
      const ratioText = storedTorrent.ratio > 0 ? ` | ratio ${storedTorrent.ratio.toFixed(2)}` : '';
      return preferredLanguage === Language.HU
        ? `✅ HDD-RŐL INDUL${ratioText}\n`
        : `✅ Starts from HDD${ratioText}\n`;
    }

    return preferredLanguage === Language.HU
      ? `⬇️ ${percent.toFixed(1)}% MEGVAN A HDD-N\n`
      : `⬇️ ${percent.toFixed(1)}% already on HDD\n`;
  }

  private getStreamHealthLine({
    torrent,
    resolution,
    fileSize,
    preferredLanguage,
  }: {
    torrent: TorrentDetails;
    resolution: Resolution;
    fileSize: number;
    preferredLanguage: Language;
  }): string {
    const seeders = torrent.getSeeders();
    const seedText =
      preferredLanguage === Language.HU
        ? this.getHungarianSeedText(seeders)
        : this.getEnglishSeedText(seeders);

    const warnings: string[] = [];
    const isLarge4k = resolution === Resolution.R2160P && fileSize >= 45 * 1024 * 1024 * 1024;
    if (resolution === Resolution.R2160P && seeders < 3) {
      warnings.push(preferredLanguage === Language.HU ? '4K kevés seeddel' : '4K with few seeds');
    }
    if (isLarge4k) {
      warnings.push(preferredLanguage === Language.HU ? 'nagy 4K fájl' : 'large 4K file');
    }

    const warningText = warnings.length ? ` | ⚠️ ${warnings.join(', ')}` : '';
    return `${seedText}${warningText}\n`;
  }

  private getHungarianSeedText(seeders: number): string {
    if (seeders >= 20) {
      return `🌱 sok seed: ${seeders}`;
    }
    if (seeders >= 5) {
      return `🌱 jó seed: ${seeders}`;
    }
    if (seeders > 0) {
      return `⚠️ kevés seed: ${seeders}`;
    }
    return '⚠️ nincs látható seed';
  }

  private getEnglishSeedText(seeders: number): string {
    if (seeders >= 20) {
      return `🌱 many seeds: ${seeders}`;
    }
    if (seeders >= 5) {
      return `🌱 good seeds: ${seeders}`;
    }
    if (seeders > 0) {
      return `⚠️ few seeds: ${seeders}`;
    }
    return '⚠️ no visible seeds';
  }

  public async orderTorrents({
    torrents,
    user,
    season,
    episode,
    storedTorrents,
  }: {
    torrents: TorrentDetails[];
    user: User;
    season: number | undefined;
    episode: number | undefined;
    storedTorrents: TorrentResponse[];
  }): Promise<TorrentDetails[]> {
    const { preferredLanguage, preferredResolutions } = user;

    return rateList(torrents, [
      (torrent) => this.getStoredTorrentScore(torrent, storedTorrents),
      (torrent) => (preferredLanguage === torrent.getLanguage() ? 3 : 0),
      (torrent) => {
        const fileIndex = torrent.getMediaFileIndex({ season, episode });
        const file = torrent.files[fileIndex];
        if (!file) {
          return 0;
        }
        const resolution = torrent.getResolution(file.name);
        const preferredScore = preferredResolutions.includes(resolution) ? 2 : 0;
        return preferredScore + this.getResolutionHealthScore(torrent, resolution, file.length);
      },
      (torrent) =>
        this.getSeriesContinuityScore(torrent, { season, episode }, storedTorrents),
      (torrent) => this.getSeederScore(torrent),
    ]);
  }

  private getSeederScore(torrent: TorrentDetails): number {
    const seeders = torrent.getSeeders();
    if (seeders >= 50) {
      return 1.5;
    }
    if (seeders >= 20) {
      return 1.2;
    }
    if (seeders >= 5) {
      return 0.8;
    }
    if (seeders > 0) {
      return 0.25;
    }
    return -1;
  }

  private getResolutionHealthScore(
    torrent: TorrentDetails,
    resolution: Resolution,
    fileSize: number,
  ): number {
    if (resolution !== Resolution.R2160P) {
      return 0;
    }

    const seeders = torrent.getSeeders();
    let score = 0.75;
    if (seeders < 3) {
      score -= 2.5;
    } else if (seeders < 8) {
      score -= 0.75;
    } else if (seeders >= 20) {
      score += 0.75;
    }

    if (fileSize >= 70 * 1024 * 1024 * 1024) {
      score -= 1.25;
    } else if (fileSize >= 45 * 1024 * 1024 * 1024) {
      score -= 0.5;
    }

    return score;
  }

  private getSeriesContinuityScore(
    torrent: TorrentDetails,
    { season, episode }: { season: number | undefined; episode: number | undefined },
    storedTorrents: TorrentResponse[],
  ): number {
    if (!season || !episode) {
      return 0;
    }

    const fileIndex = torrent.getMediaFileIndex({ season, episode });
    const candidateFile = torrent.files[fileIndex];
    if (!candidateFile) {
      return 0;
    }

    const candidateKey = this.getSeriesSeasonKey(candidateFile.name, season);
    if (!candidateKey) {
      return 0;
    }

    const candidateReleaseGroup = this.getReleaseGroup(torrent.getName());
    let hasSameSeason = false;
    let hasSameReleaseGroup = false;

    for (const storedTorrent of storedTorrents) {
      const storedMediaFiles = storedTorrent.files.filter((file) =>
        this.isStoredMediaFile(file),
      );
      for (const storedFile of storedMediaFiles) {
        if (storedFile.progress <= 0.01) {
          continue;
        }
        if (this.getSeriesSeasonKey(storedFile.name, season) !== candidateKey) {
          continue;
        }
        hasSameSeason = true;
        if (
          candidateReleaseGroup &&
          this.getReleaseGroup(storedTorrent.name) === candidateReleaseGroup
        ) {
          hasSameReleaseGroup = true;
        }
      }
    }

    return (hasSameSeason ? 1.25 : 0) + (hasSameReleaseGroup ? 0.75 : 0);
  }

  private getSeriesSeasonKey(fileName: string, season: number): string | null {
    const normalized = fileName
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const seasonToken = `s${season.toString().padStart(2, '0')}`;
    const seasonIndex = normalized.indexOf(seasonToken);
    if (seasonIndex <= 0) {
      return null;
    }
    return `${normalized.slice(0, seasonIndex).trim()}|${seasonToken}`;
  }

  private getReleaseGroup(releaseName: string): string {
    const match = releaseName.match(/-([a-z0-9]+)$/i);
    return match?.[1]?.toLowerCase() ?? '';
  }

  private isStoredMediaFile(file: TorrentFileResponse): boolean {
    return /\.(mkv|mp4|avi|mov|m4v)$/i.test(file.name);
  }
  private getStoredTorrentScore(
    torrent: TorrentDetails,
    storedTorrents: TorrentResponse[],
  ): number {
    const storedTorrent = storedTorrents.find(
      (item) => item.infoHash.toLowerCase() === torrent.infoHash.toLowerCase(),
    );
    if (!storedTorrent) {
      return 0;
    }
    if (storedTorrent.progress >= 0.999) {
      return 8;
    }
    return 4;
  }
}
