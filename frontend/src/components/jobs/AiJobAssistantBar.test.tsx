import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useAuthStore } from '@/stores/auth.store';
import { AiJobAssistantBar } from './AiJobAssistantBar';

// The AI Agentic Farm is available to every org. This bar is purely a launch pad
// into it and must render regardless of demo status.
function setDemoOrg(isDemo: boolean) {
  vi.mocked(useAuthStore).mockImplementation((selector: (s: any) => unknown) =>
    selector({ user: { id: 'u1', role: 'ADMIN', org_is_demo: isDemo }, isAuthenticated: true }),
  );
}

describe('AiJobAssistantBar — available to all orgs', () => {
  it('renders the assistant bar for a real (non-demo) org', () => {
    setDemoOrg(false);
    render(<AiJobAssistantBar jobNumber="J00051" />);
    expect(screen.getByText('AI Job Assistant')).toBeInTheDocument();
  });

  it('renders the assistant bar for a demo org', () => {
    setDemoOrg(true);
    render(<AiJobAssistantBar jobNumber="J00051" />);
    expect(screen.getByText('AI Job Assistant')).toBeInTheDocument();
  });

  // Assignment is fully manual: assignee_ids is a caller-supplied replace array
  // and nothing computes a tech. There is no competency field and nothing
  // geocodes a user or a job, so the tiles must not promise either basis.
  it('promises no skill- or location-based tech matching', () => {
    setDemoOrg(false);
    const { container } = render(<AiJobAssistantBar jobNumber="J00051" />);
    expect(container.textContent).not.toMatch(/skill/i);
    expect(container.textContent).not.toMatch(/location/i);
  });
});
