/**
 * FormField adoption - the six single-field lead/estimate lifecycle dialogs
 * (phase 11b/11d, "formfield-reason-dialogs" batch).
 *
 * Every one of these dialogs shipped the same hand-wired shape:
 *
 *   <div><Label>Reason *</Label><Textarea ... /></div>
 *
 * a Label with NO htmlFor next to a control with NO id - the exact unwired
 * pair FormField.tsx's header names as the real defect behind the a11y
 * backlog. The conversion wraps that pair in FormField and nothing else. So
 * this file exists to prove two things a normal render test would not:
 *
 * 1. THE WIRING NOW EXISTS. `label[for]` and the control's `id` are one
 *    generated value, not two hand-typed literals, and on the one site that
 *    already had an id (`ai-desc`) that id is PRESERVED, not regenerated.
 *
 * 2. NOTHING ELSE MOVED. Assertions on class are byte-exact string equality,
 *    deliberately, not `toHaveClass` token checks - a token check still
 *    passes when a conversion silently ADDS an appearance override, and
 *    "the control renders exactly the primitive's own stock classes, with
 *    no override leaked in during the wrap" is precisely what a composition-
 *    layer adoption has to demonstrate. Same rigour as
 *    components/patterns/__tests__/FormField.test.tsx's own layering-rule
 *    assertion (`expect(root.getAttribute('class')).toBe(...)`).
 *
 * The four constants below are the primitives' own rendered output, captured
 * from a real render, not retyped from the source files. If a primitive's
 * base string legitimately changes, these move with it - what they lock is
 * that the CALL SITE contributes nothing to them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import api from '@/lib/axios';
import { renderWithProviders } from './helpers';
import { CancelLeadDialog, CancelWalkthroughDialog, MarkLostDialog } from '@/pages/v2/leads/components/leadDialogs';
import { CancelEstimateDialog } from '@/components/estimates/CancelEstimateDialog';
import { DeclineEstimateInternalDialog } from '@/components/estimates/DeclineEstimateInternalDialog';
import { AiImagePanel } from '@/features/estimate-workspace/components/AiImagePanel';

const mockApi = vi.mocked(api);

/** FormField's root - a Stack at its default gap (1.5 / 6px), no className. */
const FIELD_ROOT_CLASS = 'flex flex-col gap-1.5';

/** components/ui/textarea.tsx at `size="md"` with no call-site className. */
const STOCK_TEXTAREA_CLASS =
  'flex min-h-[80px] w-full rounded border-2 border-transparent bg-text-primary/5 px-4 py-2 text-base ' +
  'transition-colors duration-300 placeholder:text-text-soft hover:border-primary focus-visible:outline-none ' +
  'focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50 md:text-sm';

/** components/ui/label.tsx at its propless default (size sm, tone subtle, weight bold). */
const STOCK_LABEL_CLASS =
  'text-sm leading-none transition-colors duration-300 hover:text-text-primary ' +
  'has-[+input:is(:hover,:focus)]:text-text-primary has-[+textarea:is(:hover,:focus)]:text-text-primary ' +
  'peer-disabled:cursor-not-allowed peer-disabled:opacity-70 text-text-secondary font-bold';

/** components/ui/select.tsx's SelectTrigger at `size="md"` with no call-site className. */
const STOCK_SELECT_TRIGGER_CLASS =
  'flex h-10 w-full items-center justify-between rounded border border-border bg-surface-light px-3 py-2 ' +
  'text-sm ring-offset-surface-light data-[placeholder]:text-text-secondary focus:outline-none focus:ring-2 ' +
  'focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [&>span]:line-clamp-1';

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.post.mockResolvedValue({ data: {} });
});

/**
 * The textarea dialogs are structurally identical, so they are asserted as one
 * table rather than near-copies: the placeholder is the only thing that
 * differs between them, and a table makes a future one a one-line addition
 * instead of a copy-paste.
 *
 * The three lead dialogs (Mark Lost, Cancel Lead, Cancel Walkthrough) were
 * here too, in their legacy components/leads/ form. Those files were dead -
 * the lead page renders pages/v2/leads/components/leadDialogs - and were
 * deleted (code review #13); the routed ones, on the kit's own Label and
 * Textarea, are covered by the block at the end of this file.
 */
