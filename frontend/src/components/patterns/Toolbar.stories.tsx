/* =============================================================================
   Toolbar - Storybook stories, phase 12 composition-layer pass.

   ZERO APPEARANCE TOKENS AUTHORED IN THIS FILE'S OWN className ATTRIBUTES,
   by constraint: `DIR_CEILINGS['components/patterns'] = 0` and
   component-api-guard's `targetFiles()` does not exempt `.stories.tsx`.
   See .storybook/main.ts's header for the full asymmetry note.

   ONE HONEST WRINKLE, STATED RATHER THAN HIDDEN. Toolbar's own header
   documents that a leading search icon needs the caller to supply BOTH the
   styled icon and the matching left padding on the input (`pl-8`), because
   padding matches the guard's `APPEARANCE_RE` and Toolbar is forbidden from
   hardcoding it. A story is a caller, so `WithSearchIcon` below supplies
   both through the documented pass-through props exactly as the v1
   `VendorsPage` did (page since deleted, PRD-1). That padding travels as a value
   inside `searchInputProps`, never as this file's own `className=` attribute
   - which is the same channel the real call sites use, not a way around the
   ceiling. If that ever starts counting, the right fix is to give the
   pattern a real leading-icon slot with its own padding contract, NOT to
   carve `.stories.tsx` out of the guard.

   THE SEARCH HALF IS OPT-IN, AND THAT IS A REAL STORY. `Toolbar` renders no
   search box at all unless `onSearchChange` is passed - `FiltersOnly` below
   pins that, because a fixed search slot every adopter must fill was
   explicitly not the design.

   `filters` AND `actions` ARE PLAIN SLOTS, NOT A CLOSED LIST. The measured
   occupants are heterogeneous (a Select, a segmented toggle, a Switch, a
   bare count) and none of it is Toolbar's to restyle - it owns the ROW, not
   what sits in it. The stories reflect that by putting different things in
   the same slot rather than showing one blessed arrangement.
   ============================================================================= */
import * as React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Stack } from '@/components/ui/stack';
import { Text } from '@/components/ui/text';

import { Toolbar } from './Toolbar';

/**
 * The search box is controlled, so every story that renders one needs real
 * state behind it - a fixed `searchValue` would render a box that ignores
 * typing.
 *
 * That state lives in this NAMED component rather than inline in each
 * story's `render` arrow, because a hook called inside an anonymous
 * `render` function violates `react-hooks/rules-of-hooks`: React only
 * guarantees hook identity inside a component or another hook, and an arrow
 * assigned to a `render` key is neither - even though Storybook renders it
 * as one, which is what makes the mistake easy to ship.
 */
function SearchableToolbar(props: Omit<React.ComponentProps<typeof Toolbar>, 'searchValue' | 'onSearchChange'>) {
  const [value, setValue] = React.useState('');
  return <Toolbar {...props} searchValue={value} onSearchChange={setValue} />;
}

const meta = {
  title: 'Patterns/Toolbar',
  component: Toolbar,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component:
          'The search-and-filter row shared by the inventory pages. Owns the ROW - the search box, the spacing, and the right-aligned action group - and nothing about what a caller puts in the `filters` or `actions` slots. Named `Toolbar` rather than `FilterBar` because `components/filters/FilterBar.tsx` already exists in this tree for a different concept (a facet-popover trigger).',
      },
    },
  },
  argTypes: {
    searchValue: { control: false, description: 'Controlled value of the search box.' },
    onSearchChange: {
      control: false,
      description:
        'Fired with the new search string. ALSO the switch that decides whether a search box renders at all - omit it and Toolbar renders only `filters` and `actions`.',
    },
    searchPlaceholder: { control: 'text', description: 'Placeholder for the search box.' },
    searchIcon: {
      control: false,
      description:
        'A caller-styled node rendered in a leading, absolutely-positioned slot. Toolbar does not colour an icon itself - no Icon tone primitive exists to delegate to, and a raw colour class here would breach the directory ceiling.',
    },
    searchInputProps: {
      control: false,
      description:
        "Forwarded to the internal search `Input` - e.g. `{ size: 'xs', className: 'pl-8' }` to pair with `searchIcon`. The left padding an icon needs is the caller's to pass, for the same ceiling reason.",
    },
    filters: { control: false, description: 'Filter controls, rendered after the search box.' },
    actions: { control: false, description: 'Right-aligned actions - a count, an export button, a create button.' },
    gap: {
      control: { type: 'select' },
      options: [0, 1, 2, 3, 4, 6],
      description: "Space between the search box and each filter. Defaults to 2 (8px), matching `Inline`'s own default.",
    },
  },
} satisfies Meta<typeof Toolbar>;

