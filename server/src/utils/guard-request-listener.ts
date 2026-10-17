import type { RequestListener, ServerResponse } from 'node:http';

/** Node's request emitter does not consume rejected async listener promises. */
export const guardRequestListener = (listener: RequestListener): RequestListener => {
  return (request, response) => {
    const fail = (error: unknown) => {
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      const aborted = request.destroyed || response.destroyed || code === 'ECONNRESET' || code === 'ERR_STREAM_PREMATURE_CLOSE';
      const details = { method: request.method, code, name: error instanceof Error ? error.name : 'UnknownError' };
      if (aborted) {
        console.info('http_response_aborted', details);
      } else {
        console.error('http_response_failed', details);
      }
      closeResponse(response);
    };
    try {
      void Promise.resolve(listener(request, response)).catch(fail);
    } catch (error) {
      fail(error);
    }
  };
};

const closeResponse = (response: ServerResponse) => {
  if (!response.destroyed) {
    // An error may arrive after the streaming adapter removed its own handlers.
    response.once('error', () => {});
    response.destroy();
  }
};
