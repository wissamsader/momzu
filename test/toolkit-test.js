// Offline tests for the shared toolkit: ICS calendar parsing/expansion and
// routine day parsing. No network, no state writes.
import { parseIcs, occursOn, formatAgenda, parseRoutineDays } from '../orchestrator/tools.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`✓ ${name}`);
  else { failures++; console.error(`✗ ${name} ${detail}`); }
};

// ── ICS parsing ─────────────────────────────────────────────────────────
const today = new Date();
today.setHours(0, 0, 0, 0);
const day = (offset, h = 0, mi = 0) => {
  const x = new Date(today.getTime() + offset * 86_400_000);
  x.setHours(h, mi, 0, 0);
  return x;
};
const icsStamp = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}` +
  `T${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}00`;

const WEEKDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][today.getDay()];
const ics = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT', `DTSTART:${icsStamp(day(0, 14, 30))}`, `DTEND:${icsStamp(day(0, 15, 30))}`,
  'SUMMARY:Call\\, with escape', 'LOCATION:Zoom', 'END:VEVENT',
  'BEGIN:VEVENT', `DTSTART;VALUE=DATE:${icsStamp(day(1)).slice(0, 8)}`, 'SUMMARY:All day thing', 'END:VEVENT',
  'BEGIN:VEVENT', `DTSTART:${icsStamp(day(-7, 9, 0))}`, `RRULE:FREQ=WEEKLY;BYDAY=${WEEKDAY}`,
  'SUMMARY:Weekly standup', 'END:VEVENT',
  'BEGIN:VEVENT', `DTSTART:${icsStamp(day(0, 20, 0))}`, 'STATUS:CANCELLED', 'SUMMARY:Cancelled', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20200101T090000Z', 'RRULE:FREQ=DAILY;UNTIL=20200201T000000Z',
  'SUMMARY:Expired daily', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

const events = parseIcs(ics);
check('parses events, drops cancelled', events.length === 4, `got ${events.length}`);
check('unescapes summary commas', events[0].summary === 'Call, with escape', events[0].summary);
check('all-day flag', events[1].allDay === true);

const agenda = formatAgenda(events, 2);
check('agenda has today line with time + recurring', /Today: .*09:00 Weekly standup/.test(agenda) && /14:30–15:30/.test(agenda), agenda);
check('agenda has tomorrow all-day', /Tomorrow: all day: All day thing/.test(agenda), agenda);
check('expired UNTIL rule excluded', !/Expired/.test(agenda), agenda);

const weekly = events.find((e) => e.summary === 'Weekly standup');
check('weekly occurs today', occursOn(weekly, day(0)) === true);
check('weekly skips tomorrow', occursOn(weekly, day(1)) === false);

// ── routine days ────────────────────────────────────────────────────────
check('daily', parseRoutineDays('daily').length === 7);
check('weekdays', JSON.stringify(parseRoutineDays('weekdays')) === '[1,2,3,4,5]');
check('weekends', JSON.stringify(parseRoutineDays('weekends')) === '[0,6]');
check('named days', JSON.stringify(parseRoutineDays('mon,thu')) === '[1,4]');
check('junk falls back to daily', parseRoutineDays('whenever').length === 7);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL TOOLKIT TESTS PASSED');
process.exit(failures ? 1 : 0);