export default meta;

type Story = StoryObj<typeof meta>;

/** Search only - the minimum useful Toolbar. */
export const Default: Story = {
  args: { searchPlaceholder: 'Search vendors...' },
  render: (args) => <SearchableToolbar {...args} />,
};

/**
 * The v1 `VendorsPage` shape (page since deleted): a caller-supplied icon plus the matching
 * `pl-8` on the input, both passed through documented props. See the header
 * note on why the padding is the caller's to supply.
 */
export const WithSearchIcon: Story = {
  args: { searchPlaceholder: 'Search vendors...' },
  render: (args) => (
    <SearchableToolbar
      {...args}
      searchIcon={<Search className="h-4 w-4" aria-hidden />}
      searchInputProps={{ size: 'xs', className: 'pl-8' }}
    />
  ),
};

/**
 * No `onSearchChange`, so no search box renders at all. The search half is
 * opt-in rather than a fixed slot every adopter has to fill.
 */
export const FiltersOnly: Story = {
  args: {},
  render: () => (
    <Toolbar
      filters={
        <Stack direction="horizontal" gap={2} align="center">
          <Button variant="outline" size="sm">
            All statuses
          </Button>
          <Button variant="outline" size="sm">
            Any location
          </Button>
        </Stack>
      }
    />
  ),
};

/** `actions` is pushed to the right edge of the row, away from search and filters. */
export const WithActions: Story = {
  args: { searchPlaceholder: 'Search vendors...' },
  render: (args) => (
    <SearchableToolbar {...args} actions={<Button size="sm">New vendor</Button>} />
  ),
};

/**
 * All three regions at once - the shape the inventory pages actually ship.
 * The `actions` slot here holds a count and a button, which is deliberately
 * two different kinds of thing: the slot is not a closed list.
 */
export const FullRow: Story = {
  args: { searchPlaceholder: 'Search inventory...' },
  render: (args) => (
    <SearchableToolbar
      {...args}
      searchIcon={<Search className="h-4 w-4" aria-hidden />}
      searchInputProps={{ size: 'xs', className: 'pl-8' }}
      filters={
        <Stack direction="horizontal" gap={2} align="center">
          <Button variant="outline" size="sm">
            In stock
          </Button>
          <Button variant="outline" size="sm">
            Any vendor
          </Button>
        </Stack>
      }
      actions={
        <Stack direction="horizontal" gap={2} align="center">
          <Badge>142 items</Badge>
          <Button size="sm">Add item</Button>
        </Stack>
      }
    />
  ),
};

/**
 * `gap` changes the seam between the search box and each filter. The row
 * wraps by default, so a narrow container stacks rather than overflowing.
 */
export const GapScale: Story = {
  args: {},
  render: () => (
    <Stack gap={6}>
      {([1, 2, 4] as const).map((gap) => (
        <Stack key={gap} gap={1}>
          <Text size="xs" tone="secondary">
            gap={gap}
            {gap === 2 ? ' (default)' : ''}
          </Text>
          <SearchableToolbar
            gap={gap}
            searchPlaceholder="Search..."
            filters={
              <Button variant="outline" size="sm">
                All statuses
              </Button>
            }
          />
        </Stack>
      ))}
    </Stack>
  ),
};
