import { createServer as httpServer, type RequestListener, type ServerOptions } from 'node:http';
import { createServer as httpsServer, type ServerOptions as HttpsOptions } from 'node:https';
import { guardRequestListener } from './guard-request-listener';

// The Hono adapter always supplies both arguments. Preserve the public overloads.
export const guardedHttpServer = ((options: ServerOptions, listener: RequestListener) =>
  httpServer(options, guardRequestListener(listener))) as typeof httpServer;

export const guardedHttpsServer = ((options: HttpsOptions, listener: RequestListener) =>
  httpsServer(options, guardRequestListener(listener))) as typeof httpsServer;
