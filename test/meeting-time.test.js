// Unit tests for services/meetingTime.js (no database, no network) and for the
// Google Calendar request body built from it: timezone handling, e-mail
// validation/de-duplication and the all-day/no-end edge cases that Google
// rejects. The behaviour of the routes that use these is covered by
// calendar-invitations.test.js.
const mt = require('../services/meetingTime');
const { buildGoogleEventBody, SEND_UPDATES } = require('../services/googleCalendarService');

describe('parseEventInstant — a naive wall-clock string is read in the APPLICATION timezone', () => {
  test('Asia/Manila (UTC+8): 09:00 local is 01:00Z, whatever the server timezone is', () => {
    expect(mt.parseEventInstant('2026-11-10T09:00', 'Asia/Manila').toISOString()).toBe('2026-11-10T01:00:00.000Z');
    expect(mt.parseEventInstant('2026-11-10T21:44', 'Asia/Manila').toISOString()).toBe('2026-11-10T13:44:00.000Z');
  });

  test('a date-only string is midnight in the application timezone', () => {
    expect(mt.parseEventInstant('2026-11-10', 'Asia/Manila').toISOString()).toBe('2026-11-09T16:00:00.000Z');
  });

  test('the same helper is correct for a zone with daylight saving (proves it is not hard-coded to +8)', () => {
    expect(mt.parseEventInstant('2026-01-15T09:00', 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z'); // EST, UTC-5
    expect(mt.parseEventInstant('2026-07-15T09:00', 'America/New_York').toISOString()).toBe('2026-07-15T13:00:00.000Z'); // EDT, UTC-4
  });

  test('an explicit-offset / Z string is taken as that exact instant (older drag-saved events)', () => {
    expect(mt.parseEventInstant('2026-09-19T07:35:00.000Z', 'Asia/Manila').toISOString()).toBe('2026-09-19T07:35:00.000Z');
    expect(mt.parseEventInstant('2026-09-19T15:35:00+08:00', 'Asia/Manila').toISOString()).toBe('2026-09-19T07:35:00.000Z');
  });

  test('impossible or garbage values are rejected, not silently rolled over', () => {
    for (const bad of ['2026-02-31T09:00', '2026-13-01', '2026-11-10T25:00', 'tomorrow', '', null, undefined, 42]) {
      expect(mt.parseEventInstant(bad, 'Asia/Manila')).toBeNull();
    }
  });

  test('APP_TIMEZONE defaults to Asia/Manila', () => {
    const saved = process.env.APP_TIMEZONE;
    delete process.env.APP_TIMEZONE;
    expect(mt.appTimeZone()).toBe('Asia/Manila');
    if (saved !== undefined) process.env.APP_TIMEZONE = saved;
  });
});

describe('eventStartInstant / eventDateOnly', () => {
  test('a timed event starts at its wall-clock time; an all-day event starts at 00:00 of its date', () => {
    expect(mt.eventStartInstant({ start: '2026-11-10T09:00', allDay: false }, 'Asia/Manila').toISOString()).toBe('2026-11-10T01:00:00.000Z');
    expect(mt.eventStartInstant({ start: '2026-11-10', allDay: true }, 'Asia/Manila').toISOString()).toBe('2026-11-09T16:00:00.000Z');
  });

  test('an all-day event saved as a UTC instant (old drag) resolves to the intended Manila date, not the previous day', () => {
    // Nov 10 00:00 Manila == Nov 9 16:00Z — slicing the ISO string used to give Nov 9.
    expect(mt.eventDateOnly('2026-11-09T16:00:00.000Z', 'Asia/Manila')).toBe('2026-11-10');
    expect(mt.eventDateOnly('2026-11-10T09:00', 'Asia/Manila')).toBe('2026-11-10');
  });

  test('formatting is done in the application timezone, independent of the runtime zone', () => {
    const instant = new Date('2026-11-10T01:02:00.000Z');
    expect(mt.formatTimeInTz(instant, 'Asia/Manila')).toBe('9:02 AM');
    expect(mt.formatTimeInTz(instant, 'UTC')).toBe('1:02 AM');
  });
});

describe('e-mail validation and de-duplication', () => {
  test('accepts ordinary addresses, rejects malformed and non-ASCII ones', () => {
    for (const ok of ['a@example.com', 'first.last+tag@sub.example.co.ph', "o'brien@example.org", 'x@my.cspc.edu.ph']) expect(mt.isValidEmail(ok)).toBe(true);
    for (const bad of ['', 'plain', 'a@', '@b.com', 'a@b', 'a b@c.com', 'a..b@c.com', '.a@c.com', 'a.@c.com', 'a@-b.com', 'kcariño@cspc.edu.ph', null, undefined, 5]) {
      expect(mt.isValidEmail(bad)).toBe(false);
    }
  });

  test('uniqueValidEmails lower-cases, drops invalid entries and duplicates, keeps order', () => {
    expect(mt.uniqueValidEmails(['B@x.com', 'a@x.com', 'b@X.COM', 'bad', 'kcariño@cspc.edu.ph', 'a@x.com '])).toEqual(['b@x.com', 'a@x.com']);
    expect(mt.uniqueValidEmails(undefined)).toEqual([]);
  });
});

describe('Google Calendar request body', () => {
  test('a timed event is sent as an exact instant with the application timezone', () => {
    const body = buildGoogleEventBody(
      { title: 'Renewal Talks', location: 'Room 1', description: 'Agenda', start: '2026-11-10T09:00', end: '2026-11-10T10:30', allDay: false },
      ['a@example.com']
    );
    expect(body.summary).toBe('Renewal Talks');
    expect(body.location).toBe('Room 1');
    expect(body.description).toBe('Agenda');
    expect(body.start).toEqual({ dateTime: '2026-11-10T01:00:00.000Z', timeZone: 'Asia/Manila' });
    expect(body.end).toEqual({ dateTime: '2026-11-10T02:30:00.000Z', timeZone: 'Asia/Manila' });
  });

  test('09:00 in Manila is 09:00 Asia/Manila on Google (+08:00), never shifted by the UTC conversion', () => {
    const body = buildGoogleEventBody({ title: 't', start: '2026-11-10T09:00', end: '2026-11-10T10:00' }, ['a@example.com']);
    // what Google Calendar will display: the instant rendered back in the meeting's own zone
    const shown = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: body.start.timeZone, dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(iso));
    expect(body.start.timeZone).toBe('Asia/Manila');
    expect(shown(body.start.dateTime)).toBe('10/11/2026, 09:00');
    expect(shown(body.end.dateTime)).toBe('10/11/2026, 10:00');
  });

  test('midnight boundaries are exact: 00:00 belongs to the new day, 23:59 to the old one (no 8-hour drift)', () => {
    expect(buildGoogleEventBody({ title: 't', start: '2026-11-10T00:00', end: '2026-11-10T00:30' }, []).start.dateTime).toBe('2026-11-09T16:00:00.000Z');
    const late = buildGoogleEventBody({ title: 't', start: '2026-11-10T23:30', end: '2026-11-10T23:59' }, []);
    expect(late.start.dateTime).toBe('2026-11-10T15:30:00.000Z');
    expect(late.end.dateTime).toBe('2026-11-10T15:59:00.000Z');
  });

  test('a meeting that would cross midnight cannot be entered (one date field): the same-date end reads as BEFORE the start and the server refuses it', () => {
    // POST/PATCH answer 400 "The end time cannot be before the start time." (asserted in calendar-invitations.test.js)
    const start = mt.parseEventInstant('2026-11-10T23:00', 'Asia/Manila');
    const end = mt.parseEventInstant('2026-11-10T01:00', 'Asia/Manila');
    expect(end < start).toBe(true);
  });

  test('a missing or non-later end gets a one-hour span instead of an empty range Google would reject', () => {
    for (const end of [undefined, null, '2026-11-10T09:00', '2026-11-10T08:00']) {
      const body = buildGoogleEventBody({ title: 't', start: '2026-11-10T09:00', end, allDay: false }, ['a@example.com']);
      expect(body.end.dateTime).toBe('2026-11-10T02:00:00.000Z');
    }
  });

  test('an all-day event ends on the EXCLUSIVE next date; a multi-day end is kept', () => {
    expect(buildGoogleEventBody({ title: 't', start: '2026-11-10', allDay: true }, []).end).toEqual({ date: '2026-11-11' });
    expect(buildGoogleEventBody({ title: 't', start: '2026-11-10', end: '2026-11-13', allDay: true }, []).end).toEqual({ date: '2026-11-13' });
    expect(buildGoogleEventBody({ title: 't', start: '2026-11-09T16:00:00.000Z', allDay: true }, []).start).toEqual({ date: '2026-11-10' });
  });

  test('attendees are validated, lower-cased and de-duplicated inside the body builder too', () => {
    const body = buildGoogleEventBody({ title: 't', start: '2026-11-10T09:00' }, ['A@x.com', 'a@x.com', 'not-an-email', 'kcariño@cspc.edu.ph', 'b@x.com']);
    expect(body.attendees).toEqual([{ email: 'a@x.com' }, { email: 'b@x.com' }]);
  });

  test('a stable Google event id is only included for an insert', () => {
    const ev = { title: 't', start: '2026-11-10T09:00', googleEventKey: 'ciprmsabc123' };
    expect(buildGoogleEventBody(ev, ['a@x.com'], { insert: true }).id).toBe('ciprmsabc123');
    expect(buildGoogleEventBody(ev, ['a@x.com']).id).toBeUndefined();
  });

  test('invitations are requested from Google (sendUpdates "all"), never silently "none"', () => {
    expect(SEND_UPDATES).toBe('all');
  });
});
