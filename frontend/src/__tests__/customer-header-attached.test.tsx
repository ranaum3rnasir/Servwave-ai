/**
 * CustomerHeader - the hero's "Attached to" strip.
 *
 * One place for every record an estimate hangs off. Before this, WHERE you looked depended on
 * which anchor the estimate happened to have: a lead-anchored estimate advertised a "View Lead ->"
 * link in this footer, while a job-anchored one had nothing on the page at all - only an
 * unlabelled `Actions > View job` item that never named the job.
 *
 * The two job pointers are different relations and both must be renderable:
 *   job_link = ANCHOR      (Estimate.job_id - written against an existing job)
 *   job      = PROVENANCE  (Job.estimate_id - a job created FROM this estimate)
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { renderWithProviders } from './helpers';
import { CustomerHeader } from '@/features/estimate-workspace/components/CustomerHeader';
import type { PanelEstimate } from '@/features/estimate-workspace/lib/panelEstimate';

const CUSTOMER = { first_name: 'Dana', last_name: 'Whitfield' };

function estimate(overrides: Partial<PanelEstimate> = {}): PanelEstimate {
  return {
    id: 'e0000000-0000-0000-0000-000000000001',
    estimate_number: 'E00123',
    status: 'DRAFT',
    tax_rate: 0,
    created_at: '2026-07-20T00:00:00.000Z',
    customer_id: 'c-1',
    customer: CUSTOMER,
    lead_id: null,
    lead: null,
    ...overrides,
  };
}

const LEAD = {
  id: 'l-1',
  lead_number: 'L00042',
  status: 'ESTIMATED',
  customer: CUSTOMER,
};

describe('CustomerHeader - "Attached to" strip', () => {
  it('names and links the job for a JOB-ANCHORED estimate (job_link, no provenance job)', () => {
    // The case that had no affordance at all: job_id is set, nothing points back, so `job` is
    // null and the page previously held a bare uuid it could not render.
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          job_id: 'j-1',
          job_link: { id: 'j-1', job_number: 'J00042', status: 'SCHEDULED' },
        })}
      />,
    );

    const link = screen.getByRole('link', { name: /Job J00042/ });
    expect(link).toHaveAttribute('href', '/jobs/j-1');
    expect(screen.getByText('Attached to')).toBeInTheDocument();
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
  });

  it('names and links the lead for a LEAD-ANCHORED estimate', () => {
    renderWithProviders(<CustomerHeader estimate={estimate({ lead_id: 'l-1', lead: LEAD })} />);

    expect(screen.getByRole('link', { name: /Lead L00042/ })).toHaveAttribute('href', '/leads/l-1');
    expect(screen.getByText('Estimate Sent')).toBeInTheDocument();
  });

  it('renders BOTH in the same strip when the estimate has a lead and a job', () => {
    // The whole point: one place, whatever the estimate is attached to.
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          lead_id: 'l-1',
          lead: LEAD,
          job: { id: 'j-2', job_number: 'J00318', status: 'IN_PROGRESS' },
        })}
      />,
    );

    expect(screen.getByRole('link', { name: /Lead L00042/ })).toHaveAttribute('href', '/leads/l-1');
    expect(screen.getByRole('link', { name: /Job J00318/ })).toHaveAttribute('href', '/jobs/j-2');
  });

  it('spells the two job relations apart rather than labelling both "attached"', () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          job_id: 'j-1',
          job_link: { id: 'j-1', job_number: 'J00042', status: 'SCHEDULED' },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: /Job J00042/ })).toHaveAttribute(
      'title',
      'This estimate is attached to this job',
    );

    screen.getByText('Attached to'); // same strip, different relation below

    renderWithProviders(
      <CustomerHeader
        estimate={estimate({ job: { id: 'j-2', job_number: 'J00318', status: 'COMPLETED' } })}
      />,
    );
    expect(screen.getByRole('link', { name: /Job J00318/ })).toHaveAttribute(
      'title',
      'Created from this estimate',
    );
  });

  it('renders one chip, not two, when both pointers name the SAME job', () => {
    renderWithProviders(
      <CustomerHeader
        estimate={estimate({
          job_id: 'j-1',
          job_link: { id: 'j-1', job_number: 'J00042', status: 'SCHEDULED' },
          job: { id: 'j-1', job_number: 'J00042', status: 'SCHEDULED' },
        })}
      />,
    );

    expect(screen.getAllByRole('link', { name: /Job J00042/ })).toHaveLength(1);
  });

  it('still links the job when only the scalar job_id is present, rather than dropping the chip', () => {
    // Defensive: the detail select always sends job_link beside job_id, but silently losing the
    // attachment is the exact failure this strip exists to fix - degrade to an unnamed link.
    renderWithProviders(<CustomerHeader estimate={estimate({ job_id: 'j-9' })} />);

    expect(screen.getByRole('link', { name: /Job/ })).toHaveAttribute('href', '/jobs/j-9');
    expect(screen.queryByText(/stands on its own/)).not.toBeInTheDocument();
  });

  it('says so explicitly when nothing is attached, instead of rendering an empty bar', () => {
    renderWithProviders(<CustomerHeader estimate={estimate()} />);

    expect(screen.getByText('Attached to')).toBeInTheDocument();
    expect(screen.getByText(/stands on its own/)).toBeInTheDocument();
  });

  // #1997 — the "Attached to" strip and BOTH document columns share one `estimate` prop, so a
  // redacted customer (email/phone/billing_* keys entirely absent) must not break the strip
  // either. `CUSTOMER` above already carries no contact keys — this pins that on purpose.
  it('renders the lead link and both columns unaffected by a customer with no contact keys at all (#1997)', () => {
    renderWithProviders(<CustomerHeader estimate={estimate({ lead_id: 'l-1', lead: LEAD })} />);

    expect(screen.getByRole('link', { name: /Lead L00042/ })).toBeInTheDocument();
    expect(screen.getAllByText('Dana Whitfield').length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: /^tel:/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /^mailto:/ })).not.toBeInTheDocument();
  });
});
