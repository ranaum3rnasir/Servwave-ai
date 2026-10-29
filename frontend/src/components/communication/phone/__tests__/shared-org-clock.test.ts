// The phone kernel's four label helpers, on the org clock.
//
// Every one of these used to read a browser-local getter (`d.getDate()`,
// `toLocaleTimeString` with no `timeZone`), so a call row said "Wed Aug 5th ·
// 9:00 PM" to its New York owner and "Thu Aug 6th · 9:00 AM" to the Manila
// dispatcher looking at the same call.
//
// The assertions are deliberately phrased as EQUIVALENCE across viewer zones
// rather than "the label is correct". A correctness-only suite passes in whatever
// zone the runner happens to use and proves nothing about the bug.
import { describe, it, expect } from "vitest";
import {
  shortTime,
  timeLabel,
  dayLabel,
  dateNumeric,
  longDate,
  rangeSubLabel,
} from "@/components/communication/phone/shared";

const NY = "America/New_York";
const MANILA = "Asia/Manila";
const LONDON = "Europe/London";

// Prod job 698675's stored instant: 9:00 PM Aug 5 in New York, 9:00 AM Aug 6 in
// Manila. The value that started this whole line of work.
const JOB_698675 = "2026-08-06T01:00:00.000Z";

describe("phone label helpers render on the ORG clock", () => {
  it("shortTime and timeLabel agree with each other and with the org", () => {
    expect(shortTime(JOB_698675, NY)).toBe("9:00 PM");
    expect(shortTime(JOB_698675, MANILA)).toBe("9:00 AM");
    expect(timeLabel(JOB_698675, NY)).toBe(shortTime(JOB_698675, NY));
  });

  it("dayLabel keeps weekday, month and ordinal on the SAME day", () => {
    // The old version mixed sources: weekday and month from toLocaleDateString,
    // the number from d.getDate(). Both read the viewer, so they agreed with each
    // other but not with the org - and would have disagreed with each other had
    // only one been converted.
    expect(dayLabel(JOB_698675, NY)).toBe("Wed Aug 5th");
    expect(dayLabel(JOB_698675, MANILA)).toBe("Thu Aug 6th");
  });

  it("dateNumeric reports the org's calendar date", () => {
    expect(dateNumeric(JOB_698675, NY)).toBe("08-05-2026");
    expect(dateNumeric(JOB_698675, MANILA)).toBe("08-06-2026");
  });

  it("gets the ordinal suffix right across the awkward run", () => {
    const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T16:00:00Z`;
    const suffixes = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map((d) =>
      dayLabel(at(d), NY).split(" ").pop(),
    );
    expect(suffixes).toEqual([
      "1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st",
    ]);
  });

  it("longDate and rangeSubLabel read a range on the org clock", () => {
    const start = new Date("2026-08-06T04:00:00.000Z"); // midnight Aug 6, NY
    const end = new Date("2026-08-07T03:59:59.999Z"); // last ms of Aug 6, NY
    expect(longDate(start, NY)).toBe("Aug 6th, 2026");
    expect(rangeSubLabel({ start, end }, NY)).toBe("Aug 6th, 2026 – Aug 6th, 2026");
    // Same pair of instants, a different org: a single NY day spans two Manila ones.
    expect(rangeSubLabel({ start, end }, MANILA)).toBe("Aug 6th, 2026 – Aug 7th, 2026");
  });

  it("renders an unbounded range without touching a clock at all", () => {
    expect(rangeSubLabel({ start: null, end: null }, NY)).toBe("All recorded calls");
  });

  it("returns '' rather than 'Invalid Date' for a missing timestamp", () => {
    expect(shortTime("", NY)).toBe("");
    expect(dayLabel("", NY)).toBe("");
    expect(dateNumeric("", NY)).toBe("");
  });

  it("gives one answer per org no matter which zone the process runs in", () => {
    // The real regression guard. These helpers take `tz` explicitly, so this only
    // fails if a local getter creeps back in - which is exactly what happened
    // before, and what would happen again in a partial conversion.
    for (const tz of [NY, MANILA, LONDON]) {
      const once = [
        shortTime(JOB_698675, tz),
        dayLabel(JOB_698675, tz),
        dateNumeric(JOB_698675, tz),
        timeLabel(JOB_698675, tz),
      ];
      // Same inputs re-expressed at a different offset must land identically.
      const alt = "2026-08-05T21:00:00-04:00";
      const twice = [
        shortTime(alt, tz),
        dayLabel(alt, tz),
        dateNumeric(alt, tz),
        timeLabel(alt, tz),
      ];
      expect(twice).toEqual(once);
    }
  });
});
