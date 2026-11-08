import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusBadge } from '@/components/data/status-badge';
import { STATUS_REGISTRY, STATUS_INTENT_CLASSES, type StatusDomain } from '@/design-system/status-registry';

// Raw Tailwind palette families that must NOT survive the token remap.
const RAW_PALETTE = /\b(?:bg|text|border(?:-[trblxyse])?)-(?:blue|cyan|teal|sky|orange|red|green|emerald|amber|rose|indigo|violet|purple|pink|fuchsia|lime|yellow)-\d{2,3}\b/;

const DOMAINS = Object.keys(STATUS_REGISTRY) as StatusDomain[];

function tokenClasses(intent: keyof typeof STATUS_INTENT_CLASSES): string[] {
  return STATUS_INTENT_CLASSES[intent].split(' ');
}

describe('StatusBadge - labels + intent tokens per domain (characterization)', () => {
  for (const domain of DOMAINS) {
    describe(`domain="${domain}"`, () => {
      const entries = Object.entries(STATUS_REGISTRY[domain]);
      it.each(entries)('renders %s with its registry label + intent token', (status, entry) => {
        const { container } = render(<StatusBadge domain={domain} status={status} />);
        const el = container.firstChild as HTMLElement;
        expect(el.textContent).toBe(entry.label);
        for (const cls of tokenClasses(entry.intent)) {
          expect(el.className).toContain(cls);
        }
      });
    });
  }

  it('falls back to the raw status string with the neutral token for an unknown key', () => {
    const { container } = render(<StatusBadge domain="lead" status="SOME_UNKNOWN_KEY" />);
    const el = container.firstChild as HTMLElement;
    expect(el.textContent).toBe('SOME_UNKNOWN_KEY');
    for (const cls of tokenClasses('neutral')) {
      expect(el.className).toContain(cls);
    }
  });
});

describe('StatusBadge - token-only colors (regression guard)', () => {
  for (const domain of DOMAINS) {
    it.each(Object.keys(STATUS_REGISTRY[domain]))(
      `domain="${domain}" status=%s uses no raw Tailwind palette color class`,
      (status) => {
        const { container } = render(<StatusBadge domain={domain} status={status} />);
        const cls = (container.firstChild as HTMLElement).className;
        expect(cls).not.toMatch(RAW_PALETTE);
      },
    );
  }

  it('still passes through a caller className', () => {
    const { container } = render(<StatusBadge domain="invoice" status="PAID" className="custom-marker" />);
    expect((container.firstChild as HTMLElement).className).toContain('custom-marker');
  });
});

describe('StatusBadge - neutral override (colorless lead chips)', () => {
  const LEAD_STATUSES = Object.keys(STATUS_REGISTRY.lead);

  it.each(LEAD_STATUSES)('renders %s with the neutral token regardless of its registry intent', (status) => {
    const { container } = render(<StatusBadge domain="lead" status={status} neutral />);
    const cls = (container.firstChild as HTMLElement).className;
    for (const neutralCls of tokenClasses('neutral')) {
      expect(cls).toContain(neutralCls);
    }
  });

  it.each(LEAD_STATUSES)('preserves the registry label text for %s', (status) => {
    const { container } = render(<StatusBadge domain="lead" status={status} neutral />);
    expect(container.textContent).toBe(STATUS_REGISTRY.lead[status]!.label);
  });

  it('without neutral, WON still resolves to the success token', () => {
    const { container } = render(<StatusBadge domain="lead" status="WON" />);
    for (const cls of tokenClasses('success')) {
      expect((container.firstChild as HTMLElement).className).toContain(cls);
    }
  });

  // SRVW-111 (label-override shape) - a caller can relabel a status's display text without
  // touching the underlying enum value or its color/intent.
  it('labelOverride replaces the rendered text but never the intent/color token', () => {
    const { container } = render(<StatusBadge domain="lead" status="WON" labelOverride="Closed Won" neutral />);
    const el = container.firstChild as HTMLElement;
    expect(el.textContent).toBe('Closed Won');
    for (const cls of tokenClasses('neutral')) {
      expect(el.className).toContain(cls);
    }
  });

  it('an empty-string labelOverride falls back to the registry label (never renders blank)', () => {
    const { container } = render(<StatusBadge domain="lead" status="WON" labelOverride="" neutral />);
    expect(container.textContent).toBe(STATUS_REGISTRY.lead.WON!.label);
  });

  it('omitting labelOverride keeps the registry label, unaffected', () => {
    const { container } = render(<StatusBadge domain="lead" status="WON" neutral />);
    expect(container.textContent).toBe(STATUS_REGISTRY.lead.WON!.label);
  });
});

describe('StatusBadge - domain="estimate" (§E-3, estimate workspace redesign)', () => {
  it('SENT reads as info for an estimate, not the shared warning default other domains use', () => {
    const { container } = render(<StatusBadge domain="estimate" status="SENT" />);
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain('bg-info-surface');
    expect(cls).not.toContain('bg-warning-surface');
  });

  it('the same SENT key reads as warning for an invoice, proving domains never share a fallback', () => {
    const { container } = render(<StatusBadge domain="invoice" status="SENT" />);
    expect((container.firstChild as HTMLElement).className).toContain('bg-warning-surface');
  });

  // D6 (2026-07-21): PENDING means the customer has approved and signed; only the deposit is
  // outstanding, so the label carries the acceptance rather than reading as "still deciding".
  it('PENDING reads as approved-with-deposit-outstanding for an estimate', () => {
    const { container } = render(<StatusBadge domain="estimate" status="PENDING" />);
    const el = container.firstChild as HTMLElement;
    expect(el.textContent).toBe(STATUS_REGISTRY.estimate.PENDING.label);
    expect(el.className).toContain('bg-warning-surface');
  });

  it('SUPERSEDED renders the neutral token for an estimate', () => {
    const { container } = render(<StatusBadge domain="estimate" status="SUPERSEDED" />);
    expect((container.firstChild as HTMLElement).className).toContain('bg-neutral-surface');
  });

  it('size="lg" renders a larger pill without changing the label', () => {
    const { container } = render(<StatusBadge domain="estimate" status="SENT" size="lg" />);
    const el = container.firstChild as HTMLElement;
    expect(el.className).toContain('text-sm');
    expect(el.textContent).toBe('Sent');
  });
});
