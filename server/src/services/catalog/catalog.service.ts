import { CATALOG_DEFINITIONS } from './catalog-definitions';
import { StreamType } from '@/schemas/stream.schema';
import type { CinemeatService } from '@/services/cinemeta';
import type { TorrentSourceManager } from '@/services/torrent-source';
import type { TorrentCatalogItem } from '@/services/torrent-source/types';

type CatalogMeta = {
  id: string;
  type: StreamType;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
};

export class CatalogService {
  constructor(
    private torrentSource: TorrentSourceManager,
    private cinemetaService: CinemeatService,
  ) {}

  public getCatalogDefinitions() {
    return CATALOG_DEFINITIONS;
  }

  public async getCatalogMetas({
    type,
    catalogId,
    extra,
  }: {
    type: string;
    catalogId: string;
    extra?: string;
  }): Promise<{ metas: CatalogMeta[] }> {
    const normalizedType = this.normalizeType(type);
    const normalizedCatalogId = this.stripJsonSuffix(catalogId);
    if (!normalizedType) {
      return { metas: [] };
    }

    const catalog = CATALOG_DEFINITIONS.find(
      (definition) =>
        definition.id === normalizedCatalogId && definition.type === normalizedType,
    );
    if (!catalog) {
      return { metas: [] };
    }

    const extras = this.parseExtra(extra);
    const items = await this.torrentSource.getCatalogItems({
      type: normalizedType,
      catalogId: catalog.id,
      search: extras.search,
      skip: Number(extras.skip ?? 0),
      limit: 24,
    });

    const metas = await Promise.all(items.map((item) => this.toCatalogMeta(item)));
    return { metas };
  }

  public async getMeta({
    type,
    imdbId,
  }: {
    type: string;
    imdbId: string;
  }): Promise<{ meta: CatalogMeta | null }> {
    const normalizedType = this.normalizeType(type);
    if (!normalizedType) {
      return { meta: null };
    }

    const normalizedImdbId = this.stripJsonSuffix(imdbId);
    try {
      const { meta } = await this.cinemetaService.getMetadataByImdbId(
        normalizedType,
        normalizedImdbId,
      );
      return {
        meta: {
          ...meta,
          id: meta.imdb_id,
          type: normalizedType,
          name: meta.name,
        },
      };
    } catch (error) {
      console.error('Failed to get catalog meta from Cinemeta', error);
      return { meta: null };
    }
  }

  private async toCatalogMeta(item: TorrentCatalogItem): Promise<CatalogMeta> {
    try {
      const { meta } = await this.cinemetaService.getMetadataByImdbId(
        item.type,
        item.imdbId,
      );
      return {
        ...meta,
        id: meta.imdb_id,
        type: item.type,
        name: meta.name,
        description: meta.description ?? item.releaseName,
      };
    } catch {
      return {
        id: item.imdbId,
        type: item.type,
        name: item.fallbackTitle,
        description: item.releaseName,
      };
    }
  }

  private normalizeType(type: string): StreamType | null {
    if (type === StreamType.MOVIE || type === StreamType.TV_SHOW) {
      return type;
    }
    return null;
  }

  private stripJsonSuffix(value: string): string {
    return value.replace(/\.json$/, '');
  }

  private parseExtra(extra?: string): Record<string, string> {
    if (!extra) {
      return {};
    }
    const normalizedExtra = this.stripJsonSuffix(extra);
    return Object.fromEntries(new URLSearchParams(normalizedExtra));
  }
}
