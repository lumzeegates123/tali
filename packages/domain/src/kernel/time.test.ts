import { describe, expect, it } from "vitest";
import { KernelError } from "./errors.js";
import { BusinessDate, parseTimeZoneId } from "./time.js";

describe("BusinessDate", () => {
  it("parses and prints YYYY-MM-DD", () => {
    const date = BusinessDate.parse("2026-09-27");
    expect([date.year, date.month, date.day]).toEqual([2026, 9, 27]);
    expect(date.toString()).toBe("2026-09-27");
    expect(JSON.stringify({ date })).toBe('{"date":"2026-09-27"}');
  });

  it("validates calendar dates, including leap years", () => {
    expect(BusinessDate.parse("2024-02-29").toString()).toBe("2024-02-29");
    expect(BusinessDate.parse("2000-02-29").toString()).toBe("2000-02-29");
    for (const invalid of ["2026-02-29", "1900-02-29", "2026-13-01", "2026-04-31", "2026-9-27", "0000-01-01", ""]) {
      expect(() => BusinessDate.parse(invalid)).toThrow(KernelError);
    }
  });

  it("adds days across month, year and leap boundaries", () => {
    expect(BusinessDate.parse("2026-12-31").addDays(1).toString()).toBe("2027-01-01");
    expect(BusinessDate.parse("2024-02-28").addDays(1).toString()).toBe("2024-02-29");
    expect(BusinessDate.parse("2026-03-01").addDays(-1).toString()).toBe("2026-02-28");
  });

  it("compares dates", () => {
    const a = BusinessDate.parse("2026-09-27");
    const b = BusinessDate.parse("2026-09-28");
    expect(a.compare(b)).toBe(-1);
    expect(b.compare(a)).toBe(1);
    expect(a.equals(BusinessDate.of(2026, 9, 27))).toBe(true);
  });

  it("derives the date of an instant in the business time zone, not UTC", () => {
    const instant = new Date("2026-09-27T23:30:00Z");
    expect(BusinessDate.fromInstant(instant, parseTimeZoneId("Africa/Lagos")).toString()).toBe("2026-09-28");
    expect(BusinessDate.fromInstant(instant, parseTimeZoneId("UTC")).toString()).toBe("2026-09-27");
    expect(BusinessDate.fromInstant(instant, parseTimeZoneId("America/New_York")).toString()).toBe("2026-09-27");
  });

  it("rejects invalid instants and time zones", () => {
    expect(() => BusinessDate.fromInstant(new Date(Number.NaN), parseTimeZoneId("UTC"))).toThrow(KernelError);
    expect(() => parseTimeZoneId("Mars/Olympus_Mons")).toThrow(KernelError);
  });
});
