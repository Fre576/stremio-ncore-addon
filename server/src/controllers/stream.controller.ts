import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamQuerySchema } from '@/schemas/stream.schema';
import type { TorrentService } from '@/services/torrent';
import type { StreamService } from '@/services/stream';
import type { UserService } from '@/services/user';
import type { TorrentStoreService } from '@/services/torrent-store';
import { playSchema } from '@/schemas/play.schema';
import { HttpStatusCode } from '@/types/http';
import type { TorrentSourceManager } from '@/services/torrent-source';
import { proxy } from 'hono/proxy';
import { getConnInfo } from '@hono/node-server/conninfo';
import { playbackAvailability, playbackQuality } from '@/utils/playback-availability';

export class StreamController {
  constructor(
    private torrentSource: TorrentSourceManager,
    private torrentService: TorrentService,
    private streamService: StreamService,
    private userService: UserService,
    private torrentStoreService: TorrentStoreService,
  ) {}

  public async getStreamsForMedia(c: Context) {
    const params = c.req.param();
    const result = streamQuerySchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: result.error.message,
      });
    }
    const { imdbId, type, episode, season, deviceToken } = result.data;

    const user = await this.userService.getUserByDeviceTokenOrThrow(deviceToken);

    const torrents = await this.torrentSource.getTorrentsForImdbId({
      imdbId,
      type,
      season,
      episode,
    });

    const storedTorrents = await this.torrentStoreService.getAllTorrents();

    const orderedTorrents = await this.streamService.orderTorrents({
      torrents,
      season,
      episode,
      user,
      storedTorrents,
    });

    const { preferredLanguage } = user;
    const capacity = await this.torrentStoreService.getPlaybackLimiterStatus().catch(() => null);
    const clientIP = getConnInfo(c).remote.address ?? '';

    const streams = orderedTorrents.map((torrent, i) =>
      this.streamService.convertTorrentToStream({
        torrent,
        isRecommended: i === 0,
        deviceToken,
        season,
        episode,
        preferredLanguage,
        storedTorrents,
      }),
    );

    streams.forEach((stream, i) => {
      const torrent = orderedTorrents[i]!;
      const file = torrent.files[torrent.getMediaFileIndex({season, episode})];
      const hint = capacity && clientIP ? playbackAvailability(capacity, clientIP, torrent.infoHash,
        playbackQuality(`${file?.name ?? ''} ${torrent.getName()}`)) :
        {blocked: false, message: '⚠ A szerver foglaltsága most nem ellenőrizhető.'};
      stream.name = hint.blocked ? 'nCore · FOGLALT' : 'nCore';
      stream.description = hint.message + '\n' + stream.description;
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ streams });
  }

  public async play(c: Context) {
    const params = c.req.param();
    const result = playSchema.safeParse(params);
    if (!result.success) {
      throw new HTTPException(HttpStatusCode.BAD_REQUEST, {
        message: result.error.message,
      });
    }
    const { sourceName, sourceId, infoHash, fileIdx } = result.data;

    let torrent = await this.torrentStoreService.getTorrent(infoHash);

    if (!torrent) {
      const torrentUrl = await this.torrentSource.getTorrentUrlBySourceId({
        sourceId,
        sourceName,
      });
      if (!torrentUrl) {
        throw new HTTPException(HttpStatusCode.NOT_FOUND, {
          message: 'Torrent not found',
        });
      }
      const torrentFilePath = await this.torrentService.downloadTorrentFile(torrentUrl);
      torrent = await this.torrentStoreService.addTorrent(torrentFilePath, { verify: false });
    }
    const file = torrent.files[Number(fileIdx)]!;
    const clientIP = getConnInfo(c).remote.address;
    if (!clientIP) {
      throw new HTTPException(HttpStatusCode.INTERNAL_SERVER_ERROR, {
        message: 'Cannot identify playback client IP',
      });
    }

    return proxy(
      this.torrentStoreService.getFileStreamingUrl({
        infoHash: torrent.infoHash,
        filePath: file.path,
      }),
      {
        method: c.req.method,
        signal: c.req.raw.signal,
        headers: { ...c.req.header(), 'x-stremio-client-ip': clientIP },
      },
    );
  }
}
