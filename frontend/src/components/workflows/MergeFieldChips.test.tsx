import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '@/__tests__/helpers';
import MergeFieldChips, { groupFields } from './MergeFieldChips';
import type { WorkflowCatalog } from '@/lib/api/workflows';

/** Minimal catalog fixture — only the merge_field_labels MergeFieldChips reads. */
const CATALOG = {
  merge_field_labels: {
    'org.name': 'Company name',
    'org.phone': 'Company phone',
    'customer.first_name': 'Customer first name',
    'job.number': 'Job number',
    'technician.names': 'Technician name(s)',
    'estimate.total': 'Estimate total',
  },
} as unknown as WorkflowCatalog;

/** A job trigger's mergeFields: 2 Company + 1 Customer + 2 Job (job. + technician.). */
const JOB_TRIGGER_FIELDS = ['org.name', 'org.phone', 'customer.first_name', 'job.number', 'technician.names'];

describe('groupFields', () => {
  it('buckets by entity prefix, merging job. + technician. into one "Job" group, in canonical order', () => {
    expect(groupFields(JOB_TRIGGER_FIELDS)).toEqual([
      { label: 'Company', fields: ['org.name', 'org.phone'] },
      { label: 'Customer', fields: ['customer.first_name'] },
      { label: 'Job', fields: ['job.number', 'technician.names'] },
    ]);
  });

  it('skips groups with no fields', () => {
    const labels = groupFields(['org.name', 'job.number']).map((g) => g.label);
    expect(labels).toEqual(['Company', 'Job']);
  });

  it('returns an empty array for an empty field list', () => {
    expect(groupFields([])).toEqual([]);
  });

  /**
   * There is no "Recipient" group any more, and this is the assertion that says so.
   *
   * `recipient.first_name` rode in BASE on every trigger and had a bucket of its own here.
   * Ran had the field removed outright on 2026-09-15 (backend catalog.ts, `BASE`), so the
   * prefix went with it - and a prefix left behind in FIELD_GROUPS is not harmless: an
   * unrecognised prefix falls into the trailing "Other" bucket by design, so the leftover
   * entry is what would keep a re-introduced field looking deliberate instead of showing up
   * as the leftover it is.
   *
   * The real groups are asserted in the SAME call, so this cannot pass on a build where
   * groupFields returned nothing at all.
   */
  it('has no Recipient group, and still buckets the fields that remain', () => {
    expect(groupFields(['org.name', 'customer.first_name', 'recipient.first_name', 'job.number'])).toEqual([
      { label: 'Company', fields: ['org.name'] },
      { label: 'Customer', fields: ['customer.first_name'] },
      { label: 'Job', fields: ['job.number'] },
      // No bucket claims the retired prefix, so it lands in the trailing catch-all - which
      // is what an unknown field is supposed to do, and what makes one visible.
      { label: 'Other', fields: ['recipient.first_name'] },
    ]);
  });

  // Spec B. With no prefix entry every task.* field lands in the trailing "Other" bucket,
  // in both builder trees (v2's picker imports this very function), and nothing goes red.
  it('buckets task. into its own "Task" group rather than the trailing "Other"', () => {
    const groups = groupFields([
      'org.name',
      'task.number',
      'task.title',
      'task.due_date',
      'task.link',
    ]);
    expect(groups).toEqual([
      { label: 'Company', fields: ['org.name'] },
      { label: 'Task', fields: ['task.number', 'task.title', 'task.due_date', 'task.link'] },
    ]);
    expect(groups.map((g) => g.label)).not.toContain('Other');
  });
});

