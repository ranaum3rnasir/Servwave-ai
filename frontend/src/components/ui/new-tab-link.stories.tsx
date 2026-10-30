import type { Meta, StoryObj } from '@storybook/react';

import { NewTabLink } from './new-tab-link';

const VARIANTS = ['text', 'button', 'chip', 'customer-id'] as const;

const meta = {
  title: 'UI/NewTabLink',
  component: NewTabLink,
  tags: ['autodocs'],
  args: {
    children: 'Open customer',
    href: '/customers/42',
  },
  argTypes: {
    variant: {
      control: { type: 'select' },
      options: VARIANTS,
      description:
        'text (inline link), button (outline button look), chip (pill, 32px high, 44px on phones), customer-id (12.5px, 600, tabular figures).',
    },
    className: { control: false },
  },
} satisfies Meta<typeof NewTabLink>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The inline text link. */
export const Text: Story = { args: { variant: 'text' } };

/** The outline button look. */
export const Button: Story = { args: { variant: 'button', children: 'Create invoice', href: '/invoices/new' } };

/** The pill. */
export const Chip: Story = { args: { variant: 'chip', children: 'Invoice 1042', href: '/invoices/1042' } };

/** The customer-ID link. */
export const CustomerId: Story = { args: { variant: 'customer-id', children: 'C-1042', href: '/customers/42' } };

/** Every look side by side. */
export const Variants: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-4">
      <NewTabLink variant="text" href="/customers/42">
        Open customer
      </NewTabLink>
      <NewTabLink variant="button" href="/invoices/new">
        Create invoice
      </NewTabLink>
      <NewTabLink variant="chip" href="/invoices/1042">
        Invoice 1042
      </NewTabLink>
      <NewTabLink variant="customer-id" href="/customers/42">
        C-1042
      </NewTabLink>
    </div>
  ),
};
