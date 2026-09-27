import { KernelError } from "./errors";

declare const timeZoneBrand: unique symbol;

/** An IANA time zone identifier accepted by the runtime's Intl implementation, e.g. "Africa/Lagos". */
export type TimeZoneId = string & { readonly [timeZoneBrand]: true };

export function parseTimeZoneId(value: string): TimeZoneId {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new KernelError("INVALID_TIME_ZONE", `"${value}" is not a supported IANA time zone`);
  }
  return value as TimeZoneId;
}

const DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
const MS_PER_DAY = 86_400_000;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * A calendar date in the business's time zone (no time, no zone), stored as
 * PostgreSQL DATE. Serialized as "YYYY-MM-DD".
 */
export class BusinessDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;

  private constructor(year: number, month: number, day: number) {
    this.year = year;
    this.month = month;
    this.day = day;
    Object.freeze(this);
  }

  static of(year: number, month: number, day: number): BusinessDate {
    const valid =
      Number.isSafeInteger(year) &&
      Number.isSafeInteger(month) &&
      Number.isSafeInteger(day) &&
      year >= 1 &&
      year <= 9999 &&
      month >= 1 &&
      month <= 12 &&
      day >= 1 &&
      day <= daysInMonth(year, month);
    if (!valid) {
      throw new KernelError("INVALID_BUSINESS_DATE", `${year}-${month}-${day} is not a valid calendar date`);
    }
    return new BusinessDate(year, month, day);
  }

  static parse(value: string): BusinessDate {
    const match = DATE_PATTERN.exec(value);
    if (match === null) {
      throw new KernelError("INVALID_BUSINESS_DATE", `"${value}" is not a YYYY-MM-DD date`);
    }
    return BusinessDate.of(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  /** The calendar date of an instant in the given IANA time zone. */
  static fromInstant(instant: Date, timeZone: TimeZoneId): BusinessDate {
    if (Number.isNaN(instant.getTime())) {
      throw new KernelError("INVALID_BUSINESS_DATE", "cannot derive a business date from an invalid instant");
    }
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    }).formatToParts(instant);
    const part = (type: "year" | "month" | "day"): number =>
      Number(parts.find((candidate) => candidate.type === type)?.value);
    return BusinessDate.of(part("year"), part("month"), part("day"));
  }

  addDays(days: number): BusinessDate {
    if (!Number.isSafeInteger(days)) {
      throw new KernelError("INVALID_BUSINESS_DATE", `days must be an integer, received ${days}`);
    }
    const shifted = new Date(Date.UTC(this.year, this.month - 1, this.day) + days * MS_PER_DAY);
    return BusinessDate.of(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
  }

  compare(other: BusinessDate): -1 | 0 | 1 {
    const a = this.toString();
    const b = other.toString();
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }

  equals(other: BusinessDate): boolean {
    return this.compare(other) === 0;
  }

  toString(): string {
    const pad = (value: number, width: number): string => value.toString().padStart(width, "0");
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }

  toJSON(): string {
    return this.toString();
  }
}
