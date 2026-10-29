/**
 * FormField adoption - inventory dialog raw <label> triage batch.
 *
 * SignatureField's typed-name input had a label sitting ABOVE a single sibling
 * input with NO htmlFor/id wiring at all - the exact shape FormField exists to
 * fix. Everywhere else in this batch either wraps its control (checkbox rows,
 * file-drop zones, the local `Field({ label, children })` helper) or is a
 * compound control outside this batch's fit criteria, and was deliberately
 * left alone (see the inline comments at those sites). The PO email dialog
 * that shared this batch was removed outright - ServWave does not send POs.
 *
 * This file pins the id-wiring contract per CLAUDE.md's TDD rule: a "renders
 * without crashing" test would not catch a regression where the label and
 * control drift apart, or where the wrap silently breaks the field's own
 * value/onChange.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './helpers';
import { SignatureField } from '@/components/inventory/SignatureField';

describe('SignatureField - typed-name FormField adoption', () => {
  it('wires one generated id from the "Type your full name to sign" label to the input', () => {
    renderWithProviders(<SignatureField role="Tech Pickup Sign-out" onSign={vi.fn()} />);
    const label = screen.getByText('Type your full name to sign');
    const input = screen.getByLabelText('Type your full name to sign');

    expect(label.tagName).toBe('LABEL');
    expect(input.id).toBeTruthy();
    expect(label.getAttribute('for')).toBe(input.id);
  });

  it('still drives the live cursive preview by value/onChange after the wrap', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SignatureField role="Tech Pickup Sign-out" onSign={vi.fn()} />);

    const input = screen.getByLabelText('Type your full name to sign');
    await user.type(input, 'Jane Contractor');
    expect(input).toHaveValue('Jane Contractor');
    expect(screen.getByText('Jane Contractor')).toBeInTheDocument();
  });
});
