// Control of the user's REAL Chrome (real profile, real logins) via Apple
// Events. Chrome 136+ blocks CDP (--remote-debugging-port) on the default
// profile, so DevTools control of the signed-in browser is no longer
// possible — AppleScript is the supported path and drives the actual
// browser the user sees.
//
// Page-content verbs (readpage/find/click/type/js) need Chrome's one-time
// toggle: View → Developer → Allow JavaScript from Apple Events.

import { spawn } from 'node:child_process';

function osascript(script, timeout = 20000) {
  return new Promise((resolve) => {
    const child = spawn('osascript', ['-e', script]);
    let out = '', err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, output: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: (code === 0 ? out : out + '\n' + err).trim().slice(0, 4000) });
    });
  });
}

const JS_TOGGLE_HINT = 'To let me read and click pages, enable it once in Chrome: '
  + 'View menu → Developer → Allow JavaScript from Apple Events. Then ask again.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait until the active tab finishes loading instead of a blind fixed pause.
// Falls back to a short pause when JS-from-Apple-Events isn't enabled.
async function waitForLoad(maxMs = 6000) {
  await sleep(400); // let navigation actually start before polling
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const r = await runJS('document.readyState');
    if (!r.ok) { await sleep(1200); return; }
    if (r.output === 'complete' || r.output === 'interactive') return;
    await sleep(300);
  }
}

// Run JS in the active tab of the real Chrome; returns its string result.
async function runJS(js) {
  const script = `tell application "Google Chrome"
if (count of windows) = 0 then make new window
execute active tab of front window javascript ${JSON.stringify(js)}
end tell`;
  const res = await osascript(script);
  if (!res.ok && /Executing JavaScript through AppleScript|not allowed|1728|access/i.test(res.output)) {
    return { ok: false, output: JS_TOGGLE_HINT };
  }
  return res;
}

// ── public API — same command strings as before ─────────────────────────

export async function browser(input) {
  const str = String(input || '').trim();
  const sp = str.indexOf(' ');
  let verb = (sp === -1 ? str : str.slice(0, sp)).toLowerCase();
  let arg = sp === -1 ? '' : str.slice(sp + 1).trim();

  const KNOWN = ['browse', 'newtab', 'back', 'forward', 'reload', 'closetab',
    'current', 'tabs', 'readpage', 'find', 'click', 'type', 'js', 'screenshot'];
  if (!KNOWN.includes(verb)) {
    if (/^https?:\/\//i.test(str) || /^[\w-]+\.[a-z]{2,}/i.test(str)) {
      arg = str;
      verb = 'browse';
    }
  }
  const fixUrl = (u) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

  try {
    switch (verb) {
      case 'browse': {
        const res = await osascript(`tell application "Google Chrome"
activate
if (count of windows) = 0 then make new window
set URL of active tab of front window to ${JSON.stringify(fixUrl(arg))}
end tell`);
        if (res.ok) { await waitForLoad(); return { ok: true, output: `Navigated to ${arg}` }; }
        return res;
      }

      case 'newtab': {
        const url = arg ? fixUrl(arg) : 'chrome://newtab';
        const res = await osascript(`tell application "Google Chrome"
activate
if (count of windows) = 0 then make new window
tell front window to make new tab with properties {URL:${JSON.stringify(url)}}
end tell`);
        if (res.ok) { await waitForLoad(); return { ok: true, output: `Opened new tab: ${arg || 'blank'}` }; }
        return res;
      }

      case 'back': return runJS('history.back(); "went back"');
      case 'forward': return runJS('history.forward(); "went forward"');

      case 'reload': {
        const res = await osascript('tell application "Google Chrome" to reload active tab of front window');
        return res.ok ? { ok: true, output: 'Reloaded' } : res;
      }

      case 'closetab': {
        const res = await osascript('tell application "Google Chrome" to close active tab of front window');
        return res.ok ? { ok: true, output: 'Closed tab' } : res;
      }

      case 'current': {
        const res = await osascript(`tell application "Google Chrome"
if (count of windows) = 0 then return "(no Chrome windows open)"
get (title of active tab of front window) & " — " & (URL of active tab of front window)
end tell`);
        return res;
      }

      case 'tabs': {
        const res = await osascript(`tell application "Google Chrome"
if (count of windows) = 0 then return "No Chrome windows open"
set out to ""
set i to 1
repeat with t in tabs of front window
set out to out & i & ". " & (title of t) & linefeed
set i to i + 1
end repeat
return out
end tell`);
        return res.ok ? { ok: true, output: res.output || 'No tabs open' } : res;
      }

      case 'readpage':
        return runJS('document.body && document.body.innerText ? document.body.innerText.replace(/\\s+/g," ").slice(0,3000) : "(empty page)"');

      case 'find': {
        const q = JSON.stringify(arg.toLowerCase());
        return runJS(`(function(){var q=${q};var els=[].slice.call(document.querySelectorAll("a,button,[role=button],input,summary,[onclick]"));var m=els.filter(function(e){return(e.innerText||e.value||e.getAttribute("aria-label")||"").toLowerCase().indexOf(q)>=0});return m.slice(0,8).map(function(e,i){return(i+1)+". "+(e.innerText||e.value||e.getAttribute("aria-label")||"").trim().slice(0,50);}).join(" | ")||"nothing matching found";})()`);
      }

      case 'click': {
        const q = JSON.stringify(arg.toLowerCase());
        const res = await runJS(`(function(){var q=${q};var els=[].slice.call(document.querySelectorAll("a,button,[role=button],input[type=submit],summary,[onclick]"));var el=els.find(function(e){return(e.innerText||e.value||e.getAttribute("aria-label")||"").toLowerCase().indexOf(q)>=0});if(!el)return"NOTFOUND";el.scrollIntoView({block:"center"});el.click();return"clicked: "+((el.innerText||el.value||"").trim().slice(0,40));})()`);
        if (res.ok && res.output === 'NOTFOUND') return { ok: false, output: `No clickable element matching "${arg}" found` };
        return res;
      }

      case 'type': {
        const val = JSON.stringify(arg);
        const res = await runJS(`(function(){var el=document.activeElement;if(!el||!("value"in el)){el=document.querySelector("input:not([type=hidden]),textarea,[contenteditable=true]");}if(!el)return"NOFIELD";el.focus();if("value"in el){el.value=${val};}else{el.innerText=${val};}el.dispatchEvent(new Event("input",{bubbles:true}));return"typed into "+(el.name||el.type||"field");})()`);
        if (res.ok && res.output === 'NOFIELD') return { ok: false, output: 'No text field found on page' };
        return res;
      }

      case 'js':
        return runJS(arg);

      case 'screenshot': {
        const res = await osascript('tell application "Google Chrome" to activate');
        if (!res.ok) return res;
        return { ok: false, output: 'Screenshots not supported on the real browser — use readpage instead.' };
      }

      default:
        return { ok: false, output: `Unknown browser verb: ${verb}` };
    }
  } catch (err) {
    return { ok: false, output: `Browser error: ${err.message.slice(0, 300)}` };
  }
}
