/**
 * Mobile slice 66: the leave guard against a REAL browser router (not a mocked navigate), so the
 * history marker and the router's own history agree about where "back" goes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';

import { useLeaveGuard } from '@/hooks/useLeaveGuard';
import { useSettingsGuard } from '@/stores/settingsGuard.store';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function Form() {
  const guard = useLeaveGuard(true);
  return (
    <div>
      <p>form</p>
      <button type="button" onClick={guard.leaveBack}>Cancel</button>
      <button type="button" onClick={() => guard.finish('/saved')}>Finish</button>
      {guard.leaveDialog}
    </div>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Where />
      <Routes>
        <Route path="/list" element={<p>list</p>} />
        <Route path="/form" element={<Form />} />
        <Route path="/saved" element={<p>saved</p>} />
      </Routes>
    </BrowserRouter>
  );
}

const where = () => screen.getByTestId('where').textContent;
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

beforeEach(() => {
  useSettingsGuard.setState({ isDirty: false, pendingLeave: null });
  window.history.pushState(null, '', '/list');
  window.history.pushState(null, '', '/form');
});

describe('useLeaveGuard on a real router', () => {
  it('Cancel then Discard goes back to the page before the form', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(where()).toBe('/form');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(where()).toBe('/list'));
  });

  it('the browser Back asks; Keep editing; then Cancel and Discard still goes back', async () => {
    const user = userEvent.setup();
    render(<App />);
    act(() => { window.history.back(); });
    expect(await screen.findByText('Discard your changes?')).toBeInTheDocument();
    expect(where()).toBe('/form');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    await settle();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(where()).toBe('/list'));
  });

  it('the browser Back then Discard goes back to the page before the form', async () => {
    const user = userEvent.setup();
    render(<App />);
    act(() => { window.history.back(); });
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(where()).toBe('/list'));
  });

  it('finish goes to the saved page, and Back from there lands on the form entry, as without a guard', async () => {
    const user = userEvent.setup();
    render(<App />);
    await settle();
    await user.click(screen.getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(where()).toBe('/saved'));
    act(() => { window.history.back(); });
    await waitFor(() => expect(where()).toBe('/form'));
  });
});
