// Calendar (Administrator / CIRL Staff): the date of a NEW event cannot be a past date — picker `min`, inline
// validation for a date typed by hand, no create from a past calendar cell. Source-content checks of the client code
// (same technique as calendar-past-event-guard.test.js); the server-side rule (isNewEventInThePast) is covered there,
// and the behavior in a real browser was verified live for both roles.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'calendar.ejs'), 'utf8');
const block = (start, len) => src.slice(src.indexOf(start), src.indexOf(start) + len);

describe('Calendar — date of a new event is limited to today or later', () => {
  test('the date field has an inline message for a rejected date', () => {
    expect(src).toContain('id="f-date-error"');
    expect(src).toContain('Past dates cannot be selected. Please choose today or a future date.');
  });

  test('adding sets the picker minimum to today; editing removes it again (historical events stay editable)', () => {
    expect(src).toContain('function setDateMin(limitToToday)');
    expect(src).toMatch(/if\(limitToToday\) el\.min = todayDateStr\(\); else el\.removeAttribute\('min'\)/);
    expect(block('function showAdd(', 1600)).toContain('setDateMin(true)');
    expect(block('function showEdit(', 900)).toContain('setDateMin(false)');
  });

  test('a past date typed in is flagged as it is entered, only while adding', () => {
    expect(src).toMatch(/var bad = isAdding && !!el\.value && el\.value < todayDateStr\(\)/);
    expect(src).toMatch(/\['input', 'change'\]\.forEach\(function\(t\)\{ document\.getElementById\('f-date'\)\.addEventListener\(t, validateNewEventDate\)/);
  });

  test('a past date for a NEW event is refused by the shared detail check (used by Next and Save) before anything is sent, and does not touch editing', () => {
    const details = block('function readEventDetails()', 2200);
    expect(details).toContain('if(isAdding && !validateNewEventDate())');
    expect(details).not.toMatch(/if\(!isAdding[^\n]*validateNewEventDate/);
    const save = block("document.getElementById('btn-save').addEventListener('click'", 6000);
    expect(save.indexOf('readEventDetails()')).toBeGreaterThan(-1);
    expect(save.indexOf('readEventDetails()')).toBeLessThan(save.indexOf('apiPost('));
  });

  test('calendar cells before today are not selectable for creation, but navigation and existing events are untouched', () => {
    expect(src).toMatch(/selectAllow: function\(span\)\{ return str_date_input\(span\.start\) >= todayDateStr\(\); \}/);
    expect(src).toContain("showToast('Past dates are not available for new events.'");
    expect(src).toContain('eventClick:  function(info){ showView(info.event); }');
    expect(src).toContain("headerToolbar: { left:'prev,next today'");
  });

  test('dragging an event-type tile onto a past day is refused client-side too', () => {
    expect(block('drop: function(info){', 400)).toContain("info.dateStr.slice(0,10) < todayDateStr()");
  });

  test('moving/resizing existing events and the server-side guard are not changed by this fix', () => {
    expect(src).toContain('eventDrop: function(info){');
    expect(src).toContain('eventResize: function(info){');
    expect(fs.readFileSync(path.join(__dirname, '..', 'cirl.js'), 'utf8')).toContain('function isNewEventInThePast(fields)');
  });
});
