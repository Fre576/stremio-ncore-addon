export type PlaybackStatus = {
  sessions: Array<{ ip: string; infoHash: string; quality: string; connections: number; releaseAfter?: string }>;
};

// Match the engine's conservative classification, including unknown = exclusive.
export function playbackQuality(name: string): '4k' | '1080p' {
  // UHD alone may be the source medium, not the output pixel resolution.
  if (/(^|[^a-z0-9])(2160[pi]?|4k)([^a-z0-9]|$)/i.test(name)) return '4k';
  return /(^|[^a-z0-9])(1080[pi]?|720p|576p|540p|480p)([^a-z0-9]|$)/i.test(name) ? '1080p' : '4k';
}

export function playbackAvailability(status: PlaybackStatus, ip: string, hash: string, quality: string) {
  const own = status.sessions.find((s) => s.ip.replace(/^::ffff:/, '') === ip.replace(/^::ffff:/, ''));
  if (own?.infoHash.toLowerCase() === hash.toLowerCase() && own.quality === quality)
    return { blocked: false, message: '▶ Saját lejátszás folytatása' };
  const others = status.sessions.filter((s) => s !== own);
  if (others.some((s) => s.quality === '4k'))
    return { blocked: true, message: '⛔ FOGLALT: másik készüléken 4K film fut. Várj a leállításáig.' };
  if (quality === '4k' && others.length)
    return { blocked: true, message: '⛔ FOGLALT: HD lejátszás fut. A 4K-hoz minden más lejátszást le kell állítani.' };
  if (others.length >= 2)
    return { blocked: true, message: '⛔ FOGLALT: mindkét HD hely foglalt. Várj egy hely felszabadulására.' };
  return { blocked: false, message: own ? '↪ Indításkor ezen a készüléken lecseréli a jelenlegi filmet.' :
    quality === '4k' ? '▶ Szabad: a 4K egyedül használja a szervert.' : `▶ Szabad HD hely: ${2 - others.length}/2` };
}