describe('MergeFieldChips — empty state', () => {
  it('renders nothing when there are no fields (preserves the existing null render)', () => {
    const { container } = renderWithProviders(
      <MergeFieldChips fields={[]} used={new Set()} catalog={CATALOG} onInsert={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });
});

describe('MergeFieldChips — collapsible groups', () => {
  it('renders one header per non-empty group, each with its field count', () => {
    renderWithProviders(
      <MergeFieldChips fields={JOB_TRIGGER_FIELDS} used={new Set()} catalog={CATALOG} onInsert={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Company (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Customer (1)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Job (2)' })).toBeInTheDocument();
  });

  it('collapses every group by default except the primary (first non-base) entity group', () => {
    renderWithProviders(
      <MergeFieldChips fields={JOB_TRIGGER_FIELDS} used={new Set()} catalog={CATALOG} onInsert={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'Company (2)' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Customer (1)' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Job (2)' })).toHaveAttribute('aria-expanded', 'true');

    // A collapsed group's chips are not in the document…
    expect(screen.queryByRole('button', { name: /Company name/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Customer first name/i })).toBeNull();
    // …the expanded (primary) group's chips are.
    expect(screen.getByRole('button', { name: /Job number/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Technician name/i })).toBeInTheDocument();
  });

  it('opens the group containing an already-used field instead of the naive first entity group', () => {
    renderWithProviders(
      <MergeFieldChips
        fields={['org.name', 'job.number', 'estimate.total']}
        used={new Set(['estimate.total'])}
        catalog={CATALOG}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Estimate (1)' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Job (1)' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking a collapsed header reveals its chips; clicking again re-collapses it', async () => {
    renderWithProviders(
      <MergeFieldChips fields={JOB_TRIGGER_FIELDS} used={new Set()} catalog={CATALOG} onInsert={vi.fn()} />,
    );
    const companyHeader = screen.getByRole('button', { name: 'Company (2)' });
    expect(screen.queryByRole('button', { name: /Company name/i })).toBeNull();

    await userEvent.click(companyHeader);
    expect(companyHeader).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Company name/i })).toBeInTheDocument();

    await userEvent.click(companyHeader);
    expect(companyHeader).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /Company name/i })).toBeNull();
  });

  it('clicking a chip in an expanded group still calls onInsert with the raw field key', async () => {
    const onInsert = vi.fn();
    renderWithProviders(
      <MergeFieldChips fields={JOB_TRIGGER_FIELDS} used={new Set()} catalog={CATALOG} onInsert={onInsert} />,
    );
    // "Job" is the primary group, expanded by default.
    await userEvent.click(screen.getByRole('button', { name: /Job number/i }));
    expect(onInsert).toHaveBeenCalledWith('job.number');
  });

  it('an in-use field still renders with aria-pressed="true" (the ✓ state)', () => {
    renderWithProviders(
      <MergeFieldChips
        fields={JOB_TRIGGER_FIELDS}
        used={new Set(['job.number'])}
        catalog={CATALOG}
        onInsert={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /Job number/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Technician name/i })).toHaveAttribute('aria-pressed', 'false');
  });
});

// ── lead.walkthrough_location ────────────────────────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md.
//
// The grouping is automatic and that is exactly the hazard: FIELD_GROUPS maps by PREFIX, and a
// name with no known prefix lands in "Other" with nothing anywhere saying so. This suite is the
// only thing that would catch a rename to `visit.location` or `walkthrough.location` - the
// backend catalog test asserts the field has a label and a sample, not where it renders.

describe('lead.walkthrough_location lands in the walkthrough group', () => {
  it('buckets into "Lead & walkthrough", not "Other"', () => {
    const groups = groupFields(['lead.walkthrough_date', 'lead.walkthrough_location']);
    expect(groups).toEqual([
      { label: 'Lead & walkthrough', fields: ['lead.walkthrough_date', 'lead.walkthrough_location'] },
    ]);
    expect(groups.map((g) => g.label)).not.toContain('Other');
  });

  it('sits beside the date and the team it belongs with, in one group', () => {
    const groups = groupFields([
      'org.name', 'lead.walkthrough_date', 'lead.walkthrough_time',
      'lead.performer_names', 'lead.walkthrough_location',
    ]);
    const walkthrough = groups.find((g) => g.label === 'Lead & walkthrough');
    expect(walkthrough!.fields).toContain('lead.walkthrough_location');
    expect(walkthrough!.fields).toHaveLength(4);
  });
});

// ── job.visit_location ───────────────────────────────────────────────────────
//
// Slice: md_files/issues/scheduling/04-give-job-visits-their-own-location.md
//
// The job half. Same hazard as its lead twin above, and the same reason this is the only place
// that would catch it: FIELD_GROUPS maps by PREFIX, so a rename to `visit.location` renders the
// chip in "Other" - away from the date and the address it belongs beside - and nothing anywhere
// says so. The backend catalog test asserts the field has a label and a sample, not where it
// renders in front of the person writing the automation.

