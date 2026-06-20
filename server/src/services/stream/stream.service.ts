import type { Stream } from 'stremio-addon-sdk';
import type { TorrentDetails } from '../torrent-source';
import type { TorrentFileDetails } from '../torrent-source/types';
import type { TorrentResponse } from '../torrent-store/types';
import { languageEmojiMap } from './constants';
import { rateList } from '@/utils/rate-list';
import { formatBytes } from '@/utils/bytes';
import { ConfigService } from '../config';
import { UserService } from '../user';
import { User } from '@/types/user';
import { Language } from '@/db/schema/users';

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
    const typeLine = `${languageEmoji} | ${torrent.displayResolution(torrent.getResolution(file.name))} | ${fileSizeString}\n`;
    const title = isShow ? `${file.name}\n` : `${torrent.getName()}\n`;
    const seeders = `⬆️ ${torrent.getSeeders()}\n`;
    return downloadStatusLine + warningLine + recommendedLine + typeLine + title + seeders;
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
        ? `✅ MEGVAN${ratioText}\n`
        : `✅ Downloaded${ratioText}\n`;
    }

    return preferredLanguage === Language.HU
      ? `⬇️ ${percent.toFixed(1)}% LETÖLTVE\n`
      : `⬇️ ${percent.toFixed(1)}% downloaded\n`;
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
        const resolution = torrent.getResolution(torrent.files[fileIndex]!.name);
        return preferredResolutions.includes(resolution) ? 2 : 0;
      },
    ]);
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
