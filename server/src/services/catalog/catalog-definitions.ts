import { StreamType } from '@/schemas/stream.schema';

export const CATALOG_DEFINITIONS = [
  {
    type: StreamType.MOVIE,
    id: 'ncore-search-movies',
    name: 'nCore - Keresés filmek',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false },
    ],
  },
  {
    type: StreamType.TV_SHOW,
    id: 'ncore-search-series',
    name: 'nCore - Keresés sorozatok',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false },
    ],
  },
  {
    type: StreamType.MOVIE,
    id: 'ncore-recent-hu-4k',
    name: 'nCore - Friss magyar 4K',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false },
    ],
  },
  {
    type: StreamType.MOVIE,
    id: 'ncore-recent-hu-1080p',
    name: 'nCore - Friss magyar 1080p',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false },
    ],
  },
  {
    type: StreamType.TV_SHOW,
    id: 'ncore-recent-hu-series',
    name: 'nCore - Friss magyar sorozatok',
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false },
    ],
  },
] as const;

export type CatalogDefinitionId = (typeof CATALOG_DEFINITIONS)[number]['id'];
