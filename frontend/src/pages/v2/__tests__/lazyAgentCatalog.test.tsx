/**
 * Mobile slice 61 (PERF-01): the agent catalog modal is mounted by the staff layout on every
 * screen, but it is opened rarely, and it carries the whole agent catalog with it. The layout
 * now mounts a wrapper that loads the modal's code the first time the store says "open".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const mockModuleLoaded = vi.hoisted(() => ({ value: false }));

vi.mock('@/components/ai-center/AiCenterModal', () => {
  mockModuleLoaded.value = true;
  return { AiCenterModal: () => <div role="dialog" aria-label="Agent catalog">catalog</div> };
});

import { useAiCenterStore } from '@/stores/aiCenterStore';
import { LazyAgentCatalog } from '../LazyAgentCatalog';

describe('LazyAgentCatalog', () => {
  beforeEach(() => {
    useAiCenterStore.setState({ open: false, focusAgentId: null });
  });

  it('renders nothing, and has not loaded the modal, while the catalog has never been opened', () => {
    render(<LazyAgentCatalog />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mockModuleLoaded.value).toBe(false);
  });

  it('loads and shows the modal once the store opens it', async () => {
    render(<LazyAgentCatalog />);
    act(() => useAiCenterStore.getState().openModal());
    expect(await screen.findByRole('dialog', { name: 'Agent catalog' })).toBeTruthy();
    expect(mockModuleLoaded.value).toBe(true);
  });

  it('is already open when mounted with the store open (a deep link into one agent)', async () => {
    useAiCenterStore.setState({ open: true, focusAgentId: 'x' });
    render(<LazyAgentCatalog />);
    expect(await screen.findByRole('dialog', { name: 'Agent catalog' })).toBeTruthy();
  });
});
