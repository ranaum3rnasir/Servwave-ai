/**
 * Payments go-live slice 34 - the one embedded-components session behind the owner-only "Payout account &
 * verification" page.
 *
 * The session lives at module scope on purpose. The embedded components ask the owner for a verification code
 * sent by text the first time they load; leaving the page and coming back must reuse the session instead
 * of starting a new one (a new one asks again). So the page never calls `logout()` on unmount. The ONLY thing
 * that ends the session is ServWave sign-out: `resetAccountScopedStores()` runs from the auth store's logout(),
 * and the reset registered below calls the components' own `logout()` then.
 *
 * `/pure`: the default entry fetches the processor's script the moment this module is imported, i.e. on every
 * visit to Settings, and the browser then writes console lines naming the processor. The pure entry fetches it
 * only when the owner actually opens the payout page (the first `getPayoutConnect()` call).
 */
import { loadConnectAndInitialize } from '@stripe/connect-js/pure';
import api from '@/lib/axios';
import { registerSignInHook, registerStoreReset } from '@/lib/storeReset';

type ConnectInstance = ReturnType<typeof loadConnectAndInitialize>;

let instance: ConnectInstance | null = null;
let viewerInstance: ConnectInstance | null = null;
/** Watches <body> after sign-out for frames the processor library mounts late; stopped when a new session starts. */
let frameWatcher: MutationObserver | null = null;

/** Slice 33b: the watcher is a clean-up after sign-out, not a permanent observer; it gives up after this long. */
const FRAME_WATCH_MS = 30_000;
let frameWatchTimer: ReturnType<typeof setTimeout> | null = null;

function stopFrameWatcher(): void {
  frameWatcher?.disconnect();
  frameWatcher = null;
  if (frameWatchTimer) clearTimeout(frameWatchTimer);
  frameWatchTimer = null;
}

