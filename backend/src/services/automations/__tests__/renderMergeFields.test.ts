import { describe, it, expect } from 'vitest';
import { renderMergeFields } from '../renderMergeFields';

const CTX: Record<string, string> = {
  'customer.first_name': 'Sarah',
  'org.name': 'Blue Ridge Plumbing',
  'job.scheduled_time': '9:00 AM',
};

describe('renderMergeFields', () => {
  it('substitutes known fields', () => {
    expect(renderMergeFields('Hi {{customer.first_name}}, from {{org.name}}!', CTX, { html: false }))
      .toBe('Hi Sarah, from Blue Ridge Plumbing!');
  });

  it('leaves unknown fields literal so typos are visible to the author', () => {
    expect(renderMergeFields('Hi {{customer.frist_name}}!', CTX, { html: false }))
      .toBe('Hi {{customer.frist_name}}!');
  });

  it('renders known-but-empty values as empty string', () => {
    expect(renderMergeFields('Time: {{job.scheduled_time}}', { 'job.scheduled_time': '' }, { html: false }))
      .toBe('Time: ');
  });

  it('escapes values in html mode (user-controlled names cannot inject markup)', () => {
    const ctx = { 'customer.first_name': '<script>alert(1)</script>' };
    const out = renderMergeFields('Hi {{customer.first_name}}', ctx, { html: true });
    expect(out).toBe('Hi &lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('does not escape in plain-text mode (SMS keeps raw characters)', () => {
    const ctx = { 'customer.first_name': "O'Brien & Sons" };
    expect(renderMergeFields('{{customer.first_name}}', ctx, { html: false }))
      .toBe("O'Brien & Sons");
  });

  it('handles repeated fields and adjacent braces', () => {
    expect(renderMergeFields('{{org.name}} {{org.name}}', CTX, { html: false }))
      .toBe('Blue Ridge Plumbing Blue Ridge Plumbing');
  });

  it('does NOT resolve inherited Object.prototype keys — {{constructor}}/{{__proto__}} stay literal', () => {
    expect(renderMergeFields('a {{constructor}} b', CTX, { html: false })).toBe('a {{constructor}} b');
    expect(renderMergeFields('a {{__proto__}} b', CTX, { html: false })).toBe('a {{__proto__}} b');
  });
});

// ── "If empty, fill with" (merge-field fallbacks) ─────────────────────────────
//
// Spec: md_files/specs/scheduling/2026-09-13-customer-scheduling-notifications-and-visit-milestones.md
// A send step carries a per-field fallback map. The renderer substitutes the fallback ONLY when
// the field is known and its value is empty; an unknown field stays literal even when a fallback
// is declared for it, and a fallback is escaped in html mode exactly as a value is.

describe('renderMergeFields - fallbacks', () => {
  it('substitutes the fallback when a known field is empty', () => {
    const out = renderMergeFields(
      "Who's coming: {{technician.names}}.",
      { 'technician.names': '' },
      { html: false, fallbacks: { 'technician.names': 'the crew' } },
    );
    expect(out).toBe("Who's coming: the crew.");
  });

  it('escapes a fallback in html mode exactly as it escapes a value', () => {
    const out = renderMergeFields(
      'Hi {{customer.first_name}}',
      { 'customer.first_name': '' },
      { html: true, fallbacks: { 'customer.first_name': '<b>there</b> & "friends"' } },
    );
    expect(out).toBe('Hi &lt;b&gt;there&lt;/b&gt; &amp; &quot;friends&quot;');
  });

  it('renders a known-but-empty field as empty when no fallback is declared for it', () => {
    // The customer fallback IS applied in the same template, so a renderer that never reads
    // the map fails here too, not only one that invents a default for the undeclared field.
    const out = renderMergeFields(
      "Hi {{customer.first_name}}, who's coming: {{technician.names}}.",
      { 'customer.first_name': '', 'technician.names': '' },
      { html: false, fallbacks: { 'customer.first_name': 'there' } },
    );
    expect(out).toBe("Hi there, who's coming: .");
  });

  it('leaves an unknown field literal even when a fallback is declared for it', () => {
    // The known field beside it takes its fallback, so the literal token is what separates
    // "unknown stays visible" from "fallbacks are not consulted at all".
    const out = renderMergeFields(
      'Hi {{customer.frist_name}}, {{customer.first_name}}',
      { 'customer.first_name': '' },
      { html: false, fallbacks: { 'customer.frist_name': 'there', 'customer.first_name': 'friend' } },
    );
    expect(out).toBe('Hi {{customer.frist_name}}, friend');
  });

  it('does not use a fallback when the value is present', () => {
    // One map, two fields: the present one keeps its value while the empty one takes its
    // fallback, so this cannot pass on a renderer that never reads the map.
    const out = renderMergeFields(
      '{{technician.names}} / {{customer.first_name}}',
      { 'technician.names': 'Mike Torres', 'customer.first_name': '' },
      { html: false, fallbacks: { 'technician.names': 'Our team', 'customer.first_name': 'there' } },
    );
    expect(out).toBe('Mike Torres / there');
  });
});