describe('job.visit_location lands in the Job group', () => {
  it('buckets into "Job", not "Other"', () => {
    const groups = groupFields(['job.scheduled_date', 'job.visit_location']);
    expect(groups).toEqual([
      { label: 'Job', fields: ['job.scheduled_date', 'job.visit_location'] },
    ]);
    expect(groups.map((g) => g.label)).not.toContain('Other');
  });

  it('sits beside the service address it qualifies, in one group', () => {
    const groups = groupFields([
      'org.name', 'job.number', 'job.scheduled_date', 'job.address', 'job.visit_location',
      'technician.names',
    ]);
    const job = groups.find((g) => g.label === 'Job');
    expect(job!.fields).toContain('job.visit_location');
    expect(job!.fields).toContain('job.address');
    // `technician.` also buckets into "Job", so the group is the five job-side fields above.
    expect(job!.fields).toHaveLength(5);
  });

  it('renders its own chip, labelled apart from the lead side’s (D5)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MergeFieldChips
        fields={['lead.walkthrough_location', 'job.visit_location']}
        used={new Set()}
        catalog={{
          merge_field_labels: {
            'lead.walkthrough_location': 'Walkthrough visit address',
            'job.visit_location': 'Job visit address',
          },
        } as unknown as WorkflowCatalog}
        onInsert={vi.fn()}
      />,
    );

    // Only the first non-base group starts expanded, so open whichever of the two is shut before
    // looking for the chips.
    for (const label of ['Job (1)', 'Lead & walkthrough (1)']) {
      const toggle = screen.getByRole('button', { name: label });
      if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
    }

    // TWO chips, two different words. A shared label would put two chips reading the same thing
    // in front of an author who has to tell them apart.
    expect(screen.getByRole('button', { name: /Job visit address/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Walkthrough visit address$/ })).toBeInTheDocument();
  });
});

// ── lead.performer_phones / technician.phones ────────────────────────────────
//
// Slice: md_files/issues/scheduling/05-give-the-customer-a-number-that-reaches-the-person-coming.md
//
// The phone pair, and the same hazard as the location pair before it: FIELD_GROUPS maps by PREFIX,
// so a name like `performer.phones` or `visit.phones` renders in "Other" - away from the team or
// the crew it belongs beside - and nothing anywhere says so. The backend catalog test asserts each
// field has a label and a sample, not where it lands in front of the person writing the copy.
//
// `groupFields` is the one implementation both pickers use - the v2 automations fork imports it
// from this module rather than copying it - so this covers the routed surface as well as this one.

describe('the phone fields land beside the people they describe', () => {
  it('buckets lead.performer_phones into "Lead & walkthrough", not "Other"', () => {
    const groups = groupFields(['lead.performer_names', 'lead.performer_phones']);
    expect(groups).toEqual([
      { label: 'Lead & walkthrough', fields: ['lead.performer_names', 'lead.performer_phones'] },
    ]);
    expect(groups.map((g) => g.label)).not.toContain('Other');
  });

  it('buckets technician.phones into "Job", not "Other"', () => {
    const groups = groupFields(['technician.names', 'technician.phones']);
    expect(groups).toEqual([
      { label: 'Job', fields: ['technician.names', 'technician.phones'] },
    ]);
    expect(groups.map((g) => g.label)).not.toContain('Other');
  });

  it('puts each one in ITS OWN group when a trigger offers both sides’ neighbours', () => {
    const groups = groupFields([
      'org.phone',
      'lead.walkthrough_date', 'lead.performer_names', 'lead.performer_phones',
      'job.address', 'technician.names', 'technician.phones',
    ]);
    const walkthrough = groups.find((g) => g.label === 'Lead & walkthrough');
    const job = groups.find((g) => g.label === 'Job');
    expect(walkthrough!.fields).toContain('lead.performer_phones');
    expect(walkthrough!.fields).not.toContain('technician.phones');
    expect(job!.fields).toContain('technician.phones');
    expect(job!.fields).not.toContain('lead.performer_phones');
    // The company's main line is a different field in a different group - it is what these two
    // FALL BACK to, not what they are.
    expect(groups.find((g) => g.label === 'Company')!.fields).toEqual(['org.phone']);
  });

  it('renders a chip for each, labelled apart', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MergeFieldChips
        fields={['lead.performer_phones', 'technician.phones']}
        used={new Set()}
        catalog={{
          merge_field_labels: {
            'lead.performer_phones': 'Walkthrough team phone(s)',
            'technician.phones': 'Technician phone(s)',
          },
        } as unknown as WorkflowCatalog}
        onInsert={vi.fn()}
      />,
    );

    for (const label of ['Job (1)', 'Lead & walkthrough (1)']) {
      const toggle = screen.getByRole('button', { name: label });
      if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
    }

    expect(screen.getByRole('button', { name: /Walkthrough team phone\(s\)/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Technician phone\(s\)/ })).toBeInTheDocument();
  });
});