const TEXTAREA_DIALOGS = [
  {
    name: 'CancelEstimateDialog',
    render: () => <CancelEstimateDialog open onOpenChange={vi.fn()} estimateId="est-1" />,
    placeholder: 'Why is this estimate being archived?',
    submit: 'Archive Estimate',
  },
] as const;

describe('FormField adoption - id/aria wiring the hand-rolled pairs never had', () => {
  for (const { name, render, placeholder } of TEXTAREA_DIALOGS) {
    it(`${name}: one generated id reaches both the label's htmlFor and the textarea`, () => {
      renderWithProviders(render());
      const textarea = screen.getByPlaceholderText(placeholder);
      const label = screen.getByText('Reason *');

      expect(label.tagName).toBe('LABEL');
      expect(textarea.id).toBeTruthy();
      expect(label.getAttribute('for')).toBe(textarea.id);
      // The a11y payoff stated as the API contract, not just as matching
      // strings: the control is reachable BY ITS LABEL.
      expect(screen.getByLabelText('Reason *')).toBe(textarea);
    });

    it(`${name}: sets no aria-describedby or aria-invalid, since no hint or error is passed`, () => {
      renderWithProviders(render());
      const textarea = screen.getByPlaceholderText(placeholder);
      expect(textarea).not.toHaveAttribute('aria-describedby');
      expect(textarea).not.toHaveAttribute('aria-invalid');
    });
  }
});

