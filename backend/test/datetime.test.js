import { describe, it, expect } from 'vitest';
import {
  isValidTimezone, toUserDate, userTodayStr, shiftDateStr, diffDays, weekdayOfDateStr,
  resolveTimezone, localDayOf, localHourOf, localWeekdayOf, formatLocalHHMM,
  localDayStartUtc, localDayRangeUtc,
} from '../utils/datetime.js';

// Pure unit tests for the date helpers that underpin streaks, statistics and
// the analytics time-bucketing. No DB or app needed.
describe('datetime utils', () => {
  describe('isValidTimezone', () => {
    it('accepts real IANA zones and rejects junk', () => {
      expect(isValidTimezone('UTC')).toBe(true);
      expect(isValidTimezone('Europe/Istanbul')).toBe(true);
      expect(isValidTimezone('Not/AZone')).toBe(false);
      expect(isValidTimezone('')).toBe(false);
      expect(isValidTimezone(null)).toBe(false);
    });
  });

  describe('shiftDateStr', () => {
    it('shifts forward and backward', () => {
      expect(shiftDateStr('2026-06-08', 1)).toBe('2026-06-09');
      expect(shiftDateStr('2026-06-08', -1)).toBe('2026-06-07');
      expect(shiftDateStr('2026-06-08', 0)).toBe('2026-06-08');
    });

    it('crosses month and year boundaries', () => {
      expect(shiftDateStr('2026-01-31', 1)).toBe('2026-02-01');
      expect(shiftDateStr('2026-12-31', 1)).toBe('2027-01-01');
      expect(shiftDateStr('2026-01-01', -1)).toBe('2025-12-31');
    });

    it('handles leap vs non-leap February', () => {
      expect(shiftDateStr('2024-02-28', 1)).toBe('2024-02-29');   // leap
      expect(shiftDateStr('2026-02-28', 1)).toBe('2026-03-01');   // non-leap
    });

    it('is DST-safe (pure UTC math, no skipped days)', () => {
      expect(shiftDateStr('2026-03-07', 1)).toBe('2026-03-08');
      expect(shiftDateStr('2026-03-08', 1)).toBe('2026-03-09');
    });
  });

  describe('diffDays', () => {
    it('computes whole-day differences (to - from)', () => {
      expect(diffDays('2026-06-08', '2026-06-08')).toBe(0);
      expect(diffDays('2026-06-08', '2026-06-09')).toBe(1);
      expect(diffDays('2026-06-09', '2026-06-08')).toBe(-1);
      expect(diffDays('2026-01-01', '2026-12-31')).toBe(364);
    });
  });

  describe('weekdayOfDateStr', () => {
    it('returns 0=Sun..6=Sat independent of server tz', () => {
      expect(weekdayOfDateStr('2026-06-07')).toBe(0);   // Sunday
      expect(weekdayOfDateStr('2026-06-08')).toBe(1);   // Monday
      expect(weekdayOfDateStr('2026-06-13')).toBe(6);   // Saturday
    });
  });

  describe('toUserDate / userTodayStr', () => {
    it('rolls the calendar day across timezones', () => {
      const d = new Date('2026-06-08T23:30:00Z');   // 8th in UTC, 9th in Istanbul (+3)
      expect(toUserDate(d, 'UTC').dateStr).toBe('2026-06-08');
      expect(toUserDate(d, 'Europe/Istanbul').dateStr).toBe('2026-06-09');
    });

    it('rolls the hour-of-day across zones', () => {
      const d = new Date('2026-06-08T12:00:00Z');
      expect(toUserDate(d, 'UTC').hour).toBe(12);
      expect(toUserDate(d, 'America/New_York').hour).toBe(8);   // EDT (UTC-4)
    });

    it('falls back to UTC for an unknown timezone', () => {
      const d = new Date('2026-06-08T23:30:00Z');
      expect(toUserDate(d, 'Not/AZone').dateStr).toBe('2026-06-08');
    });

    it('userTodayStr returns a YYYY-MM-DD string', () => {
      expect(userTodayStr('UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('day bucketing near midnight', () => {
    it('resolveTimezone accepts a string or a user doc, else UTC', () => {
      expect(resolveTimezone('Africa/Cairo')).toBe('Africa/Cairo');
      expect(resolveTimezone({ settings: { timezone: 'Asia/Tokyo' } })).toBe('Asia/Tokyo');
      expect(resolveTimezone({ settings: { timezone: 'Mars/Base' } })).toBe('UTC');
      expect(resolveTimezone(null)).toBe('UTC');
    });

    it('an event at 23:59 local stays on that day; 00:00 local is the next', () => {
      // Cairo is UTC+3 in summer (EEST, DST since 2023).
      expect(localDayOf(new Date('2026-06-08T20:59:59Z'), 'Africa/Cairo')).toBe('2026-06-08');
      expect(localDayOf(new Date('2026-06-08T21:00:00Z'), 'Africa/Cairo')).toBe('2026-06-09');
      // Same instants in UTC land on the 8th both times.
      expect(localDayOf(new Date('2026-06-08T21:00:00Z'), 'UTC')).toBe('2026-06-08');
    });

    it('a negative-offset evening is still "today" locally while UTC is tomorrow', () => {
      const d = new Date('2026-06-09T02:30:00Z');            // 22:30 on the 8th in New York (EDT)
      expect(localDayOf(d, 'America/New_York')).toBe('2026-06-08');
      expect(localHourOf(d, 'America/New_York')).toBe(22);
      expect(localWeekdayOf(d, 'America/New_York')).toBe(1);  // Monday
      expect(formatLocalHHMM(d, 'America/New_York')).toBe('22:30');
    });

    it('handles half-hour offsets', () => {
      expect(localDayOf(new Date('2026-01-01T18:29:00Z'), 'Asia/Kolkata')).toBe('2026-01-01');
      expect(localDayOf(new Date('2026-01-01T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-01-02');
    });

    it('localDayStartUtc is the exact local midnight instant', () => {
      expect(localDayStartUtc('2026-06-09', 'Africa/Cairo').toISOString()).toBe('2026-06-08T21:00:00.000Z');
      expect(localDayStartUtc('2026-06-09', 'UTC').toISOString()).toBe('2026-06-09T00:00:00.000Z');
      expect(localDayStartUtc('2026-01-01', 'Asia/Kolkata').toISOString()).toBe('2025-12-31T18:30:00.000Z');
    });

    it('local days are 23h/25h across DST transitions', () => {
      const hours = (r) => (r.end - r.start) / 3_600_000;
      expect(hours(localDayRangeUtc('2026-03-08', 'America/New_York'))).toBe(23);   // spring forward
      expect(hours(localDayRangeUtc('2026-11-01', 'America/New_York'))).toBe(25);   // fall back
      expect(hours(localDayRangeUtc('2026-03-29', 'Europe/London'))).toBe(23);
      expect(hours(localDayRangeUtc('2026-06-09', 'Africa/Cairo'))).toBe(24);
    });

    it('handles zones whose clocks skip midnight (Santiago DST start)', () => {
      const start = localDayStartUtc('2026-09-06', 'America/Santiago');
      expect(localDayOf(start, 'America/Santiago')).toBe('2026-09-06');
      expect(localDayOf(new Date(start.getTime() - 1), 'America/Santiago')).toBe('2026-09-05');
    });

    it('every instant in a range buckets to that day', () => {
      const { start, end } = localDayRangeUtc('2026-11-01', 'America/New_York');
      for (let t = start.getTime(); t < end.getTime(); t += 15 * 60_000) {
        expect(localDayOf(new Date(t), 'America/New_York')).toBe('2026-11-01');
      }
      expect(localDayOf(end, 'America/New_York')).toBe('2026-11-02');
    });
  });
});
