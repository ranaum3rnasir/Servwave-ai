import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SectionCard } from '@/components/jobs/overview/SectionCard';

// Mobile slice 55: a section card's meta row wraps. The estimate's "Generate tasks", "Add item"
// and "Add scope of work" sit in it; at 320 px they used to be pushed past the card's edge.
// Class-name assertions, because jsdom does no layout; the gate measures the real thing.

describe('SectionCard header band', () => {
  it('wraps, so a title and its action buttons never push a button off the card', () => {
    render(
      <SectionCard title="Tasks" meta={<button type="button">Generate tasks</button>}>
        body
      </SectionCard>,
    );
    const band = screen.getByRole('heading', { name: 'Tasks' }).parentElement!;
    expect(band.className).toContain('flex-wrap');
  });

  it('lets the meta group wrap onto its own line, right aligned, and the title shrink', () => {
    render(
      <SectionCard title="Line items" meta={<button type="button">Add item</button>}>
        body
      </SectionCard>,
    );
    const meta = screen.getByRole('button', { name: 'Add item' }).parentElement!;
    expect(meta.className).toContain('flex-wrap');
    expect(meta.className).toContain('justify-end');
    expect(meta.className).toContain('ml-auto');
    expect(screen.getByRole('heading', { name: 'Line items' }).className).toContain('min-w-0');
  });
});
