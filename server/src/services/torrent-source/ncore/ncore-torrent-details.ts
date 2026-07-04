import {
  TorrentDetails,
  type ParsedTorrentDetails,
  type TorrentFileDetails,
} from '../types';
import type { NcoreTorrent } from './types';
import type { TorrentCategory } from './constants';
import {
  HUNGARIAN_CATEGORIES,
  MovieCategory,
  NcoreResolution,
  ncoreResolutionLabels,
  SeriesCategory,
} from './constants';
import { Language, Resolution } from '@/db/schema/users';

export type CachedNcoreTorrentDetails = {
  ncoreTorrent: NcoreTorrent;
  parsedDetails: ParsedTorrentDetails;
  isSpeculated?: boolean;
};

export class NcoreTorrentDetails extends TorrentDetails {
  public sourceName: string;
  public sourceId: string;
  public infoHash: string;
  public fallbackResolution: Resolution;
  public files: TorrentFileDetails[];
  /** If true, then this torrent might not belong to the searched movie/show. */
  public isSpeculated?: boolean = false;

  private category: TorrentCategory;
  private release_name: string;
  private seeders: number;

  constructor(ncoreTorrent: NcoreTorrent, parsedDetails: ParsedTorrentDetails) {
    super();
    this.sourceName = 'ncore';
    this.sourceId = ncoreTorrent.torrent_id;
    this.infoHash = parsedDetails.infoHash;
    this.files = parsedDetails.files;
    this.fallbackResolution = ['xvid', 'xvid_hun', 'xvidser', 'xvidser_hun'].includes(
      ncoreTorrent.category,
    )
      ? Resolution.R480P
      : Resolution.R720P;
    this.category = ncoreTorrent.category;
    this.release_name = ncoreTorrent.release_name;
    this.seeders = ncoreTorrent.seeders;
  }

  public toCacheRecord(): CachedNcoreTorrentDetails {
    return {
      ncoreTorrent: {
        torrent_id: this.sourceId,
        category: this.category,
        release_name: this.release_name,
        details_url: '',
        download_url: '',
        freeleech: false,
        imdb_id: '',
        imdb_rating: 0,
        size: `${this.files.reduce((sum, file) => sum + file.length, 0)}`,
        type: 'movie',
        leechers: '0',
        seeders: this.seeders,
      },
      parsedDetails: {
        infoHash: this.infoHash,
        files: this.files,
      },
      isSpeculated: this.isSpeculated,
    };
  }

  public static fromCacheRecord(record: CachedNcoreTorrentDetails): NcoreTorrentDetails {
    const torrent = new NcoreTorrentDetails(record.ncoreTorrent, record.parsedDetails);
    torrent.isSpeculated = record.isSpeculated;
    return torrent;
  }

  public displayResolution(resolution: Resolution): string {
    return `${ncoreResolutionLabels[this.getNcoreResolutionByCategory(this.category)]} (${resolution})`;
  }

  public getName(): string {
    return this.release_name;
  }

  public getLanguage(): Language {
    return HUNGARIAN_CATEGORIES.includes(this.category) ? Language.HU : Language.EN;
  }

  public getSeeders(): number {
    return this.seeders;
  }

  private getNcoreResolutionByCategory = (category: TorrentCategory): NcoreResolution => {
    switch (category) {
      case MovieCategory.SD_HUN:
      case MovieCategory.SD:
        return NcoreResolution.SD;
      case MovieCategory.DVD_HUN:
      case MovieCategory.DVD:
        return NcoreResolution.DVD;
      case MovieCategory.DVD9_HUN:
      case MovieCategory.DVD9:
        return NcoreResolution.DVD9;
      case MovieCategory.HD_HUN:
      case MovieCategory.HD:
        return NcoreResolution.HD;
      case SeriesCategory.SD_HUN:
      case SeriesCategory.SD:
        return NcoreResolution.SD;
      case SeriesCategory.DVD_HUN:
      case SeriesCategory.DVD:
        return NcoreResolution.DVD;
      case SeriesCategory.HD_HUN:
      case SeriesCategory.HD:
        return NcoreResolution.HD;
    }
  };
}
