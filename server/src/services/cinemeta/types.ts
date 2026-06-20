import { StreamType } from '@/schemas/stream.schema';

export interface CinemetaResponse {
  meta: {
    imdb_id: string;
    name: string;
    type: StreamType;
    poster?: string;
    background?: string;
    logo?: string;
    description?: string;
    releaseInfo?: string;
    genres?: string[];
  };
}
