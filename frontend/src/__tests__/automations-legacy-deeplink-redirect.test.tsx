// Regression test for the App.tsx `/automations/:id/edit` legacy deep-link
// redirect. That route is nested under two pathless wrapper routes
// (AppLayout, ProtectedRoute — see App.tsx) exactly like the real route
// tree, which matters here: with react-router's default `relative="route"`,
// a bare `<Navigate to=".." />` from a multi-segment leaf whose ancestors
// contribute no path segments resolves to "/" (strips the whole leaf path),
// not to the parent resource "/automations/:id" as intended. `relative="path"`
// is required to get the intended one-segment-up resolution.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate, Outlet, useParams } from 'react-router-dom';

function BuilderStub() {
  const { id } = useParams();
  return <div>builder:{id}</div>;
}

function Dashboard() {
  return <div>dashboard</div>;
}

function TreeUnderTest({ relative }: { relative?: 'path' | 'route' }) {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      {/* Two pathless wrapper levels, matching AppLayout > ProtectedRoute
          in the real App.tsx route tree. */}
      <Route element={<Outlet />}>
        <Route element={<Outlet />}>
          <Route path="/automations/:id" element={<BuilderStub />} />
          <Route
            path="/automations/:id/edit"
            element={<Navigate to=".." relative={relative} replace />}
          />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

describe('legacy /automations/:id/edit deep link (App.tsx route shape)', () => {
  it('relative="path" resolves to /automations/:id, not the dashboard', () => {
    render(
      <MemoryRouter initialEntries={['/automations/123/edit']}>
        <TreeUnderTest relative="path" />
      </MemoryRouter>
    );
    expect(screen.getByText('builder:123')).toBeInTheDocument();
    expect(screen.queryByText('dashboard')).not.toBeInTheDocument();
  });

  it('sanity check: default relative="route" would have landed on "/" (the bug)', () => {
    render(
      <MemoryRouter initialEntries={['/automations/123/edit']}>
        <TreeUnderTest />
      </MemoryRouter>
    );
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });
});
