/**
 * The live line (#3472): one long-lived answer to GET /api/live per open screen, down which the server pushes the few
 * messages that tell a screen to show or drop something now, instead of the screen asking every 30 seconds.
 *
 * - Sign-in is checked once, when the line opens (the route's `authenticate`). After that the line holds NO database
 *   connection and sending on it reads nothing: a message is written from memory to the lines its sender picks. A
 *   person's lines close when their sign-in is thrown away (middleware/authenticate.ts clearTokenCache: a deactivation,
 *   a revoke, a role change, a sign-out), so the next line they open is checked again.
 * - A comment every 25 s keeps every hop between the browser and the server from timing the line out as idle. The server
 *   closes each line after about 55 minutes (spread over the last 5, so lines opened together never return together),
 *   and ends every line on shutdown; the screen reconnects after its own random wait, and re-reads once.
 * - At most LIVE_LINES_PER_PERSON lines per person and env.LIVE_LINES_MAX (default 2,000) per server. A refused screen
 *   keeps its 30-second checks.
 * - A line whose browser stopped reading is closed rather than allowed to pile up what it cannot send.
 *
 * ONE SERVER ONLY. The lines live in this process's memory, so a message reaches only the screens connected to the
 * server that sends it. Before a second backend server shares the database, these messages must go through Redis (or
 * another shared channel): each server subscribes and delivers to its own lines. Also in docs/architecture-reference.md
 * and backend/.env.example (LIVE_LINES_MAX).
 *
 * Logs carry ids and counts only.
 */
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { logger } from '../../lib/logger';
import { stopRequested } from '../../lib/graceful-stop';

/** A comment this often keeps every hop (the edge's idle limit is 100 s) from closing a quiet line. */
export const LIVE_KEEPALIVE_MS = 25_000;
/** The longest a line stays open; the server closes it, and the screen opens a new one. */
export const LIVE_LINE_MAX_MS = 55 * 60_000;
/** Each line closes at a random moment in the last this-many ms before LIVE_LINE_MAX_MS. */
const LIVE_LINE_SPREAD_MS = 5 * 60_000;
/** The most lines one person may hold open at once (tabs, windows). */
export const LIVE_LINES_PER_PERSON = 5;
/** What a refused screen is told to wait before it asks again. */
export const LIVE_RETRY_AFTER_S = 60;
/** Unsent bytes past which a line is taken to be one whose browser stopped reading. */
const LIVE_LINE_BACKLOG_BYTES = 256 * 1024;

/** Who holds a line: read once from their sign-in when it opened. */
export interface LivePerson {
  id: string;
  orgId: string;
  isAdmin: boolean;
}

export interface LiveRefusal {
  status: 429 | 503;
  reason: 'person_cap' | 'server_cap' | 'stopping' | 'gone';
}

interface Line {
  person: LivePerson;
  res: Response;
  keepAlive: NodeJS.Timeout;
  expiry: NodeJS.Timeout;
  closed: boolean;
}

const byPerson = new Map<string, Set<Line>>();
const byOrg = new Map<string, Set<Line>>();
let open = 0;

function add<K>(map: Map<K, Set<Line>>, key: K, line: Line): void {
  const set = map.get(key) ?? new Set<Line>();
  set.add(line);
  map.set(key, set);
}

function remove<K>(map: Map<K, Set<Line>>, key: K, line: Line): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(line);
  if (set.size === 0) map.delete(key);
}

function end(line: Line, why: 'closed_by_browser' | 'expired' | 'backlog' | 'signed_out' | 'shutdown'): void {
  if (line.closed) return;
  line.closed = true;
  clearInterval(line.keepAlive);
  clearTimeout(line.expiry);
  remove(byPerson, line.person.id, line);
  remove(byOrg, line.person.orgId, line);
  open -= 1;
  if (!line.res.writableEnded) line.res.end();
  // At info (ids and counts), so a deploy's reconnects and their spread can be read from the server log; a shutdown's
  // closes are one summary line instead (index.ts).
  const fields = { orgId: line.person.orgId, userId: line.person.id, why, open };
  if (why === 'shutdown') logger.debug('[live] line closed', fields);
  else logger.info('[live] line closed', fields);
}

