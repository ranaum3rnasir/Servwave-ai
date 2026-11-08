import { describe, it, expect } from "vitest";
import {
  countCallsOnDay,
  computeRange,
  DEMO_NOW,
} from "@/components/communication/phone/shared";

// H8 hub polish — the pure helpers behind the truthful "Calls today" KPI and the
// Calls date-range presets.
//
// These used to build their day bounds with setHours(), i.e. on whichever machine
// happened to render, and the file said so: "Both parse dates in LOCAL time … so
// these assertions are timezone-independent". The assertions were; the PRODUCT was
// not. "Today" selected a different set of calls for the New York owner than for
// the Manila dispatcher looking at the same org. Both bounds are now the ORG's
// midnights, so every case below fixes an explicit zone and asserts the answer does
// not move when the viewer does.

const NY = "America/New_York";
const MANILA = "Asia/Manila";

describe("countCallsOnDay", () => {
  const call = (startedAt: string) => ({ startedAt });

  it("counts only the calls on the anchor's ORG calendar day", () => {
    // 2026-07-14 in New York runs 04:00Z that day to 03:59:59Z the next.
    const anchor = new Date("2026-07-14T16:00:00Z");
    const calls = [
      call("2026-07-14T04:00:01Z"), // 12:00:01 AM NY → in
      call("2026-07-15T03:59:00Z"), // 11:59 PM NY   → in
      call("2026-07-14T03:59:59Z"), // 11:59:59 PM NY on the 13th → out
      call("2026-07-15T04:00:00Z"), // midnight NY on the 15th    → out
    ];
    expect(countCallsOnDay(calls, anchor, NY)).toBe(2);
  });

  it("scopes the day to the ORG, so the same pair counts differently per org", () => {
    // Anchor: noon Aug 5 in New York, but already 00:00 Aug 6 in Manila.
    const anchor = new Date("2026-08-05T16:00:00Z");
    // Call: 6:00 AM Aug 5 in New York, 6:00 PM Aug 5 in Manila.
    const at = "2026-08-05T10:00:00Z";
    // A New York org: anchor day is Aug 5 and so is the call → counted.
    expect(countCallsOnDay([call(at)], anchor, NY)).toBe(1);
    // A Manila org: anchor day is already Aug 6, the call is still Aug 5 → not.
    expect(countCallsOnDay([call(at)], anchor, MANILA)).toBe(0);
  });

  it("gives one answer per org however the two instants are expressed", () => {
    // Same moments, written as a different offset. If any local getter survived
    // in the day math these would drift apart.
    const anchor = new Date("2026-08-05T16:00:00Z");
    const anchorAlt = new Date("2026-08-05T12:00:00-04:00");
    const at = "2026-08-05T10:00:00Z";
    const atAlt = "2026-08-05T18:00:00+08:00";
    for (const tz of [NY, MANILA]) {
      expect(countCallsOnDay([call(atAlt)], anchorAlt, tz)).toBe(
        countCallsOnDay([call(at)], anchor, tz),
      );
    }
  });

  it("uses the demo anchor so demo-seeded data reads a real 'today'", () => {
    const calls = [call("2026-05-30T14:00:00Z"), call("2026-05-29T14:00:00Z")];
    expect(countCallsOnDay(calls, DEMO_NOW, NY)).toBe(1);
  });

  it("ignores unparseable timestamps and empty lists", () => {
    expect(
      countCallsOnDay([call("not-a-date")], new Date("2026-07-14T16:00:00Z"), NY),
    ).toBe(0);
    expect(countCallsOnDay([], new Date(), NY)).toBe(0);
  });
});

describe("computeRange", () => {
  it("anchors the demo presets on the ORG's midnights", () => {
    // DEMO_NOW is 2026-05-30T23:59:59Z → still 7:59 PM May 30 in New York.
    const r = computeRange("today", "", "", NY, true);
    expect(r.start?.toISOString()).toBe("2026-05-30T04:00:00.000Z");
    expect(r.end?.toISOString()).toBe("2026-05-31T03:59:59.999Z");
  });

  it("makes 'Last 7 days' seven whole org days, inclusive", () => {
    const r = computeRange("7d", "", "", NY, true);
    expect(r.start?.toISOString()).toBe("2026-05-24T04:00:00.000Z");
    expect(r.end?.toISOString()).toBe("2026-05-31T03:59:59.999Z");
    // 7 days minus the DST hour is not the point — May has none — but the span
    // must be a whole number of days either way.
    const spanMs = (r.end as Date).getTime() - (r.start as Date).getTime() + 1;
    expect(spanMs).toBe(7 * 86_400_000);
  });

  it("starts 'This month' on the first of the ORG's month", () => {
    const r = computeRange("month", "", "", NY, true);
    expect(r.start?.toISOString()).toBe("2026-05-01T04:00:00.000Z");
  });

  it("reads the custom day tokens in the org zone, not the viewer's", () => {
    const ny = computeRange("custom", "2026-08-06", "2026-08-06", NY, true);
    expect(ny.start?.toISOString()).toBe("2026-08-06T04:00:00.000Z");
    expect(ny.end?.toISOString()).toBe("2026-08-07T03:59:59.999Z");

    const manila = computeRange("custom", "2026-08-06", "2026-08-06", MANILA, true);
    expect(manila.start?.toISOString()).toBe("2026-08-05T16:00:00.000Z");
    expect(manila.end?.toISOString()).toBe("2026-08-06T15:59:59.999Z");
  });

  it("leaves 'All time' unbounded", () => {
    const r = computeRange("all", "", "", NY, true);
    expect(r.start).toBeNull();
    expect(r.end).toBeNull();
  });
});
