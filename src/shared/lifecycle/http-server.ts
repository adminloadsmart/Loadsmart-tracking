import type { Server } from 'http';

/** Resolves once the server is listening; rejects on bind errors (e.g. EADDRINUSE). */
export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * Stops accepting new connections, then closes idle keep-alive sockets so close() doesn't wait
 * for clients to time them out. In-flight requests still finish (bounded by the process-level
 * shutdown timeout in entrypoints/main.ts).
 */
export function closeServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
    server.closeIdleConnections();
  });
}