/** Writes to one line; a line whose browser stopped reading is closed instead. True when written. */
function send(line: Line, chunk: string): boolean {
  if (line.closed) return false;
  if (line.res.writableLength > LIVE_LINE_BACKLOG_BYTES) {
    end(line, 'backlog');
    return false;
  }
  line.res.write(chunk);
  // A compression step would hold the bytes back; none is mounted, but if one ever is, it must let them through now.
  (line.res as { flush?: () => void }).flush?.();
  return true;
}

/** The line's first message: what the server says about itself to every screen that opens one (LIVE_HELLO). */
export const LIVE_HELLO = 'live.hello';

/**
 * Opens a line on this answer for a signed-in person, or says why not (the caller answers with the status). Nothing is
 * read from the database here or afterwards. `hello`, when given, is the line's first message (LIVE_HELLO): what this
 * server says about itself, for example whether Spider's check runs here, so the screen knows how often it still asks.
 */
export function openLiveLine(person: LivePerson, req: Request, res: Response, hello?: object): LiveRefusal | null {
  let refused: LiveRefusal | null = null;
  // The browser may have given up while its sign-in was being checked: its 'close' has already been and will not come
  // again, so a line registered now would count against the caps until it expired (50-55 minutes).
  if (res.destroyed || res.writableEnded || req.socket?.destroyed) return { status: 503, reason: 'gone' };
  if (stopRequested()) refused = { status: 503, reason: 'stopping' };
  else if ((byPerson.get(person.id)?.size ?? 0) >= LIVE_LINES_PER_PERSON) refused = { status: 429, reason: 'person_cap' };
  else if (open >= env.LIVE_LINES_MAX) refused = { status: 503, reason: 'server_cap' };
  if (refused) {
    logger.warn('[live] line refused', { orgId: person.orgId, userId: person.id, reason: refused.reason, open });
    return refused;
  }

  // The answer never ends on its own: no idle timeout on this socket, and every small write goes out at once.
  req.setTimeout(0);
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const line: Line = {
    person,
    res,
    closed: false,
    keepAlive: setInterval(() => send(line, ': k\n\n'), LIVE_KEEPALIVE_MS),
    expiry: setTimeout(() => end(line, 'expired'), LIVE_LINE_MAX_MS - Math.random() * LIVE_LINE_SPREAD_MS),
  };
  line.keepAlive.unref();
  line.expiry.unref();
  add(byPerson, person.id, line);
  add(byOrg, person.orgId, line);
  open += 1;
  res.on('close', () => end(line, 'closed_by_browser'));
  send(line, ': open\n\n');
  if (hello) send(line, `event: ${LIVE_HELLO}\ndata: ${JSON.stringify(hello)}\n\n`);
  logger.info('[live] line opened', { orgId: person.orgId, userId: person.id, open });
  return null;
}

/**
 * Sends one message to the lines of one company that `payloadFor` picks: it is asked once per person holding a line and
 * returns that person's payload, or null for nobody. Only that company's lines are ever asked. Returns how many lines it
 * was written to. In memory: no database read, whatever the number of lines.
 *
 * The transport only: Spider's messages go through services/spider/liveMessages.ts (publishSpiderLive), the one place
 * that decides who a Spider message is for.
 */
export function deliverLive(orgId: string, type: string, payloadFor: (person: LivePerson) => object | null): number {
  const lines = byOrg.get(orgId);
  if (!lines) return 0;
  const written = new Map<string, string | null>();
  let reached = 0;
  for (const line of [...lines]) {
    let chunk = written.get(line.person.id);
    if (chunk === undefined) {
      const payload = payloadFor(line.person);
      chunk = payload ? `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n` : null;
      written.set(line.person.id, chunk);
    }
    if (chunk && send(line, chunk)) reached += 1;
  }
  return reached;
}

/** Closes a person's lines (their sign-in was thrown away), or everyone's when no person is named. */
export function closeLiveLinesOf(userId?: string): void {
  const lines = userId === undefined ? [...byOrg.values()].flatMap((s) => [...s]) : [...(byPerson.get(userId) ?? [])];
  for (const line of lines) end(line, 'signed_out');
}

/** Ends every line cleanly (the server is stopping). Returns how many were open. */
export function endAllLiveLines(): number {
  const lines = [...byOrg.values()].flatMap((s) => [...s]);
  for (const line of lines) end(line, 'shutdown');
  return lines.length;
}

/** How many lines this server holds open now. */
export function liveLinesOpen(): number {
  return open;
}