// ── lead.performer_servwave_phones / technician.servwave_phones ──────────────
//
// Slice: md_files/issues/scheduling/07-let-the-author-choose-the-servwave-number-instead-of-the-personal-one.md
//
// The second phone pair, and the prefixes are load-bearing in the same way - but the hazard is
// sharper here, because these two are the ALTERNATIVE to the pair above and the author is meant to
// choose between them. A name that fell into "Other" would put the choice in a different section
// from the thing being chosen against, and the author would never see that there was a choice.

describe('the ServWave phone fields land beside the ones they are the alternative to', () => {
  it('buckets lead.performer_servwave_phones into "Lead & walkthrough", not "Other"', () => {
    const groups = groupFields(['lead.performer_phones', 'lead.performer_servwave_phones']);
    expect(groups).toEqual([
      { label: 'Lead & walkthrough', fields: ['lead.performer_phones', 'lead.performer_servwave_phones'] },
    ]);
    expect(groups.map((g) => g.label)).not.toContain('Other');
  });

  it('buckets technician.servwave_phones into "Job", not "Other"', () => {
    const groups = groupFields(['technician.phones', 'technician.servwave_phones']);
    expect(groups).toEqual([
      { label: 'Job', fields: ['technician.phones', 'technician.servwave_phones'] },
    ]);
    expect(groups.map((g) => g.label)).not.toContain('Other');
  });

  it('puts all four phone fields in the two groups their people are in', () => {
    const groups = groupFields([
      'org.phone',
      'lead.performer_names', 'lead.performer_phones', 'lead.performer_servwave_phones',
      'technician.names', 'technician.phones', 'technician.servwave_phones',
    ]);
    expect(groups.map((g) => g.label)).not.toContain('Other');
    expect(groups.find((g) => g.label === 'Lead & walkthrough')!.fields)
      .toEqual(['lead.performer_names', 'lead.performer_phones', 'lead.performer_servwave_phones']);
    expect(groups.find((g) => g.label === 'Job')!.fields)
      .toEqual(['technician.names', 'technician.phones', 'technician.servwave_phones']);
  });

  it('renders both chips, labelled apart from the personal ones', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <MergeFieldChips
        fields={[
          'lead.performer_phones', 'lead.performer_servwave_phones',
          'technician.phones', 'technician.servwave_phones',
        ]}
        used={new Set()}
        catalog={{
          merge_field_labels: {
            'lead.performer_phones': 'Walkthrough team phone(s)',
            'lead.performer_servwave_phones': 'Walkthrough team ServWave phone(s)',
            'technician.phones': 'Technician phone(s)',
            'technician.servwave_phones': 'Technician ServWave phone(s)',
          },
        } as unknown as WorkflowCatalog}
        onInsert={vi.fn()}
      />,
    );

    for (const label of ['Job (2)', 'Lead & walkthrough (2)']) {
      const toggle = screen.getByRole('button', { name: label });
      if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
    }

    // Four chips, four labels. The author has to be able to tell which number a chip prints, and
    // the label is the only thing that tells them.
    expect(screen.getByRole('button', { name: /^Walkthrough team phone\(s\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Walkthrough team ServWave phone\(s\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Technician phone\(s\)$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Technician ServWave phone\(s\)$/ })).toBeInTheDocument();
  });
});