describe('FormField adoption - nothing but the wiring moved (byte-exact classes)', () => {
  for (const { name, render, placeholder } of TEXTAREA_DIALOGS) {
    it(`${name}: renders FormField's stock root, label and textarea class strings verbatim`, () => {
      renderWithProviders(render());
      const textarea = screen.getByPlaceholderText(placeholder);
      const label = screen.getByText('Reason *');

      expect(label.parentElement?.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
      expect(label.getAttribute('class')).toBe(STOCK_LABEL_CLASS);
      expect(textarea.getAttribute('class')).toBe(STOCK_TEXTAREA_CLASS);
    });

    it(`${name}: keeps the label and control ADJACENT siblings`, () => {
      // Not incidental DOM trivia. label.tsx's own base string carries
      // `has-[+textarea:is(:hover,:focus)]:text-text-primary` - an
      // ADJACENT-SIBLING rule. The pre-conversion markup put the label
      // directly before the textarea, so hovering the control lit the label
      // up; a wrapper inserted between them during the conversion would kill
      // that with no class-string diff to notice it by.
      renderWithProviders(render());
      const label = screen.getByText('Reason *');
      expect(label.nextElementSibling).toBe(screen.getByPlaceholderText(placeholder));
    });
  }
});

describe('FormField adoption - behaviour, props and handlers are untouched', () => {
  for (const { name, render, placeholder, submit } of TEXTAREA_DIALOGS) {
    it(`${name}: value/onChange still drive the destructive button's disabled state`, async () => {
      const user = userEvent.setup();
      renderWithProviders(render());

      // Queried by ROLE, not text: a dialog can give its DialogTitle the same
      // words as its confirm button ("Archive Estimate"), so a bare getByText
      // matches two nodes.
      expect(screen.getByRole('button', { name: submit })).toBeDisabled();
      await user.type(screen.getByPlaceholderText(placeholder), 'Because');
      expect(screen.getByRole('button', { name: submit })).not.toBeDisabled();
    });
  }
});

describe('FormField adoption - the compound control takes the render-prop path', () => {
  const renderDecline = () =>
    renderWithProviders(
      <DeclineEstimateInternalDialog
        open
        onOpenChange={vi.fn()}
        estimateId="est-1"
        estimateNumber="E00001"
      />
    );

  it('lands the id on the Select TRIGGER, the real labelable element', () => {
    // `Select` here is Radix's Root, which renders NO DOM node of its own -
    // FormField's cloneElement path would hand it the id and it would
    // vanish, leaving label[for] pointing at nothing (worse than the
    // unwired state it replaced). The render prop puts the id where a
    // <label for> can actually resolve it. No new FormField prop involved:
    // this is the escape hatch FormField already documents.
    renderDecline();
    const label = screen.getByText('Reason *');
    const trigger = screen.getByRole('combobox');

    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(trigger.id);
  });

  it('leaves the trigger rendering its stock class string, no override leaked in', () => {
    renderDecline();
    expect(screen.getByRole('combobox').getAttribute('class')).toBe(STOCK_SELECT_TRIGGER_CLASS);
    expect(screen.getByText('Reason *').parentElement?.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
  });

  it('keeps the placeholder and the empty-reason disabled state', () => {
    renderDecline();
    expect(screen.getByText('Why did this estimate lose?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Decline Estimate' })).toBeDisabled();
  });
});

describe('FormField adoption - an explicit htmlFor preserves an id that already existed', () => {
  it('AiImagePanel: keeps ai-desc on the textarea and on the label, and keeps its own className', () => {
    renderWithProviders(
      <AiImagePanel open itemName="Pump" itemDetail="1hp" onApply={vi.fn()} onClose={vi.fn()} />
    );
    const label = screen.getByText('Description');
    const textarea = screen.getByLabelText('Description');

    expect(textarea.id).toBe('ai-desc');
    expect(label.getAttribute('for')).toBe('ai-desc');
    // The call site's own size/resize override is a legitimate one and must
    // survive the wrap byte-for-byte - the merge order below is exactly what
    // this file rendered before the conversion.
    expect(textarea.getAttribute('class')).toBe(
      STOCK_TEXTAREA_CLASS.replace('flex min-h-[80px] w-full', 'flex w-full') +
        ' min-h-[80px] resize-none'
    );
    expect(label.parentElement?.getAttribute('class')).toBe(FIELD_ROOT_CLASS);
  });
});

describe('the routed lead reason dialogs (pages/v2/leads/components/leadDialogs)', () => {
  const LEAD_DIALOGS = [
    { name: 'MarkLostDialog', render: () => <MarkLostDialog open onOpenChange={vi.fn()} leadId="lead-1" />, placeholder: 'Why was this lead lost?', submit: 'Mark Lost' },
    { name: 'CancelLeadDialog', render: () => <CancelLeadDialog open onOpenChange={vi.fn()} leadId="lead-1" />, placeholder: 'Why is this lead being cancelled?', submit: 'Cancel Lead' },
    { name: 'CancelWalkthroughDialog', render: () => <CancelWalkthroughDialog open onOpenChange={vi.fn()} leadId="lead-1" />, placeholder: 'Why is this walkthrough being cancelled?', submit: 'Cancel Walkthrough' },
  ] as const;

  for (const { name, render, placeholder, submit } of LEAD_DIALOGS) {
    it(`${name}: the reason is reachable by its label, and the submit waits for one`, async () => {
      const user = userEvent.setup();
      renderWithProviders(render());
      expect(screen.getByLabelText('Reason *')).toBe(screen.getByPlaceholderText(placeholder));
      expect(screen.getByRole('button', { name: submit })).toBeDisabled();
      await user.type(screen.getByLabelText('Reason *'), 'Because');
      expect(screen.getByRole('button', { name: submit })).not.toBeDisabled();
    });
  }

  it('MarkLostDialog: posts the reason to the mark-lost endpoint', async () => {
    const user = userEvent.setup();
    renderWithProviders(<MarkLostDialog open onOpenChange={vi.fn()} leadId="lead-1" />);

    await user.type(screen.getByPlaceholderText('Why was this lead lost?'), 'No budget');
    await user.click(screen.getByRole('button', { name: 'Mark Lost' }));

    expect(mockApi.post).toHaveBeenCalledWith('/api/leads/lead-1/mark-lost', {
      lost_reason: 'No budget',
    });
  });
});
