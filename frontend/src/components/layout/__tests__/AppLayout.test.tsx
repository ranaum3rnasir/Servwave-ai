/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '@/__tests__/helpers';
import { buildAbility } from '@/lib/ability';
import AppLayout from '../AppLayout';

const adminAbility = buildAbility([{ action: 'manage', subject: 'all' }]);

function renderAppLayoutAt(path: string) {
  return renderWithProviders(
    <Routes>
      <Route element={<AppLayout />}>
        <Route path="/" element={<div>Dashboard Screen</div>} />
        <Route path="/customers" element={<div>Customers Screen</div>} />
      </Route>
    </Routes>,
    { initialEntries: [path], ability: adminAbility }
  );
}

describe('AppLayout', () => {
  it('navigates to the dashboard when the ServWave brand is clicked', async () => {
    const user = userEvent.setup();
    renderAppLayoutAt('/customers');

    expect(screen.getByText('Customers Screen')).toBeInTheDocument();

    // Target the brand link by its exact aria-label — a loose /servwave/i match
    // can collide with other sidebar copy, so pin to the link's own label.
    await user.click(screen.getByRole('link', { name: /servwave dashboard/i }));

    expect(screen.getByText('Dashboard Screen')).toBeInTheDocument();
  });
});
