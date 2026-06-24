import { CATALOG_DEFINITIONS } from './catalog-definitions';
import { StreamType } from '@/schemas/stream.schema';
import type { CinemeatService } from '@/services/cinemeta';
import type { TorrentSourceManager } from '@/services/torrent-source';
import type { TorrentCatalogItem } from '@/services/torrent-source/types';

const NCORE_META_ID_PREFIX = 'ncore-';

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
  videos?: Array<{ id: string; [key: string]: unknown }>;
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

    const ncoreImdbId = this.fromNcoreMetaId(imdbId);
    if (!ncoreImdbId) {
      return { meta: null };
    }

    try {
      const { meta } = await this.cinemetaService.getMetadataByImdbId(
        normalizedType,
        ncoreImdbId,
      );
      return {
        meta: this.withNcoreMetaIds({
          ...meta,
          id: this.toNcoreMetaId(meta.imdb_id),
          type: normalizedType,
          name: meta.name,
        }),
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
      return this.withNcoreMetaIds({
        ...meta,
        id: this.toNcoreMetaId(meta.imdb_id),
        type: item.type,
        name: meta.name,
        description: meta.description ?? item.releaseName,
      });
    } catch {
      return {
        id: this.toNcoreMetaId(item.imdbId),
        type: item.type,
        name: item.fallbackTitle,
        description: item.releaseName,
      };
    }
  }

  private toNcoreMetaId(imdbId: string): string {
    return imdbId.startsWith(NCORE_META_ID_PREFIX)
      ? imdbId
      : `${NCORE_META_ID_PREFIX}${imdbId}`;
  }

  private fromNcoreMetaId(value: string): string | null {
    const normalized = this.stripJsonSuffix(value);
    if (!normalized.startsWith(NCORE_META_ID_PREFIX)) {
      return null;
    }
    const imdbId = normalized.slice(NCORE_META_ID_PREFIX.length);
    return /^tt\d+$/.test(imdbId) ? imdbId : null;
  }

  private withNcoreMetaIds(meta: CatalogMeta): CatalogMeta {
    return {
      ...meta,
      id: this.toNcoreMetaId(meta.id),
      videos: meta.videos?.map((video) => ({
        ...video,
        id: video.id.startsWith(NCORE_META_ID_PREFIX)
          ? video.id
          : `${NCORE_META_ID_PREFIX}${video.id}`,
      })),
    };
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
