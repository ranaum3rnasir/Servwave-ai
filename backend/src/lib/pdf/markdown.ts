type InlineNode = { text: string; bold?: boolean };
type ParagraphNode = { text: string | InlineNode[]; style: 'paragraph' };
type ListNode = { ul: string[] } | { ol: string[] };
type Node = ParagraphNode | ListNode;

const HTML_TAG_RE = /<[^>]*>/g;
const BOLD_RE = /\*\*(.+?)\*\*/g;

/**
 * Markdown characters that are syntax, never words: emphasis, headings, list bullets, block
 * quotes, rules and table pipes. Whatever is left after removing them (and inline HTML, which
 * `markdownToPdfMake` strips too) is what the customer can actually read.
 */
const MARKDOWN_SYNTAX_RE = /[*_~`#>|+\-=\s]/g;

/**
 * True when this copy would put readable text on the page — the test a template applies before
 * printing the heading above it, so an org that has not written its terms yet never sends a
 * document with a bare "Terms:" and nothing under it. NULL, '', whitespace, '**' and '<br>' are
 * all empty; anything with a word, digit or other character of its own is not.
 */
export function hasRenderableContent(input: string | null | undefined): boolean {
  if (input == null) return false;
  return input.replace(HTML_TAG_RE, '').replace(MARKDOWN_SYNTAX_RE, '').length > 0;
}

function parseInline(line: string): ParagraphNode['text'] {
  const stripped = line.replace(HTML_TAG_RE, '');
  if (!BOLD_RE.test(stripped)) return stripped;
  BOLD_RE.lastIndex = 0;
  const parts: InlineNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = BOLD_RE.exec(stripped)) !== null) {
    if (m.index > last) parts.push({ text: stripped.slice(last, m.index) });
    parts.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < stripped.length) parts.push({ text: stripped.slice(last) });
  return parts;
}

export function markdownToPdfMake(input: string): Node[] {
  const safe = input.replace(HTML_TAG_RE, '');
  const blocks = safe.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const out: Node[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.every(l => /^[-*] /.test(l))) {
      out.push({ ul: lines.map(l => l.replace(/^[-*] /, '').trim()) });
    } else if (lines.every(l => /^\d+\. /.test(l))) {
      out.push({ ol: lines.map(l => l.replace(/^\d+\. /, '').trim()) });
    } else {
      out.push({ text: parseInline(block), style: 'paragraph' });
    }
  }
  return out;
}
