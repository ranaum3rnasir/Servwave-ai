/**
 * The URL parser Express's router uses on every request (express 4 depends on it). The price filter reads the request's
 * path with it, so the filter and the router can never read an address differently (lib/permissions/prices.ts).
 */
declare module 'parseurl' {
  import type { Url } from 'url';

  /** What the parser reads off a request: its `url`, and its `originalUrl` when Express has set one. */
  interface ParsableRequest {
    url?: string;
    originalUrl?: string;
  }
  interface ParseUrl {
    (req: ParsableRequest): Url | undefined;
    original(req: ParsableRequest): Url | undefined;
  }
  const parseurl: ParseUrl;
  export default parseurl;
}
