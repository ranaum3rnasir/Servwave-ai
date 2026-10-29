/**
 * Mobile slice 75 follow-up: the mobile gate's `vendorConsole` check accepts exactly two Firefox
 * engine warnings and nothing else from the phone dialer's embed script.
 *
 * Firefox prints `Feature Policy: Skipping unsupported feature name "clipboard-read"` (and the same
 * for `clipboard-write`) once or twice per load, because the dialer's own embed script sets
 * `allow="clipboard-read; clipboard-write;"` on the iframe it creates. Our code sets nothing, and the
 * lines are engine warnings, not console calls, so no ServWave code can silence them. Ran accepted
 * them on 2026-10-09 as an extension of the 2026-10-08 embedded-frame exception
 * (allowlist.json, acceptedExceptions.vendorConsole).
 *
 * The exemption is narrow on purpose. Every part of the match is asserted both ways here: the
 * warning kind, the feature name, and the source script. A line that fails any part is judged.
 */
import { describe, expect, it } from 'vitest';
import { isDialerFeaturePolicyWarning } from '../../e2e/mobile/console-lines';
import { findVendorTerms } from '../../e2e/mobile/vendor-terms';

const SCRIPT = 'https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js';

/**
 * The line exactly as Firefox prints it (Playwright's console message text, measured on the gate's
 * Firefox project 2026-10-09): the feature name sits in typographic quotes.
 */
const firefoxLine = (feature: string, file: string = SCRIPT, line = 3) =>
  `[JavaScript Warning: "Feature Policy: Skipping unsupported feature name “${feature}”." {file: "${file}" line: ${line}}]`;

describe('the dialer Feature Policy warnings are an accepted exception', () => {
  it('both exact Firefox lines from the dialer script are exempt', () => {
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read'), '')).toBe(true);
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-write'), '')).toBe(true);
  });

  it('is exempt with straight quotes around the feature name too', () => {
    const straight = (feature: string) => firefoxLine(feature).replace(/“|”/g, '"');
    expect(isDialerFeaturePolicyWarning(straight('clipboard-read'), '')).toBe(true);
    expect(isDialerFeaturePolicyWarning(straight('clipboard-write'), '')).toBe(true);
  });

  it('is exempt whichever line number the script reports, and when the console message also carries the script as its location', () => {
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', SCRIPT, 1), SCRIPT)).toBe(true);
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-write', SCRIPT, 3), SCRIPT)).toBe(true);
  });

  it('is exempt when the text carries no file but the message location is the dialer script', () => {
    const bare = 'Feature Policy: Skipping unsupported feature name \u201Cclipboard-write\u201D.';
    expect(isDialerFeaturePolicyWarning(bare, SCRIPT)).toBe(true);
  });

  it('the exempt lines really are lines the vendor check would otherwise fail', () => {
    // Guards against a test that passes only because the lines were never offenders.
    expect(findVendorTerms([{ source: 'console', text: firefoxLine('clipboard-read') }]).length).toBeGreaterThan(0);
  });

  it('the same text from a different source is NOT exempt', () => {
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://app.servwave.com/assets/index-abc.js'), '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-write', 'https://evil.example/ctm-phone-embed-1.0.js'), '')).toBe(false);
    // A look-alike host that merely contains the vendor host.
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://app.calltrackingmetrics.com.evil.test/ctm-phone-embed-1.0.js'), '')).toBe(false);
    // The vendor host as a path segment or a name suffix of some other host.
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://evil.example/app.calltrackingmetrics.com/ctm-phone-embed-1.0.js'), '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://notcalltrackingmetrics.com/ctm-phone-embed-1.0.js'), '')).toBe(false);
    // Not https, a prefix before the URL, a suffix after the script name.
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'http://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js'), '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'blob:https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js'), '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js?x=1'), '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://app.calltrackingmetrics.com/ctm-phone-embed-1.0.js/extra'), '')).toBe(false);
    // The vendor host but a different script.
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://app.calltrackingmetrics.com/other-widget.js'), '')).toBe(false);
    // The vendor's script name in a query string or a different path.
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://app.calltrackingmetrics.com/x/ctm-phone-embed-1.0.js'), '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read', 'https://app.calltrackingmetrics.com/a.js?f=/ctm-phone-embed-1.0.js'), '')).toBe(false);
    // No file in the text and a location that is not the dialer script.
    const bare = 'Feature Policy: Skipping unsupported feature name \u201Cclipboard-read\u201D.';
    expect(isDialerFeaturePolicyWarning(bare, 'https://app.servwave.com/assets/index-abc.js')).toBe(false);
    expect(isDialerFeaturePolicyWarning(bare, '')).toBe(false);
  });

  it('a text that names the dialer script but whose message came from another script is NOT exempt', () => {
    expect(isDialerFeaturePolicyWarning(firefoxLine('clipboard-read'), 'https://app.servwave.com/assets/index-abc.js')).toBe(false);
  });

  it('a different feature name from the dialer script is NOT exempt', () => {
    for (const feature of ['camera', 'microphone', 'geolocation', 'autoplay', 'clipboard', 'clipboard-read-write', 'clipboard-reads', 'xclipboard-write', '']) {
      expect(isDialerFeaturePolicyWarning(firefoxLine(feature), ''), feature).toBe(false);
    }
  });

  it('another warning kind about the same features is NOT exempt', () => {
    const other = (msg: string) => `[JavaScript Warning: "${msg}" {file: "${SCRIPT}" line: 3}]`;
    expect(isDialerFeaturePolicyWarning(other('Feature Policy: Some other problem "clipboard-read".'), '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(other('Permissions Policy: Skipping unsupported feature name \u201Cclipboard-read\u201D.'), '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(other('Feature Policy: Skipping unsupported feature name \u201Cclipboard-read\u201D. Call tracking metrics'), '')).toBe(false);
  });

  it('an arbitrary vendor-named line from the dialer script is NOT exempt', () => {
    expect(isDialerFeaturePolicyWarning('[CTM Embed] access request failed', SCRIPT)).toBe(false);
    expect(isDialerFeaturePolicyWarning('attach ctm-phone-skeleton', SCRIPT)).toBe(false);
    expect(isDialerFeaturePolicyWarning(`Failed to load https://app.calltrackingmetrics.com/phoneapp/embed_device`, SCRIPT)).toBe(false);
    expect(isDialerFeaturePolicyWarning(`[JavaScript Warning: "Something else" {file: "${SCRIPT}" line: 3}]`, SCRIPT)).toBe(false);
  });

  it('one allowed line cannot carry a second, unrelated line along with it', () => {
    expect(isDialerFeaturePolicyWarning(`${firefoxLine('clipboard-read')}\n[CTM Embed] device embed script failed`, '')).toBe(false);
    expect(isDialerFeaturePolicyWarning(`[CTM Embed] boom ${firefoxLine('clipboard-read')}`, '')).toBe(false);
  });
});