/** `rgb(...)` / `#rrggbb` / "12 45 58" channel triple -> "#rrggbb", or null when it is none of those. */
function toHex(raw: string): string | null {
  const v = raw.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex?.[1]) return `#${hex[1].toLowerCase()}`;
  const channels = /^(?:rgb\(\s*)?(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*\)?$/i.exec(v);
  if (!channels) return null;
  const parts = channels.slice(1, 4).map((n) => Math.min(255, Number(n)));
  return `#${parts.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The value of a design token as a concrete colour. Our tokens are channel triples used as
 * `rgb(var(--primary))`; the embedded components' script rejects that as an invalid colour (it never sees our
 * stylesheet), so it is handed the resolved value.
 */
export function resolveColorToken(name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
    return toHex(raw) ?? (toHex(fallback) as string);
  } catch {
    return toHex(fallback) as string;
  }
}

/**
 * The element whose tokens the embedded components should match: the v2 app frame (`.app`, which owns the kit's face and
 * its graded radius), or the document root where there is no frame (a legacy page, a test).
 */
function appRoot(): Element {
  try {
    return document.querySelector('.app') ?? document.documentElement;
  } catch {
    return document.documentElement;
  }
}

/** The app's own font family: the first face the frame paints with, then the system faces. Never a hard-coded name. */
export function appFontFamily(): string {
  const FALLBACK = 'Figtree';
  try {
    const declared = getComputedStyle(appRoot()).fontFamily;
    const first = /^\s*("[^"]+"|'[^']+'|[^,]+)/.exec(declared)?.[1]?.trim();
    return `${first || FALLBACK}, system-ui, sans-serif`;
  } catch {
    return `${FALLBACK}, system-ui, sans-serif`;
  }
}

/** A length token of the app frame as pixels ("0.75rem" -> "12px"), or the fallback when it cannot be read. */
function appLengthToken(name: string, fallbackPx: number): string {
  try {
    const root = appRoot();
    const raw = (getComputedStyle(root).getPropertyValue(name) || (root as HTMLElement).style?.getPropertyValue(name) || '').trim();
    const match = /^(\d*\.?\d+)(px|rem)$/.exec(raw);
    if (match) return `${Math.round(Number(match[1]) * (match[2] === 'rem' ? 16 : 1) * 100) / 100}px`;
  } catch {
    /* fall through to the fallback */
  }
  return `${fallbackPx}px`;
}

/**
 * The options the embedded components are drawn with, so the viewer surface (Documents) and the owner surface (payout
 * account) read as ServWave. Only these appearance options are set; layout, columns and wording cannot be changed:
 *  - colours: primary, text, secondary text, danger, border, and the four badge colour sets (from the status tokens);
 *  - fonts: family from the app frame, base size 14px (see `connectFor` for the face that is loaded);
 *  - shape: general, button and form radius from the app's control-radius token; badge radius 4px (the kit's small chip);
 *  - spacing: button padding 12/8, badge padding 8/4, table row padding 10 (the kit table's cell padding).
 */
export function appearance() {
  const radius = appLengthToken('--radius-control', 8);
  return {
    variables: {
      colorPrimary: resolveColorToken('--primary', '12 45 58'),
      colorText: resolveColorToken('--text-primary', '26 26 26'),
      colorSecondaryText: resolveColorToken('--muted-foreground', '74 87 96'),
      colorBorder: resolveColorToken('--border-color', '228 232 236'),
      colorDanger: resolveColorToken('--danger', '192 57 43'),
      fontFamily: appFontFamily(),
      fontSizeBase: '14px',
      borderRadius: radius,
      buttonBorderRadius: radius,
      formBorderRadius: radius,
      badgeBorderRadius: '4px',
      badgePaddingX: '8px',
      badgePaddingY: '4px',
      buttonPaddingX: '12px',
      buttonPaddingY: '8px',
      tableRowPaddingY: '10px',
      badgeNeutralColorBackground: resolveColorToken('--neutral-surface', '238 241 243'),
      badgeNeutralColorText: resolveColorToken('--neutral-text', '94 112 123'),
      badgeNeutralColorBorder: resolveColorToken('--neutral-border', '228 232 236'),
      badgeSuccessColorBackground: resolveColorToken('--success-surface', '238 248 242'),
      badgeSuccessColorText: resolveColorToken('--success-text', '34 100 72'),
      badgeSuccessColorBorder: resolveColorToken('--success-border', '191 218 203'),
      badgeWarningColorBackground: resolveColorToken('--warning-surface', '251 241 229'),
      badgeWarningColorText: resolveColorToken('--warning-text', '179 83 9'),
      badgeWarningColorBorder: resolveColorToken('--warning-border', '231 182 102'),
      badgeDangerColorBackground: resolveColorToken('--danger-surface', '247 236 234'),
      badgeDangerColorText: resolveColorToken('--danger-text', '172 81 68'),
      badgeDangerColorBorder: resolveColorToken('--danger-border', '232 199 193'),
    },
  };
}

/** Which embedded component set a session is for. Mirrors the server's named surfaces. */
export type ConnectSurface = 'owner' | 'viewer';

type SessionFailureListener = (surface: ConnectSurface) => void;
const sessionFailureListeners = new Set<SessionFailureListener>();

/**
 * Slice 33b: tell a page when the request for a session secret failed (a 429, a 5xx, a dropped connection). The
 * embedded library may then mount nothing and never call a component's own load-error hook, so a page that waited
 * only on that hook stayed blank. Returns the unsubscribe.
 */
export function onSessionRequestFailed(listener: SessionFailureListener): () => void {
  sessionFailureListeners.add(listener);
  return () => sessionFailureListeners.delete(listener);
}

const sessionSuccessListeners = new Set<SessionFailureListener>();

/**
 * Slice 33b fix round: tell a page when a session secret was obtained. A page's "couldn't load" card belongs to the
 * failed state only, so a success clears whatever an earlier failure (or an abandoned session's late one) left.
 * Returns the unsubscribe.
 */
export function onSessionRequestSucceeded(listener: SessionFailureListener): () => void {
  sessionSuccessListeners.add(listener);
  return () => sessionSuccessListeners.delete(listener);
}

/** Minted per request, on the server, for one surface of the caller's own organization. */
async function fetchClientSecret(surface: ConnectSurface): Promise<string> {
  try {
    const { data } = await api.post('/api/organization/stripe/account-session', { surface });
    const secret = (data as { client_secret: string }).client_secret;
    sessionSuccessListeners.forEach((listener) => listener(surface));
    return secret;
  } catch (err) {
    sessionFailureListeners.forEach((listener) => listener(surface));
    throw err;
  }
}

function connectFor(surface: ConnectSurface): ConnectInstance {
  stopFrameWatcher(); // a new session (owner or viewer) owns its frames again
  return loadConnectAndInitialize({
    publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY,
    fetchClientSecret: () => fetchClientSecret(surface),
    appearance: appearance(),
    // The embedded frames cannot see our stylesheet, so the app's face (Figtree inside the v2 frame) is loaded for them
    // from a stylesheet URL, the same way the Manrope face was before it.
    fonts: [{ cssSrc: 'https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap' }],
  });
}

/** The shared owner session (payout account page); created on first use. */
export function getPayoutConnect(): ConnectInstance {
  if (!instance) instance = connectFor('owner');
  return instance;
}

/** The shared viewer session (ServWave Payments area: payments, payouts, documents, disputes); created on first use. */
export function getViewerConnect(): ConnectInstance {
  if (!viewerInstance) viewerInstance = connectFor('viewer');
  return viewerInstance;
}

/** Drop the owner session without signing out (a load failure the owner retries). Does not call `logout()`. */
export function discardPayoutConnect(): void {
  instance = null;
}

/**
 * The processor's script mounts its own frames straight under <body> (a hidden controller frame and one per
 * embedded component) and has no call that removes them. After the session has ended they would sit in the
 * next screen (the login page) until a reload, so they are removed here. Only frames whose address is the
 * processor's are touched, and only those that are direct children of <body>: the components React renders
 * live deeper and are unmounted by React itself.
 */
function removeProcessorFrames(): void {
  try {
    document.querySelectorAll<HTMLIFrameElement>('body > iframe').forEach((frame) => {
      let host: string;
      try {
        host = new URL(frame.src).hostname;
      } catch {
        return;
      }
      if (host === 'stripe.com' || host.endsWith('.stripe.com')) frame.remove();
    });
  } catch {
    /* no document (server render) - nothing to remove */
  }
}

/** Drop the viewer session without signing out (a load failure the viewer retries). Does not call `logout()`. */
export function discardViewerConnect(): void {
  viewerInstance = null;
}

// Slice 33b: the next successful sign-in ends the watch too (the frames are gone, and a new session owns them).
registerSignInHook(stopFrameWatcher);

// ServWave sign-out only: end the embedded session(s) so the next person on this browser starts clean, then
// remove whatever the sessions left in the document.
registerStoreReset(() => {
  const current = [instance, viewerInstance];
  instance = null;
  viewerInstance = null;
  const ended = Promise.all(
    current.map(async (c) => {
      try {
        await c?.logout?.();
      } catch {
        /* ending failed; the frames still go */
      }
    }),
  );
  void ended.finally(removeProcessorFrames);
  // The library re-mounts a preconnect frame some seconds AFTER logout() resolves (seen in a real browser), so a
  // one-off sweep is not enough: keep removing its frames until the next session starts, someone signs in, 30 seconds pass, or the page reloads.
  stopFrameWatcher();
  try {
    frameWatcher = new MutationObserver(removeProcessorFrames);
    frameWatcher.observe(document.body, { childList: true });
    frameWatchTimer = setTimeout(stopFrameWatcher, FRAME_WATCH_MS);
  } catch {
    /* no document - nothing to watch */
  }
});
