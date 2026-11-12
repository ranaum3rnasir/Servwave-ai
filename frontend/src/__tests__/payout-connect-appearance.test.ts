// Payments go-live P8 - the embedded components read as ServWave: font family and radius come from the app's own
// tokens (the v2 shell's face and control radius), not hard-coded values, and the badge, button and table-row
// options match the new tables.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appearance, discardViewerConnect, getViewerConnect } from '@/lib/payments/payout-connect';

const hoisted = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: hoisted.load }));

function mountShell(style: string) {
  const shell = document.createElement('div');
  shell.className = 'app';
  shell.setAttribute('style', style);
  document.body.appendChild(shell);
  return shell;
}

beforeEach(() => {
  hoisted.load.mockReset();
  hoisted.load.mockReturnValue({ logout: vi.fn() });
  discardViewerConnect();
});
afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('style');
});

describe('the embedded look', () => {
  it('takes the font family from the app shell, not a hard-coded face', () => {
    mountShell('font-family: Figtree, "Figtree Fallback", system-ui, sans-serif; --radius-control: 8px');
    expect(appearance().variables.fontFamily).toBe('Figtree, system-ui, sans-serif');
  });

  it('follows the shell when its face changes', () => {
    mountShell('font-family: "Source Sans 3", system-ui, sans-serif; --radius-control: 8px');
    expect(appearance().variables.fontFamily).toBe('"Source Sans 3", system-ui, sans-serif');
  });

  it('takes the radius from the app control-radius token for the general, button and form radius', () => {
    mountShell('font-family: Figtree; --radius-control: 8px');
    const v = appearance().variables;
    expect(v.borderRadius).toBe('8px');
    expect(v.buttonBorderRadius).toBe('8px');
    expect(v.formBorderRadius).toBe('8px');
  });

  it('follows the token when it changes, and reads a rem value as pixels', () => {
    mountShell('font-family: Figtree; --radius-control: 0.75rem');
    expect(appearance().variables.borderRadius).toBe('12px');
  });

  it('falls back to the kit face and an 8px radius where the frame declares no face and no radius', () => {
    // Stated here, not left to the fake browser: what it reports for an element with no font-family differs by
    // version (an empty string, or the CSS placeholder "depends on user agent"), and neither is what a browser reports.
    const style = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({ fontFamily: '', getPropertyValue: () => '' } as unknown as CSSStyleDeclaration);
    try {
      const v = appearance().variables;
      expect(v.fontFamily).toBe('Figtree, system-ui, sans-serif');
      expect(v.borderRadius).toBe('8px');
    } finally {
      style.mockRestore();
    }
  });

  it('sets the badge, button and table-row options to match the kit tables', () => {
    mountShell('font-family: Figtree; --radius-control: 8px');
    const v = appearance().variables;
    expect(v).toMatchObject({
      badgeBorderRadius: '4px', badgePaddingX: '8px', badgePaddingY: '4px',
      buttonPaddingX: '12px', buttonPaddingY: '8px',
      tableRowPaddingY: '10px', fontSizeBase: '14px',
    });
    for (const key of [
      'badgeSuccessColorBackground', 'badgeSuccessColorText', 'badgeSuccessColorBorder',
      'badgeWarningColorBackground', 'badgeDangerColorBackground', 'badgeNeutralColorBackground',
      'colorSecondaryText', 'colorBorder',
    ] as const) {
      expect(v[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('hands the session the same appearance and loads the app face, not Manrope', () => {
    mountShell('font-family: Figtree; --radius-control: 8px');
    getViewerConnect();
    const options = hoisted.load.mock.calls[0]![0] as { appearance: unknown; fonts: Array<{ cssSrc: string }> };
    expect(options.appearance).toEqual(appearance());
    expect(options.fonts.map((f) => f.cssSrc).join(' ')).toMatch(/family=Figtree/);
    expect(options.fonts.map((f) => f.cssSrc).join(' ')).not.toMatch(/Manrope/);
  });
});
