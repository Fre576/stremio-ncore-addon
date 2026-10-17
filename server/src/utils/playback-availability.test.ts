import { describe, expect, it } from 'vitest';
import { playbackAvailability as available, playbackQuality } from './playback-availability';
const s = (ip: string, quality = '1080p', infoHash = ip) => ({ip, quality, infoHash, connections: 1});
describe('source-list capacity hints', () => {
  it('admits empty server and two different HD IPs', () => {
    expect(available({sessions: []}, 'a', 'x', '4k').blocked).toBe(false);
    expect(available({sessions: [s('a')]}, 'b', 'x', '1080p').blocked).toBe(false);
    expect(available({sessions: [s('a'), s('b')]}, 'c', 'x', '1080p').blocked).toBe(true);
  });
  it('explains exclusive 4K and protects same-IP upgrades', () => {
    expect(available({sessions: [s('a', '4k')]}, 'b', 'x', '1080p').message).toContain('4K');
    expect(available({sessions: [s('a'), s('b')]}, 'a', 'new', '4k').blocked).toBe(true);
    expect(available({sessions: [s('a'), s('b')]}, 'a', 'new', '1080p').blocked).toBe(false);
  });
  it('normalizes mapped IPv4 and retains grace reservations', () => {
    expect(available({sessions: [s('::ffff:192.168.1.2', '1080p', 'ABC')]}, '192.168.1.2', 'abc', '1080p').message).toContain('folytatása');
    expect(available({sessions: [{...s('a', '4k'), connections: 0}]}, 'b', 'x', '1080p').blocked).toBe(true);
  });
  it('classifies UHD and unknown as exclusive, without substring false positives', () => {
    for (const name of ['movie.2160p.mkv', 'movie.UHD', 'unknown', 'book4kids']) expect(playbackQuality(name)).toBe('4k');
    expect(playbackQuality('movie.1080p.mkv')).toBe('1080p');
  });
});
