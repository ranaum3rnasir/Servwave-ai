import { describe, it, expect } from 'vitest';
import { markdownToPdfMake } from '../markdown';

describe('markdownToPdfMake', () => {
  it('returns a single paragraph for plain text', () => {
    const out = markdownToPdfMake('Hello world.');
    expect(out).toEqual([{ text: 'Hello world.', style: 'paragraph' }]);
  });

  it('splits paragraphs on blank lines', () => {
    const out = markdownToPdfMake('First.\n\nSecond.');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ text: 'First.', style: 'paragraph' });
    expect(out[1]).toEqual({ text: 'Second.', style: 'paragraph' });
  });

  it('parses bold inline', () => {
    const out = markdownToPdfMake('This is **important**.');
    expect(out[0]).toEqual({
      text: [
        { text: 'This is ' },
        { text: 'important', bold: true },
        { text: '.' },
      ],
      style: 'paragraph',
    });
  });

  it('renders bulleted lists', () => {
    const out = markdownToPdfMake('- One\n- Two\n- Three');
    expect(out[0]).toHaveProperty('ul');
    expect((out[0] as any).ul).toEqual(['One', 'Two', 'Three']);
  });

  it('renders numbered lists', () => {
    const out = markdownToPdfMake('1. First\n2. Second');
    expect(out[0]).toHaveProperty('ol');
    expect((out[0] as any).ol).toEqual(['First', 'Second']);
  });

  it('strips raw HTML tags defensively', () => {
    const out = markdownToPdfMake('Hello <script>alert(1)</script>.');
    expect(JSON.stringify(out)).not.toContain('<script>');
  });

  it('handles mixed paragraphs and lists', () => {
    const out = markdownToPdfMake('Intro paragraph.\n\n- Bullet A\n- Bullet B\n\nClosing.');
    expect(out).toHaveLength(3);
    expect((out[0] as any).style).toBe('paragraph');
    expect(out[1]).toHaveProperty('ul');
    expect((out[2] as any).style).toBe('paragraph');
  });
});
