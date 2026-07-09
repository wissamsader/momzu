// Shared toolkit — one definition per capability, consumed by BOTH the
// Claude agent (as SDK MCP tools) and the API providers with native
// function calling (DeepSeek/Gemini). Every run() resolves to
// { ok, output } with a short, speakable output string.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { browser } from './browser.js';
import { runAction } from './computer.js';

export const stateDir = () => process.env.MOMZU_STATE_DIR || path.join(process.cwd(), 'config', 'state');

export function loadList(name) {
  try { return JSON.parse(readFileSync(path.join(stateDir(), `${name}.json`), 'utf8')); }
  catch { return []; }
}
export function saveList(name, items) {
  writeFileSync(path.join(stateDir(), `${name}.json`), JSON.stringify(items, null, 2));
}

function loadConnectors() {
  try { return JSON.parse(readFileSync(path.join(stateDir(), 'connectors.json'), 'utf8')); }
  catch { return {}; }
}
function saveConnectors(c) {
  writeFileSync(path.join(stateDir(), 'connectors.json'), JSON.stringify(c, null, 2));
}

function exec(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: (out + (err ? `\n${err}` : '')).trim().slice(0, 4000) || `(exit ${code})` });
    });
  });
}

const osascript = (script) => exec('osascript', ['-e', script]);

// ── reminders / objectives ──────────────────────────────────────────────

// Parse "in 20 minutes"-style input the model has already normalized:
// either in_minutes, or at ("HH:MM" today — tomorrow if already past).
function computeDue({ in_minutes, at }) {
  if (typeof in_minutes === 'number' && in_minutes > 0) return Date.now() + in_minutes * 60_000;
  if (at) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(at.trim());
    if (m) {
      const d = new Date();
      d.setHours(Number(m[1]), Number(m[2]), 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      return d.getTime();
    }
    const parsed = Date.parse(at);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

const fmtDue = (due) => due ? ` (due ${new Date(due).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })})` : '';

// ── Google Calendar via secret ICS address ──────────────────────────────
// No OAuth: Google Calendar exposes a private read-only ICS URL per
// calendar (Settings → your calendar → "Integrate calendar" → "Secret
// address in iCal format"). The user pastes it once in chat.

const unfoldIcs = (text) => text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');

function parseIcsDate(value, params = '') {
  if (/VALUE=DATE(?!-)/.test(params) || /^\d{8}$/.test(value)) {
    return { date: new Date(+value.slice(0, 4), +value.slice(4, 6) - 1, +value.slice(6, 8)), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/.exec(value);
  if (!m) {
    const p = new Date(value);
    return Number.isNaN(p.getTime()) ? null : { date: p, allDay: false };
  }
  if (m[7] === 'Z') return { date: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])), allDay: false };
  // TZID/floating times are treated as local — personal calendars share the
  // Mac's timezone in practice.
  return { date: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), allDay: false };
}

const unescapeIcs = (s) => String(s).replace(/\\n/gi, ' — ').replace(/\\([,;\\])/g, '$1');

export function parseIcs(text) {
  const events = [];
  let cur = null;
  for (const line of unfoldIcs(text).split('\n')) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur?.start && cur.summary && cur.status !== 'CANCELLED') events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const [prop, ...params] = line.slice(0, colon).split(';');
    const value = line.slice(colon + 1);
    if (prop === 'DTSTART') {
      const r = parseIcsDate(value, params.join(';'));
      if (r) { cur.start = r.date; cur.allDay = r.allDay; }
    } else if (prop === 'DTEND') {
      const r = parseIcsDate(value, params.join(';'));
      if (r) cur.end = r.date;
    } else if (prop === 'SUMMARY') cur.summary = unescapeIcs(value);
    else if (prop === 'LOCATION') cur.location = unescapeIcs(value);
    else if (prop === 'RRULE') cur.rrule = value;
    else if (prop === 'STATUS') cur.status = value;
  }
  return events;
}

const BYDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

// Does this event occur on the given (local-midnight) day? Recurrence is
// approximate: DAILY/WEEKLY with INTERVAL/BYDAY/UNTIL, MONTHLY/YEARLY by
// same date — which covers real personal calendars.
export function occursOn(ev, day) {
  const evDay = startOfDay(ev.start);
  if (!ev.rrule) return evDay.getTime() === day.getTime();
  if (day < evDay) return false;
  const r = {};
  for (const part of ev.rrule.split(';')) { const [k, v] = part.split('='); r[k] = v; }
  if (r.UNTIL) {
    const u = parseIcsDate(r.UNTIL, '');
    if (u && day > u.date) return false;
  }
  const interval = +(r.INTERVAL || 1);
  const daysSince = Math.round((day - evDay) / 86_400_000);
  switch (r.FREQ) {
    case 'DAILY': return daysSince % interval === 0;
    case 'WEEKLY': {
      const by = r.BYDAY ? r.BYDAY.split(',').map((d) => BYDAY[d.slice(-2)]) : [ev.start.getDay()];
      if (!by.includes(day.getDay())) return false;
      return Math.floor(daysSince / 7) % interval === 0;
    }
    case 'MONTHLY': return day.getDate() === ev.start.getDate();
    case 'YEARLY': return day.getDate() === ev.start.getDate() && day.getMonth() === ev.start.getMonth();
    default: return false;
  }
}

const hhmm = (d) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export function formatAgenda(events, days) {
  const out = [];
  const today = startOfDay(new Date());
  for (let i = 0; i < days; i++) {
    const day = new Date(today.getTime() + i * 86_400_000);
    const todays = events
      .filter((ev) => occursOn(ev, day))
      .sort((a, b) => (a.allDay ? -1 : b.allDay ? 1 : a.start.getHours() * 60 + a.start.getMinutes() - b.start.getHours() * 60 - b.start.getMinutes()));
    if (!todays.length) continue;
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow'
      : day.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    const items = todays.map((ev) => {
      const loc = ev.location ? ` (${ev.location.slice(0, 40)})` : '';
      if (ev.allDay) return `all day: ${ev.summary}${loc}`;
      const end = ev.end && !ev.rrule ? `–${hhmm(ev.end)}` : '';
      return `${hhmm(ev.start)}${end} ${ev.summary}${loc}`;
    });
    out.push(`${label}: ${items.join('; ')}`);
  }
  return out.join('\n');
}

const CAL_HELP = 'No calendar is connected yet. To connect Google Calendar: open calendar.google.com settings, click the calendar in the left list, scroll to "Integrate calendar", copy the "Secret address in iCal format", and paste that link here in chat asking to connect it.';

async function fetchCalendars(urls) {
  const all = [];
  for (const url of urls) {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
    if (!res.ok) throw new Error(`calendar fetch failed: ${res.status}`);
    all.push(...parseIcs(await res.text()));
  }
  return all;
}

// ── weather (wttr.in, no key) ───────────────────────────────────────────

async function fetchWeather(place) {
  const res = await fetch(`https://wttr.in/${encodeURIComponent(place || '')}?format=j1`, {
    signal: AbortSignal.timeout(10_000),
    headers: { 'user-agent': 'curl/8' },
  });
  if (!res.ok) throw new Error(`weather service: ${res.status}`);
  const j = await res.json();
  const cur = j.current_condition?.[0];
  const area = j.nearest_area?.[0]?.areaName?.[0]?.value;
  const day = (d) => d ? `${d.mintempC} to ${d.maxtempC} degrees, ${d.hourly?.[4]?.weatherDesc?.[0]?.value?.toLowerCase() || ''}`.trim() : '';
  if (!cur) throw new Error('no weather data');
  let out = `${area ? `In ${area}: ` : ''}${cur.temp_C} degrees, ${cur.weatherDesc?.[0]?.value?.toLowerCase()}, feels like ${cur.FeelsLikeC}.`;
  if (j.weather?.[0]) out += ` Today ${day(j.weather[0])}.`;
  if (j.weather?.[1]) out += ` Tomorrow ${day(j.weather[1])}.`;
  return out;
}

