// The Calls screen opens scoped to the last 30 days and the search box searches
// only inside that window, while saying nothing about it. A six-week-old call
// therefore answered "No calls match your search." — which reads as "that call
// is not in the system" for a call that IS in the system.
//
// describeSearchScope is the pure half of the fix: it names the window that was
// actually searched, and returns null when the scope is unbounded (nothing was
// hidden, so there is nothing to disclose). No React, no clock of its own — the
// same five arguments computeRange takes, so the description can never describe
// a different window than the rows came from.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { describeSearchScope } from "@/components/communication/phone/shared";

const NY = "America/New_York";
const MANILA = "Asia/Manila";

// Pinned so preset descriptions are asserted against a fixed calendar rather
// than the day the suite happens to run.
const REAL_NOW = new Date("2026-08-20T16:00:00Z"); // Aug 20 2026, noon in NY

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(REAL_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const scope = (
  preset: Parameters<typeof describeSearchScope>[0],
  tz = NY,
  isDemo = false,
) => describeSearchScope(preset, "", "", tz, isDemo);

describe("describeSearchScope — bounded presets name their window", () => {
  it("names 'Today' with the single org day it covers", () => {
    expect(scope("today")).toBe("Today (Aug 20th, 2026 – Aug 20th, 2026)");
  });

  it("names the trailing-window presets with their real bounds", () => {
    expect(scope("7d")).toBe("Last 7 days (Aug 14th, 2026 – Aug 20th, 2026)");
    expect(scope("30d")).toBe("Last 30 days (Jul 22nd, 2026 – Aug 20th, 2026)");
    expect(scope("90d")).toBe("Last 90 days (May 23rd, 2026 – Aug 20th, 2026)");
  });

  it("names 'This month' from the org's first-of-month", () => {
    expect(scope("month")).toBe("This month (Aug 1st, 2026 – Aug 20th, 2026)");
  });

  it("uses the SAME words as the date-range picker's own preset labels", () => {
    // The sentence is only useful if the user can find the named entry in the
    // picker; a paraphrase ("the past month") would send them hunting.
    for (const label of ["Today", "Last 7 days", "Last 30 days", "This month", "Last 90 days"]) {
      expect(
        [scope("today"), scope("7d"), scope("30d"), scope("month"), scope("90d")].some((s) =>
          s?.startsWith(`${label} (`),
        ),
      ).toBe(true);
    }
  });
});

describe("describeSearchScope — unbounded scope is null", () => {
  it("returns null for 'All time'", () => {
    // Not a string like "All time": null is the CONTRACT for "nothing was
    // hidden", and it is what suppresses both the disclosure and the widening
    // action. A truthy label here would offer to widen an already-open range.
    expect(scope("all")).toBeNull();
  });

  it("returns null for a 'custom' range with neither bound filled in", () => {
    expect(describeSearchScope("custom", "", "", NY)).toBeNull();
  });
});

describe("describeSearchScope — custom ranges describe their actual bounds", () => {
  it("describes a two-sided custom range", () => {
    expect(describeSearchScope("custom", "2026-06-01", "2026-06-15", NY)).toBe(
      "Custom range (Jun 1st, 2026 – Jun 15th, 2026)",
    );
  });

  it("describes a one-sided custom range from either side", () => {
    expect(describeSearchScope("custom", "2026-06-01", "", NY)).toBe(
      "Custom range (From Jun 1st, 2026)",
    );
    expect(describeSearchScope("custom", "", "2026-06-15", NY)).toBe(
      "Custom range (Until Jun 15th, 2026)",
    );
  });
});

describe("describeSearchScope — reads the ORG clock, not the viewer's", () => {
  it("anchors presets to the org timezone", () => {
    // 2026-08-20T16:00Z is Aug 20 in New York and Aug 21 in Manila; the
    // description must name the day the rows were filtered on.
    expect(scope("today", NY)).toBe("Today (Aug 20th, 2026 – Aug 20th, 2026)");
    expect(scope("today", MANILA)).toBe("Today (Aug 21st, 2026 – Aug 21st, 2026)");
  });

  it("uses the DEMO anchor for demo orgs, matching the mock rows on screen", () => {
    // Demo orgs render fixed call data seeded around 2026-05-30 and computeRange
    // anchors their presets to DEMO_NOW. If the description used the real clock
    // it would name Aug while the table showed May — the description must not be
    // able to disagree with the range it describes.
    expect(scope("today", NY, true)).toBe("Today (May 30th, 2026 – May 30th, 2026)");
    expect(scope("30d", NY, true)).toBe("Last 30 days (May 1st, 2026 – May 30th, 2026)");
    expect(scope("today", NY, true)).not.toBe(scope("today", NY, false));
  });
});
