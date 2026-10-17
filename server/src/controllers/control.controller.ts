import { request } from 'node:http';
import type { Context } from 'hono';

// A root-owned, local Unix socket. No privileged service is published on TCP.
export async function controlRequest(c: Context, method: 'GET' | 'POST', path: string) {
  if (method === 'POST') {
    if (c.req.header('origin') !== new URL(c.req.url).origin)
      return c.json({error: 'Érvénytelen kérési eredet.'}, 403);
    if (!c.req.header('content-type')?.startsWith('application/json'))
      return c.json({error: 'JSON szükséges.'}, 415);
  }
  const body = method === 'POST' ? await c.req.text() : '';
  if (Buffer.byteLength(body) > 4096) return c.json({error: 'Túl nagy kérés.'}, 413);
  try {
    const result = await new Promise<{status: number; body: string}>((resolve, reject) => {
      const req = request({socketPath: '/run/stremio-control/control.sock', path, method,
        headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)}, timeout: 5000}, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; if (data.length > 2_000_000) res.destroy(); });
        res.on('end', () => resolve({status: res.statusCode ?? 502, body: data}));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('control_timeout')));
      req.on('error', reject);
      req.end(body);
    });
    c.header('Cache-Control', 'no-store');
    return new Response(result.body, {status: result.status, headers: {'Content-Type': 'application/json', 'Cache-Control': 'no-store'}});
  } catch {
    return c.json({error: 'Az állapotfigyelő nem érhető el. A filmkiszolgáló ettől még működhet.'}, 503);
  }
}
