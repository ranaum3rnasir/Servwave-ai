/* =============================================================================
   A supertest target that can only be this app.

   supertest's request(app) listens on port 0 of the IPv6 wildcard (::) and then calls
   127.0.0.1:<port>. On macOS the kernel can hand that wildcard listener a port another process
   already holds on 127.0.0.1 alone, and the more specific listener wins: the test talks to the
   other process. A local dev server or preview answers 500 with no body, so a real-DB suite
   failed now and then with a 500 that no route of this app produced (none logged an error).

   Listening on 127.0.0.1 itself lets the kernel pick only a port that is free there, so
   127.0.0.1:<port> is always this app. Pass the returned server to request() and close it in
   afterAll.
   ========================================================================== */

import { createServer, type RequestListener, type Server } from 'http';
import type { AddressInfo } from 'net';

export async function listenOnLoopback(app: RequestListener): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer(app).listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (address?.address !== '127.0.0.1') reject(new Error(`expected a 127.0.0.1 listener, got ${JSON.stringify(address)}`));
      else resolve(server);
    });
    server.on('error', reject);
  });
}

export function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
