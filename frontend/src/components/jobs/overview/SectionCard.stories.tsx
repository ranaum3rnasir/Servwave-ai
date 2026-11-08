/* =============================================================================
   SectionCard - Storybook stories, phase 12a pass.

   WHY THIS FILE EXISTS. Before DesignSystemPage was retired, its "Card
   headers (SectionCard)" section was the only place this component's tinted
   header band was rendered outside a real page - and DesignSystemPage's own
   examples were static screenshots, not an interactive catalog. SectionCard
   is a real, widely-shared primitive (17 real call sites across
   estimates/jobs/crm/communication/reports at the time this file was
   written), not a job-specific component despite its directory - retiring
   the page without a replacement would have deleted its only designer-
   facing documentation.

   TWO EXPORTS, ONE FILE. This module exports both `SectionCard` (the card
   itself) and `SectionLabel` (an in-card sub-section header bound to a
   trailing hairline rule). `meta.component` names SectionCard, the primary
   export; SectionLabel gets its own dedicated stories further down using
   `render`, matching the pattern `KpiTile.stories.tsx` already uses for
   `KpiTile`'s own secondary export `KpiStrip`.

   ZERO NEW APPEARANCE TOKENS AUTHORED IN THIS FILE'S OWN className
   ATTRIBUTES. `components/jobs/overview` carries no `DIR_CEILINGS` entry
   (unlike `components/patterns`), so there is no hard ceiling here - but
   every element in these stories is still built from shipped primitives
   (Text, Stack, Badge, Button) with LAYOUT-only classNames where a raw div
   is unavoidable, matching the house style established for every other
   story in this program rather than leaning on the absence of a ceiling.
   ============================================================================= */
import type { Meta, StoryObj } from '@storybook/react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Stack } from '@/components/ui/stack';
import { Text } from '@/components/ui/text';

import { SectionCard, SectionLabel } from './SectionCard';

const meta = {
  title: 'Jobs/SectionCard',
  component: SectionCard,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The standard Job Command Center card: a tinted, bordered header band (reading the --card-header token) over a white body, with a small accent bar giving the header its own identity. `tone="ai"` swaps the band for the lavender wash reserved for AI surfaces. Omitting `children` renders just the header band, e.g. a collapsed AI card.',
      },
    },
  },
  argTypes: {
    title: { control: 'text', description: 'Card title shown in the header band.' },
    icon: { control: false, description: 'Rendered before the title in the band, e.g. an AI sparkle badge.' },
    titleSuffix: {
      control: false,
      description: 'Inline, immediately after the title - counts like "(2)" or "(Internal)".',
    },
    meta: {
      control: false,
      description: 'Right-aligned header slot - pills, action buttons, a collapse chevron.',
    },
    tone: {
      control: { type: 'inline-radio' },
      options: ['default', 'ai'],
      description: '"ai" uses the lavender wash + tinted band reserved for AI surfaces. Defaults to "default".',
    },
    headerClassName: {
      control: false,
      description: 'Overrides the header band fill - e.g. "bg-surface-light" for a minimal white header.',
    },
    titleClassName: { control: false, description: 'Overrides the title text classes.' },
    bodyClassName: { control: false, description: 'Overrides the body padding/classes.' },
    children: {
      control: false,
      description: 'Body content. Omit to render just the header band - a real, distinct code path.',
    },
  },
} satisfies Meta<typeof SectionCard>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The default shape: a title and a body. */
export const Default: Story = {
  args: {
    title: 'Customer & Contact',
    children: (
      <Text as="p" size="sm" tone="secondary">
        Shipped default - reads the --card-header token (tokens.css), a faint tint distinct from
        both the white body and the grey canvas.
      </Text>
    ),
  },
};

/** `headerClassName="bg-surface-light"` - a minimal white header, delineated by the hairline + accent bar alone. */
export const MinimalHeader: Story = {
  args: {
    title: 'Customer & Contact',
    headerClassName: 'bg-surface-light',
    children: (
      <Text as="p" size="sm" tone="secondary">
        Minimal alternative - white header delineated by a hairline plus the ocean accent bar.
      </Text>
    ),
  },
};

/** `tone="ai"` swaps the band and accent bar for the lavender wash reserved for AI surfaces. */
export const AiTone: Story = {
  args: {
    title: 'AI Operations Insights',
    tone: 'ai',
    children: (
      <Text as="p" size="sm" tone="secondary">
        AI cards keep their lavender wash and tinted band - unchanged by any other tone.
      </Text>
    ),
  },
};

/** `titleSuffix` renders inline, immediately after the title - a count or a qualifier. */
export const WithTitleSuffix: Story = {
  args: {
    title: 'Line Items',
    titleSuffix: (
      <Text as="span" size="sm" tone="secondary">
        {' '}
        (12)
      </Text>
    ),
    children: (
      <Text as="p" size="sm" tone="secondary">
        Twelve line items on this estimate.
      </Text>
    ),
  },
};

/** `meta` is a right-aligned header slot - pills, action buttons, a collapse chevron. */
export const WithMetaActions: Story = {
  args: {
    title: 'Payments',
    meta: (
      <Stack direction="horizontal" gap={2} align="center">
        <Badge>Paid</Badge>
        <Button variant="ghost" tone="subtle" size="sm">
          Edit
        </Button>
      </Stack>
    ),
    children: (
      <Text as="p" size="sm" tone="secondary">
        $4,250.00 collected across 2 payments.
      </Text>
    ),
  },
};

/**
 * `children` omitted entirely - only the header band renders, no body. A
 * real, distinct code path (a collapsed AI card uses exactly this shape),
 * not a degenerate case.
 */
export const HeaderOnly: Story = {
  args: {
    title: 'AI Operations Insights',
    tone: 'ai',
  },
};

/**
 * `SectionLabel` - SectionCard's sibling export, an in-card sub-section
 * header bound to a trailing hairline rule so it reads unmistakably as "a
 * new section starts here" rather than an orphaned label floating between
 * groups. `action` sits after the rule when set.
 */
export const InCardSectionLabel: Story = {
  args: { title: 'Ignored - see render' },
  render: () => (
    <SectionCard title="Job Details">
      <Stack gap={4}>
        <div>
          <SectionLabel>Schedule</SectionLabel>
          <Text as="p" size="sm" tone="secondary">
            Tomorrow, 9:00 AM - 11:00 AM
          </Text>
        </div>
        <div>
          <SectionLabel action={<Button variant="ghost" tone="subtle" size="sm">Edit</Button>}>
            Assigned Technician
          </SectionLabel>
          <Text as="p" size="sm" tone="secondary">
            Dana Whitfield
          </Text>
        </div>
      </Stack>
    </SectionCard>
  ),
};
