import { z } from 'zod';

export enum StreamType {
  MOVIE = 'movie',
  TV_SHOW = 'series',
}

const ncorePrefix = 'ncore-';
const mediaIdSchema = z
  .string()
  .endsWith('.json')
  .refine((value) => /^(ncore-)?tt\d+(?::\d+:\d+)?\.json$/.test(value), {
    message: 'Invalid media id',
  });

const stripNcorePrefix = (value: string) =>
  value.startsWith(ncorePrefix) ? value.slice(ncorePrefix.length) : value;

export const streamQuerySchema = z
  .object({ deviceToken: z.string() })
  .and(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal(StreamType.MOVIE),
        imdbId: mediaIdSchema.refine((value) => /^(ncore-)?tt\d+\.json$/.test(value), {
          message: 'Movie ID contains season or episode numbers',
        }),
      }),
      z.object({
        type: z.literal(StreamType.TV_SHOW),
        imdbId: mediaIdSchema.refine(
          (value) => /^(ncore-)?tt\d+:\d+:\d+\.json$/.test(value),
          { message: "IMDB ID doesn't contain season and episode numbers" },
        ),
      }),
    ]),
  )
  .transform((data) => {
    const normalizedId = stripNcorePrefix(data.imdbId.replace('.json', ''));
    if (data.type === StreamType.TV_SHOW) {
      const [imdbId, season, episode] = normalizedId.split(':') as [
        string,
        string,
        string,
      ];
      return {
        ...data,
        imdbId,
        season: parseInt(season),
        episode: parseInt(episode),
      };
    }
    return {
      ...data,
      imdbId: normalizedId,
      season: undefined,
      episode: undefined,
    };
  });

export type StreamQuery = z.infer<typeof streamQuerySchema>;
