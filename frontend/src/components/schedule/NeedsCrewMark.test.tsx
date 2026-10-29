import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { NeedsCrewMark } from './NeedsCrewMark';

describe('NeedsCrewMark - the corner notch', () => {
  it('names itself to a screen reader', () => {
    render(<NeedsCrewMark />);
    expect(screen.getByRole('img', { name: /needs crew/i })).toBeInTheDocument();
  });

  // The all-day pill test (allDayPillContent.test.tsx, the #1734 guard) asserts the pill has
  // no "needs crew" TEXT, because words there ate the job number. The notch must stay invisible
  // to that query: it carries its name as a label, never as text content.
  it('has no text content, so a text query cannot find it', () => {
    render(<NeedsCrewMark />);
    expect(screen.queryByText(/needs crew/i)).not.toBeInTheDocument();
  });

  it('is absolutely positioned in the top-right corner - it takes no layout box', () => {
    render(<NeedsCrewMark />);
    const mark = screen.getByRole('img', { name: /needs crew/i });
    expect(mark).toHaveClass('absolute', 'top-0', 'right-0');
  });

  it('paints from the understaffed token, never from the danger token directly', () => {
    render(<NeedsCrewMark />);
    const mark = screen.getByRole('img', { name: /needs crew/i });
    expect(mark).toHaveClass('text-understaffed');
    expect(mark).not.toHaveClass('text-danger');
  });

  it('takes a size class for the 22px all-day pill', () => {
    render(<NeedsCrewMark size="sm" />);
    const mark = screen.getByRole('img', { name: /needs crew/i });
    expect(mark).toHaveClass('h-2.5', 'w-2.5');
  });
});
