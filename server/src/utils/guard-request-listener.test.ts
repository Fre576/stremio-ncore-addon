import { describe, it, expect } from 'vitest';
import { once } from 'node:events';
import { get, type Server } from 'node:http';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { guardedHttpServer } from './guarded-server';

const close = async (server: Server) => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
};

describe('request-local error containment', () => {
  it('contains both async listener rejection and synchronous throws', async () => {
    const server = guardedHttpServer({}, (request, response) => {
      if (request.url === '/async') {
        return Promise.resolve().then(() => {
          throw new Error('delayed response failure');
        });
      }
      if (request.url === '/sync') {
        throw new Error('request failure');
      }
      response.end('healthy');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const route of ['/async', '/sync']) {
        await expect(fetch(base + route)).rejects.toThrow();
        expect(await (await fetch(base + '/health')).text()).toBe('healthy');
      }
    } finally {
      await close(server);
    }
  });

  it('survives repeated real client disconnects while a response is streaming', async () => {
    const app = new Hono();
    app.get('/health', (c) => c.text('healthy'));
    app.get('/video', (c) => {
      const signal = c.req.raw.signal;
      let timer: ReturnType<typeof setInterval>;
      let ended = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setInterval(() => controller.enqueue(new Uint8Array(32768)), 2);
          signal.addEventListener('abort', () => {
            if (ended) return;
            ended = true;
            clearInterval(timer);
            controller.error(new Error('aborted'));
          }, { once: true });
        },
        cancel() {
          ended = true;
          clearInterval(timer);
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'video/x-matroska' } });
    });
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0, createServer: guardedHttpServer }) as Server;
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise<void>((resolve, reject) => {
          const request = get(base + '/video', (response) => {
            response.once('data', () => {
              response.destroy();
              request.destroy();
              resolve();
            });
          });
          request.on('error', reject);
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await (await fetch(base + '/health')).text()).toBe('healthy');
      }
    } finally {
      await close(server);
    }
  });
});