// ── music (Spotify first, Apple Music fallback) ─────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function musicApp() {
  const r = await osascript('application "Spotify" is running');
  if (r.ok && r.output === 'true') return 'Spotify';
  const m = await osascript('application "Music" is running');
  if (m.ok && m.output === 'true') return 'Music';
  return 'Spotify'; // default target — will launch it
}

// Play a specific song by name. Spotify's AppleScript can't search, and its
// public search endpoints are all auth-gated — so the search page renders in
// the user's real Chrome, the first track id is pulled from the DOM, the tab
// closes, and the DESKTOP app plays the URI. Verified end-to-end.
async function spotifyPlaySong(query) {
  const url = `https://open.spotify.com/search/${encodeURIComponent(query)}/tracks`;
  const tab = await browser(`newtab ${url}`);
  if (!tab.ok) return { ok: false, output: `Chrome unavailable for the Spotify search: ${tab.output.slice(0, 120)}` };
  let id = null;
  for (let i = 0; i < 16 && !id; i++) {
    await sleep(500);
    const r = await browser(`js (document.querySelector('a[href*="/track/"]')||{}).href || ''`);
    const m = /\/track\/([A-Za-z0-9]{22})/.exec(String(r.output || ''));
    if (m) id = m[1];
  }
  await osascript('tell application "Google Chrome" to close (tabs of windows whose URL contains "open.spotify.com/search")');
  if (!id) return { ok: false, output: `Couldn't find "${query}" on Spotify.` };
  const play = await osascript(`tell application "Spotify" to play track "spotify:track:${id}"`);
  if (!play.ok) return { ok: false, output: `Spotify refused to play it: ${play.output.slice(0, 120)}` };
  await sleep(1200);
  const now = await osascript('tell application "Spotify" to (get name of current track) & " by " & (get artist of current track)');
  return { ok: true, output: now.ok ? `Playing ${now.output} on Spotify` : 'Playing it on Spotify' };
}

async function runMusic({ action, value, query }) {
  if (action === 'volume') {
    if (typeof value !== 'number') return { ok: false, output: 'volume needs value 0-100' };
    const r = await osascript(`set volume output volume ${Math.max(0, Math.min(100, Math.round(value)))}`);
    return r.ok ? { ok: true, output: `Volume ${Math.round(value)}%` } : r;
  }
  if (action === 'play_song') {
    if (!query?.trim()) return { ok: false, output: 'play_song needs a query (song and artist)' };
    return spotifyPlaySong(query.trim());
  }
  const app = await musicApp();
  const scripts = {
    play: `tell application "${app}" to play`,
    pause: `tell application "${app}" to pause`,
    toggle: `tell application "${app}" to playpause`,
    next: `tell application "${app}" to next track`,
    previous: `tell application "${app}" to previous track`,
    current: `tell application "${app}" to (get name of current track) & " by " & (get artist of current track)`,
  };
  const script = scripts[action];
  if (!script) return { ok: false, output: `unknown music action "${action}"` };
  const r = await osascript(script);
  if (!r.ok) return { ok: false, output: `${app}: ${r.output.slice(0, 120)}` };
  if (action === 'current') return { ok: true, output: `Playing ${r.output} on ${app}` };
  return { ok: true, output: `${app}: ${action}${action.endsWith('e') ? 'd' : 'ed'}` };
}

// ── routines (scheduled prompts — the scheduler lives in server.js) ─────

