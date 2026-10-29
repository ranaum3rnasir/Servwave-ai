/**
 * Mobile slice 75 follow-up: no WebSocket to the auth provider on a signed-in route.
 *
 * The notification bell used to hold a live subscription to the provider's realtime service. When
 * that socket fails (a filtering network, a laptop that slept, a refused origin) every browser
 * prints the full address of the socket in the console, and the address names the vendor: page code
 * cannot suppress the line. The bell now polls (30 s, paused while the tab is hidden, refetch on
 * focus), and the realtime client is swapped for an inert one in the build, so no page can open the
 * socket by accident.
 *
 * Every project, on the routes selected from `home` and `customers`: sign in, open the page, wait
 * for the bell, leave the page alone for a few seconds, and assert that no WebSocket was created
 * whose host is the provider's. A control socket (a local handshake-only server) proves the recorder
 * is listening, so the check cannot pass because it saw nothing.
 */
import { expect, type WebSocket } from '@playwright/test';
import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';
import { settle } from './measure';
import { selectStates } from './routes';
import { ORG_FILE } from './paths';
import { authStorageKey, keepSession, signIn, supabaseUrl, test } from './session';

/** A server that accepts a WebSocket handshake and nothing more: the recorder's positive control. */
async function startControlSocket() {
  const server = http.createServer((_req, res) => res.end('control'));
  const upgraded = new Set<Duplex>(); // an upgraded socket is no longer the server's: close() would wait on it forever
  server.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {});
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`, close: () => new Promise<void>((ok) => { upgraded.forEach((sk) => sk.destroy()); server.closeAllConnections(); server.close(() => ok()); }) };
}

const selected = new Set(selectStates().map((s) => s.id));
const ROUTES: Array<{ id: string; path: string }> = [
  { id: 'home', path: '/' },
  { id: 'customers', path: '/customers' },
];

for (const route of ROUTES) {
  test(`${route.id}: the signed-in page opens no socket to the auth provider`, async ({ page, session }) => {
    test.skip(!selected.has(route.id), `MOBILE_GATE_ROUTES does not select ${route.id}`);
    const providerHost = new URL(supabaseUrl()).hostname;
    const control = await startControlSocket();
    const sockets: string[] = [];
    page.on('websocket', (ws: WebSocket) => sockets.push(ws.url()));
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto(route.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await expect(page.getByRole('button', { name: 'Notifications' }).first()).toBeVisible({ timeout: 30_000 });
      // The old subscription was created on the bell's mount and opened its socket at once; give
      // it, and any late-mounting code, time to show itself.
      await page.waitForTimeout(6_000);

      // Control: the recorder sees a socket when the page opens one. The test serves a bare
      // handshake on a free local port, so the control needs nothing else and behaves the same on
      // every engine (a socket the engine cannot connect is not always reported by WebKit).
      await page.evaluate((url) => { new WebSocket(url); }, control.url);
      await expect.poll(() => sockets.some((u) => u.startsWith(control.url)), { message: 'the recorder must see a socket opened by the page', timeout: 10_000 }).toBe(true);

      // Report host and path only: the socket address carries the public key in its query string.
      const toProvider = sockets
        .filter((u) => {
          try { return new URL(u).hostname === providerHost; } catch { return false; }
        })
        .map((u) => { const x = new URL(u); return `${x.protocol}//${x.hostname}${x.pathname}`; });
      expect(toProvider, `sockets opened to the auth provider on ${route.path}`).toEqual([]);
    } finally {
      await keepSession(page, session).catch(() => {});
      await control.close();
    }
  });
}

/**
 * Auth keeps working with the realtime client swapped for an inert one: the real sign-in form,
 * a token refresh and a sign-out all complete, and still no socket is opened to the provider.
 *
 * Own login, own session (never the worker's shared one), so the refresh does not fork anyone
 * else's token chain; the sign-out requests are answered by the test (the shared throwaway admin
 * is not signed out globally), which is enough for the app to run its whole local sign-out path
 * (the library broadcasts SIGNED_OUT, which used to re-authorise the socket). Desktop control only:
 * the account menu is a dropdown there, a drawer on phones.
 */
test('sign-in, token refresh and sign-out work and open no socket to the auth provider', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the account menu is a dropdown on the desktop project only');
  const org = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
  const providerHost = new URL(supabaseUrl()).hostname;
  const sockets: string[] = [];
  page.on('websocket', (ws: WebSocket) => sockets.push(ws.url()));
  await page.route(/\/auth\/v1\/logout/, (route) => route.fulfill({ status: 204, body: '' }));
  await page.route(/\/api\/auth\/logout/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  const toProvider = () => sockets.filter((u) => { try { return new URL(u).hostname === providerHost; } catch { return false; } });
  const key = authStorageKey();
  const stored = () => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null'); } catch { return null; } }, key);

  // Sign in through the real form.
  await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.getByLabel('Email').fill(org.adminEmail);
  await page.locator('#password').fill(org.adminPassword);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Notifications' }).first()).toBeVisible({ timeout: 45_000 });
  const first = await stored();
  expect(first?.access_token, 'the form signed in and the session is stored').toBeTruthy();

  // Refresh: make the stored session look expired and wake the library the way a tab coming back
  // to the foreground does; it must fetch a new token (TOKEN_REFRESHED).
  await page.evaluate((k) => {
    const s = JSON.parse(localStorage.getItem(k) ?? '{}');
    s.expires_at = Math.floor(Date.now() / 1000) - 5;
    localStorage.setItem(k, JSON.stringify(s));
    document.dispatchEvent(new Event('visibilitychange'));
  }, key);
  await expect.poll(async () => (await stored())?.access_token, { message: 'the session refreshed to a new token', timeout: 30_000 }).not.toBe(first.access_token);
  await expect(page.getByRole('button', { name: 'Notifications' }).first()).toBeVisible();

  // Sign out through the account menu.
  await page.locator('[data-slot="topbar-user"]').click();
  await page.getByRole('menuitem', { name: 'Sign Out' }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  expect(await stored(), 'the stored session is gone after sign-out').toBeNull();

  expect(toProvider().map((u) => { const x = new URL(u); return `${x.protocol}//${x.hostname}${x.pathname}`; }), 'sockets opened to the auth provider across sign-in, refresh and sign-out').toEqual([]);
});
