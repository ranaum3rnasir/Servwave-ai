// Stand-ins for the data clients (and the realtime client) the app never uses, aliased in place of
// their packages in vite.config.ts (`resolve.alias`), as `node-module-browser-shim.ts` does for
// `module`.
//
// Why this exists (mobile slice 61, round 2, PERF-02): the browser auth/realtime client is an
// umbrella package. Its constructor builds a database client, a file-storage client and a
// functions client eagerly, so all three ship in the staff app's first download (about 47 KB of
// minified source, 12 KB gzipped) although the app only ever uses `supabase.auth` and the
// realtime channels (`src/lib/supabase.ts`; every data call goes through our own API). Being
// built eagerly, they are not removed by tree-shaking, so the packages themselves are swapped for
// inert classes with the same export names.
//
// The constructors do nothing; any later use (`supabase.from(...)`, `supabase.storage...`,
// `supabase.functions...`) throws a plain message in place of a confusing "x is not a function".
// `src/__tests__/unused-data-clients.test.ts` fails if source starts using one, so the shim cannot
// be stepped on silently. If the app ever needs one, delete its alias and this export.
// Every export of the three packages that the umbrella package imports must exist here: the build
// fails on a missing one, which is how an upgrade that starts using another export is caught.

const unavailable = (): never => {
  throw new Error('This data client is not part of the app build.');
};

/** An instance whose every property is a function that throws when called. */
function inert(): object {
  return new Proxy({}, { get: () => unavailable });
}

class InertClient {
  constructor() {
    return inert() as InertClient;
  }
}

// functions client
export class FunctionsClient extends InertClient {}
export class FunctionsError extends Error {}
export class FunctionsFetchError extends FunctionsError {}
export class FunctionsHttpError extends FunctionsError {}
export class FunctionsRelayError extends FunctionsError {}
export const FunctionRegion = {} as Record<string, string>;

// database client
export class PostgrestClient extends InertClient {}
export class PostgrestError extends Error {}

// file-storage client
export class StorageClient extends InertClient {}
export class StorageApiError extends Error {}

// realtime client (mobile slice 75 follow-up). The notification bell polls, so the app opens no
// socket to the auth provider: a failed socket makes every browser print the provider's address in
// the console, which page code cannot suppress. The umbrella package constructs this client and
// calls `setAuth` on it on every sign-in, token refresh and sign-out, so those methods must be
// harmless no-ops (auth keeps working); anything that would open a channel throws the plain
// message. `connect` never opens a socket. `src/__tests__/unused-data-clients.test.ts` fails if
// source starts using a channel.
export class RealtimeClient {
  constructor(..._args: unknown[]) {}
  setAuth(_token?: string | null): Promise<void> {
    return Promise.resolve();
  }
  connect(): void {}
  disconnect(): Promise<'ok'> {
    return Promise.resolve('ok');
  }
  getChannels(): unknown[] {
    return [];
  }
  removeChannel(_channel: unknown): Promise<'ok'> {
    return Promise.resolve('ok');
  }
  removeAllChannels(): Promise<'ok'[]> {
    return Promise.resolve([]);
  }
  channel(_topic: string, _params?: unknown): never {
    return unavailable();
  }
}