export function parseRoutineDays(days) {
  const d = String(days || 'daily').toLowerCase().trim();
  if (d === 'daily' || d === 'every day' || d === 'everyday') return [0, 1, 2, 3, 4, 5, 6];
  if (d === 'weekdays') return [1, 2, 3, 4, 5];
  if (d === 'weekends' || d === 'weekend') return [0, 6];
  const names = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const picked = d.split(/[,\s]+/).map((w) => names[w.slice(0, 3)]).filter((n) => n !== undefined);
  return picked.length ? [...new Set(picked)].sort() : [0, 1, 2, 3, 4, 5, 6];
}

const describeRoutine = (r) => `"${r.id}" at ${r.time} (${r.days}) — ${r.enabled === false ? 'OFF — ' : ''}${r.prompt.slice(0, 80)}`;

// ── the toolkit ─────────────────────────────────────────────────────────

export const toolDefs = [
  {
    name: 'open_app',
    description: 'Open a macOS application by name (e.g. Spotify, Notes).',
    schema: z.object({ app: z.string().describe('application name') }),
    run: async ({ app }) => {
      const r = await exec('open', ['-a', app]);
      return r.ok ? { ok: true, output: `Opened ${app}` } : r;
    },
  },
  {
    name: 'applescript',
    description: 'Run AppleScript to control any Mac app (menus, playback, volume, System Events keystrokes).',
    schema: z.object({ script: z.string().describe('AppleScript source') }),
    run: ({ script }) => osascript(script),
  },
  {
    name: 'chrome',
    description: [
      'Control the user\'s real Google Chrome (their logged-in profile). Command formats:',
      '"browse <url>", "newtab <url>", "readpage" (page text), "find <text>" (list matching clickables),',
      '"click <text>", "type <text>" (into focused field), "js <expression>", "tabs", "current", "back", "reload".',
      'Prefer this over AppleScript for anything inside a web page.',
    ].join('\n'),
    schema: z.object({ command: z.string().describe('one command, e.g. "browse instagram.com"') }),
    run: ({ command }) => browser(command),
  },
  {
    name: 'add_reminder',
    description: 'Add a reminder. Give in_minutes (relative) or at ("HH:MM" 24h, or ISO date-time) — it is spoken aloud and shown as a notification when due. Omit both for a simple checklist entry.',
    schema: z.object({
      text: z.string().describe('what to remind'),
      in_minutes: z.number().optional().describe('fire after this many minutes'),
      at: z.string().optional().describe('"HH:MM" or ISO date-time'),
    }),
    run: async ({ text, in_minutes, at }) => {
      const items = loadList('reminders');
      const due = computeDue({ in_minutes, at });
      items.push({ text, done: false, ...(due ? { due } : {}) });
      saveList('reminders', items);
      return { ok: true, output: `Reminder added: "${text}"${fmtDue(due)}` };
    },
  },
  {
    name: 'add_objective',
    description: 'Add an objective/goal/task to the objectives panel.',
    schema: z.object({ text: z.string() }),
    run: async ({ text }) => {
      const items = loadList('objectives');
      items.push({ text, done: false });
      saveList('objectives', items);
      return { ok: true, output: `Objective added: "${text}"` };
    },
  },
  {
    name: 'complete_item',
    description: 'Mark an objective or reminder as done (or not done). Matches by substring of the item text.',
    schema: z.object({
      list: z.enum(['objectives', 'reminders']),
      match: z.string().describe('substring of the item text'),
      done: z.boolean().optional(),
    }),
    run: async ({ list, match, done = true }) => {
      const items = loadList(list);
      const item = items.find((i) => i.text.toLowerCase().includes(match.toLowerCase()));
      if (!item) return { ok: false, output: `No ${list.slice(0, -1)} matching "${match}". Current: ${items.map((i) => i.text).join('; ') || '(empty)'}` };
      item.done = done;
      saveList(list, items);
      return { ok: true, output: `${done ? 'Completed' : 'Reopened'}: "${item.text}"` };
    },
  },
  {
    name: 'list_items',
    description: 'Read the current objectives and reminders lists.',
    schema: z.object({}),
    run: async () => {
      const fmt = (name) => loadList(name)
        .map((i, n) => `${n + 1}. [${i.done ? 'x' : ' '}] ${i.text}${fmtDue(i.due)}`)
        .join('\n') || '(empty)';
      return { ok: true, output: `OBJECTIVES:\n${fmt('objectives')}\n\nREMINDERS:\n${fmt('reminders')}` };
    },
  },
  {
    name: 'see_screen',
    description: 'Capture a screenshot of the whole screen. Returns a PNG file path — use the Read tool on that path to actually see the screen, then describe or act on it.',
    schema: z.object({}),
    run: async () => {
      const file = path.join(os.tmpdir(), `jarvis-screen-${Date.now()}.png`);
      const r = await exec('screencapture', ['-x', file]);
      if (!r.ok) return { ok: false, output: `Screenshot failed: ${r.output}. macOS Screen Recording permission may be needed (System Settings → Privacy & Security → Screen Recording).` };
      return { ok: true, output: `Screenshot saved to ${file} — use the Read tool on this path to view it.` };
    },
  },
  {
    name: 'calendar_events',
    description: 'Read the user\'s Google Calendar agenda for the next days (connected via secret ICS address). Use for "what\'s on my calendar", "am I free…", the morning briefing.',
    schema: z.object({ days: z.number().min(1).max(14).optional().describe('how many days ahead (default 2)') }),
    run: async ({ days = 2 } = {}) => {
      const urls = loadConnectors().gcalIcs || [];
      if (!urls.length) return { ok: true, output: CAL_HELP };
      try {
        const events = await fetchCalendars(urls);
        const agenda = formatAgenda(events, Math.round(days));
        return { ok: true, output: agenda || `Nothing on the calendar for the next ${Math.round(days)} day(s).` };
      } catch (err) {
        return { ok: false, output: `Calendar unreachable: ${String(err.message).slice(0, 120)}` };
      }
    },
  },
  {
    name: 'calendar_connect',
    description: 'Save a Google Calendar secret ICS address (the user pastes the link in chat). Verifies the link before saving.',
    schema: z.object({ ics_url: z.string().describe('https://calendar.google.com/calendar/ical/…/basic.ics') }),
    run: async ({ ics_url }) => {
      const url = ics_url.trim();
      if (!/^https:\/\//.test(url)) return { ok: false, output: 'That does not look like an https ICS link.' };
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'follow' });
        const text = await res.text();
        if (!res.ok || !text.includes('BEGIN:VCALENDAR')) return { ok: false, output: 'The link did not return a calendar. Copy the "Secret address in iCal format" from Google Calendar settings.' };
        const c = loadConnectors();
        c.gcalIcs = [...new Set([...(c.gcalIcs || []), url])];
        saveConnectors(c);
        const count = parseIcs(text).length;
        return { ok: true, output: `Calendar connected (${count} events found). Ask me "what's on my calendar" any time.` };
      } catch (err) {
        return { ok: false, output: `Could not reach that link: ${String(err.message).slice(0, 100)}` };
      }
    },
  },
  {
    name: 'music',
    description: 'Control music — Spotify when it runs, else Apple Music. Actions: play_song (play a SPECIFIC song/artist by name on Spotify — give query, takes a few seconds), play, pause, toggle, next, previous, current (what\'s playing), volume (value 0-100).',
    schema: z.object({
      action: z.enum(['play_song', 'play', 'pause', 'toggle', 'next', 'previous', 'current', 'volume']),
      query: z.string().optional().describe('song + artist, only for action "play_song"'),
      value: z.number().optional().describe('volume percent, only for action "volume"'),
    }),
    run: runMusic,
  },
  {
    name: 'weather',
    description: 'Current weather + today/tomorrow outlook. Give a place name, or omit for the user\'s current location.',
    schema: z.object({ place: z.string().optional().describe('city, e.g. "Paris" — omit for auto') }),
    run: async ({ place } = {}) => {
      try { return { ok: true, output: await fetchWeather(place) }; }
      catch (err) { return { ok: false, output: `Weather unavailable: ${String(err.message).slice(0, 100)}` }; }
    },
  },
  {
    name: 'add_routine',
    description: 'Schedule a recurring spoken task — at the given time Momzu runs the prompt and speaks the result (e.g. a morning briefing). days: "daily", "weekdays", "weekends", or names like "mon,thu".',
    schema: z.object({
      id: z.string().describe('short name, e.g. "morning-briefing"'),
      time: z.string().describe('"HH:MM" 24h local'),
      prompt: z.string().describe('what Momzu should do at that time, phrased as a request'),
      days: z.string().optional().describe('default "daily"'),
    }),
    run: async ({ id, time, prompt, days = 'daily' }) => {
      if (!/^\d{1,2}:\d{2}$/.test(time.trim())) return { ok: false, output: 'time must be "HH:MM" (24h)' };
      const routines = loadList('routines');
      const slug = id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `routine-${routines.length + 1}`;
      const existing = routines.findIndex((r) => r.id === slug);
      const routine = { id: slug, time: time.trim(), days, prompt, enabled: true, lastRun: '' };
      if (existing >= 0) routines[existing] = routine; else routines.push(routine);
      saveList('routines', routines);
      return { ok: true, output: `Routine saved: ${describeRoutine(routine)}` };
    },
  },
  {
    name: 'list_routines',
    description: 'List the scheduled routines.',
    schema: z.object({}),
    run: async () => {
      const routines = loadList('routines');
      if (!routines.length) return { ok: true, output: 'No routines scheduled.' };
      return { ok: true, output: routines.map(describeRoutine).join('\n') };
    },
  },
  {
    name: 'remove_routine',
    description: 'Delete (or disable) a routine by id or prompt substring. Set disable_only to keep it but stop it running.',
    schema: z.object({
      match: z.string(),
      disable_only: z.boolean().optional(),
    }),
    run: async ({ match, disable_only = false }) => {
      const routines = loadList('routines');
      const idx = routines.findIndex((r) =>
        r.id.includes(match.toLowerCase()) || r.prompt.toLowerCase().includes(match.toLowerCase()));
      if (idx === -1) return { ok: false, output: `No routine matching "${match}". Current: ${routines.map((r) => r.id).join(', ') || '(none)'}` };
      const r = routines[idx];
      if (disable_only) { r.enabled = false; } else { routines.splice(idx, 1); }
      saveList('routines', routines);
      return { ok: true, output: `${disable_only ? 'Disabled' : 'Removed'} routine "${r.id}"` };
    },
  },
];

// Tools for API providers with native function calling (DeepSeek/Gemini).
// see_screen is excluded (they cannot read the image back); shell/file/url
// wrappers reuse the guarded runAction path.
export const apiToolDefs = [
  ...toolDefs.filter((t) => t.name !== 'see_screen'),
  {
    name: 'shell',
    description: 'Run a zsh command on the user\'s Mac and get its output. Use for file operations, launching scripts, system queries.',
    schema: z.object({ command: z.string().describe('the zsh command') }),
    run: ({ command }) => runAction({ tool: 'shell', input: command }, null),
  },
  {
    name: 'open_url',
    description: 'Open a URL in the default browser.',
    schema: z.object({ url: z.string() }),
    run: ({ url }) => runAction({ tool: 'url', input: url }, null),
  },
  {
    name: 'write_file',
    description: 'Write a complete file (creates parent folders). Use for building websites, scripts, notes — never show the content in chat.',
    schema: z.object({
      path: z.string().describe('e.g. "~/Desktop/site/index.html"'),
      content: z.string().describe('the FULL file content'),
    }),
    run: ({ path: p, content }) => runAction({ tool: 'write', path: p, content }, null),
  },
];
