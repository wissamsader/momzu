const { app, BrowserWindow, globalShortcut, session, ipcMain, screen, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
let koffi = null;
try { koffi = require('koffi'); } catch { /* optional — only needed for walkie-talkie */ }

// Last-resort net: a transient error (e.g. a bad frame during widget drag)
// must log, not pop Electron's modal "Uncaught Exception" dialog and scare
// the user. Real bugs still show up in the terminal / Console.app.
process.on('uncaughtException', (err) => {
  console.error('[jarvis] uncaught exception (app kept running):', err.stack || err.message);
});

let win;
let miniWindow = null;
let miniSavedPosition = null;  // { x, y } — persisted to disk across app runs
let quitting = false;          // true once the user actually quits (Cmd+Q)
let orchestrator = null;
let orchestratorRespawnDelay = 1000; // grows on crash-loop, resets once stable
let tray = null;

// ── persisted UI state (mini widget position) ──────────────────────────
// Lives in userData, NOT in the app bundle — survives rebuilds and works
// even when the .app is read-only.
const uiStatePath = () => path.join(app.getPath('userData'), 'ui-state.json');

function loadUiState() {
  try {
    const state = JSON.parse(fs.readFileSync(uiStatePath(), 'utf8'));
    if (Number.isFinite(state.miniX) && Number.isFinite(state.miniY)) {
      miniSavedPosition = { x: state.miniX, y: state.miniY };
    }
  } catch { /* first run */ }
}

function saveUiState() {
  try {
    if (miniSavedPosition) {
      // Merge — this file also carries flags like loginItemInitialized.
      let state = {};
      try { state = JSON.parse(fs.readFileSync(uiStatePath(), 'utf8')); } catch { /* fresh */ }
      state.miniX = miniSavedPosition.x;
      state.miniY = miniSavedPosition.y;
      fs.writeFileSync(uiStatePath(), JSON.stringify(state));
    }
  } catch { /* best-effort */ }
}
let controlTap = null;    // CGEvent tap for walkie-talkie Control key
let controlDown = false;  // debounce duplicate keydown events

// Finder-launched apps don't inherit the shell PATH (fnm, nvm, etc.), so
// resolve the node binary to an absolute path that works regardless.
// IMPORTANT: fnm's default node comes FIRST — it's the node that npm uses
// to compile native modules (better-sqlite3), so its ABI always matches.
// Homebrew node can be a different major version (ABI mismatch → memory dies).
function findNode() {
  const candidates = [
    // Bundled runtime first — the app must run on Macs with no dev tools.
    path.join(process.resourcesPath || '', 'bin', 'node', 'node'),
    path.join(require('os').homedir(), '.local/share/fnm/aliases/default/bin/node'),
    '/opt/homebrew/bin/node',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'node'; // fallback — works when launched from terminal
}

function startOrchestrator() {
  // In dev, `npm run dev` already starts the orchestrator via concurrently —
  // probe the port first so we don't spawn a doomed duplicate (EADDRINUSE).
  const probe = net.connect({ port: 8765, host: '127.0.0.1' });
  probe.once('connect', () => {
    probe.destroy();
    console.log('[jarvis] orchestrator already running — reusing it');
  });
  probe.once('error', () => spawnOrchestrator());
}

function spawnOrchestrator() {
  const isPackaged = app.isPackaged;
  // The orchestrator runs under system node: the bundled node_modules are
  // packed as-is (npmRebuild:false), compiled for node's ABI — NOT Electron's.
  // Do not switch this to ELECTRON_RUN_AS_NODE without recompiling
  // better-sqlite3 for Electron's ABI (it will fail with NODE_MODULE_VERSION).
  const nodeBin = findNode();

  // In dev: orchestrator is at ../orchestrator/server.js from __dirname.
  // In packaged app: the orchestrator is unpacked at app.asar.unpacked/
  // while __dirname is inside app.asar. Node spawn can't read asar files.
  const orchestratorPath = isPackaged
    ? path.join(app.getAppPath() + '.unpacked', 'orchestrator', 'server.js')
    : path.join(__dirname, '..', 'orchestrator', 'server.js');

  // CWD = the unpacked root (or project root in dev) so ROOT resolution
  // and relative file reads work.
  const cwd = isPackaged
    ? app.getAppPath() + '.unpacked'
    : path.join(__dirname, '..');

  // extraResources land in Resources/ — tell the orchestrator where bin/ is.
  // Finder-launched apps don't inherit the shell PATH, so add common binary
  // paths — including ~/.local/bin, where the official Claude Code installer
  // (curl claude.ai/install.sh) puts the `claude` binary.
  const extraPath = [
    path.join(require('os').homedir(), '.local', 'bin'),
    // npm-global installs under fnm's default node land here.
    path.join(require('os').homedir(), '.local', 'share', 'fnm', 'aliases', 'default', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].join(':');
  const env = {
    ...process.env,
    PATH: `${extraPath}:${process.env.PATH || ''}`,
    MOMZU_RESOURCES: isPackaged
      ? path.dirname(app.getAppPath())
      : path.join(__dirname, '..'),
  };
  // Packaged app: keep memory/keys/settings in Application Support so app
  // updates never wipe them. Dev keeps using the repo's config/state.
  if (isPackaged) {
    env.MOMZU_STATE = path.join(app.getPath('userData'), 'state');
  }

  orchestrator = spawn(nodeBin, [orchestratorPath], { cwd, stdio: 'pipe', env });

  orchestrator.stdout.on('data', (d) => {
    const line = d.toString().trim();
    if (line) console.log('[orchestrator]', line);
  });
  orchestrator.stderr.on('data', (d) => {
    console.error('[orchestrator]', d.toString().trim());
  });
  orchestrator.on('error', (err) => {
    console.error('[orchestrator] failed to start:', err.message);
  });
  orchestrator.on('close', (code) => {
    console.log('[orchestrator] exited with code', code);
    // Intentional stops (quit, restart) null `orchestrator` in
    // stopOrchestrator() before killing — anything else is a crash, and a
    // crash must not leave the app brain-dead: relaunch with backoff.
    const crashed = orchestrator !== null && typeof code === 'number' && code !== 0;
    orchestrator = null;
    if (crashed && !quitting) {
      const delay = orchestratorRespawnDelay;
      orchestratorRespawnDelay = Math.min(orchestratorRespawnDelay * 2, 30000);
      console.log(`[orchestrator] crashed — respawning in ${delay}ms`);
      setTimeout(() => { if (!orchestrator && !quitting) spawnOrchestrator(); }, delay);
    }
  });

  // Stable for a minute → treat the next crash as fresh (reset backoff).
  const child = orchestrator;
  setTimeout(() => { if (orchestrator === child) orchestratorRespawnDelay = 1000; }, 60000);
}

function stopOrchestrator() {
  if (orchestrator) {
    orchestrator.kill('SIGTERM');
    orchestrator = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#07060b',
    title: 'Momzu',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // The hidden window must keep recording + silence detection running
      // while the app lives in the background widget (rAF is throttled to
      // zero in hidden windows otherwise, so auto-stop would never fire).
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer/index.html'));

  // Surface renderer JS errors in the terminal — a broken dashboard is
  // otherwise invisible when launched from Finder.
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (level >= 3) console.error(`[renderer] ${message} (${path.basename(String(sourceId))}:${line})`);
  });

  // Mini overlay: when the user minimizes the main window, show a small
  // always-on-top face in the top-right so they can still see Jarvis is
  // alive and talk to it while working in other apps.
  win.on('minimize', () => showMiniWindow());
  win.on('restore', () => hideMiniWindow());

  // Tell the renderer when nobody can see it so it pauses CSS animations
  // (backgroundThrottling is off, so Chromium won't throttle on its own).
  const sendVisibility = (visible) => {
    try { win.webContents.send('win-visibility', visible); } catch {}
  };
  win.on('hide', () => sendVisibility(false));
  win.on('minimize', () => sendVisibility(false));
  win.on('show', () => sendVisibility(true));
  win.on('restore', () => sendVisibility(true));

  // Closing the window does NOT quit — the assistant keeps running in the
  // background as the floating widget (walkie-talkie mode). Cmd+Q quits.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    showMiniWindow();
  });

  win.on('closed', () => {
    win = null;
  });
}

// ── mini overlay window (draggable, always-on-top) ─────────────────────

function clampToDisplay(x, y, winW, winH) {
  // Clamp to whichever display the widget is on — not just the primary one,
  // so it can live on a second monitor without snapping back.
  const { workArea } = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  return {
    x: Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - winW)),
    y: Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - winH)),
  };
}

function getMiniWindowPosition() {
  const display = screen.getPrimaryDisplay();
  const { width } = display.workArea;
  const defaultPos = { x: width - 176, y: 38 };

  if (miniSavedPosition) {
    // Clamp saved position so it's never off-screen (e.g. after display change).
    return clampToDisplay(miniSavedPosition.x, miniSavedPosition.y, 160, 180);
  }
  return defaultPos;
}

function createMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) return;
  const pos = getMiniWindowPosition();

  miniWindow = new BrowserWindow({
    width: 160,
    height: 180,
    x: pos.x,
    y: pos.y,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    // No shadow: macOS leaves ghost-trail repaint artifacts when dragging a
    // transparent window that has one.
    hasShadow: false,
    backgroundColor: '#00000000',
    visibleOnAllWorkspaces: true,
    show: false, // wait for ready-to-show so transparent window paints
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  miniWindow.loadFile(path.join(__dirname, 'renderer/mini.html'));
  miniWindow.setAlwaysOnTop(true, 'floating');

  miniWindow.once('ready-to-show', () => {
    miniWindow?.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    miniWindow?.show();
  });
  // Fallback: if ready-to-show hasn't fired after 1s, show anyway.
  setTimeout(() => {
    if (miniWindow && !miniWindow.isDestroyed() && !miniWindow.isVisible()) {
      miniWindow.show();
    }
  }, 1000);

  // Remember where the user dragged the mini so it reopens in the same spot.
  miniWindow.on('moved', () => {
    if (miniWindow && !miniWindow.isDestroyed()) {
      const [x, y] = miniWindow.getPosition();
      miniSavedPosition = { x, y };
    }
  });

  miniWindow.on('closed', () => { miniWindow = null; });
}

function showMiniWindow() {
  createMiniWindow();
  // If the window was already created (re-used), make sure it's visible.
  if (miniWindow && !miniWindow.isDestroyed() && !miniWindow.isVisible()) {
    miniWindow.show();
  }
}

function hideMiniWindow() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.close();
    miniWindow = null;
  }
}

// ── Walkie-talkie: hold a key to talk, release to stop ─────────────────
// Uses a CGEvent tap INSIDE the Electron process, so it inherits the
// app's Accessibility permission (no separate binary needed).
// Listens for Control (0x3B) and Right Option (0x3D).
// Trying HID tap (1) first — more reliable than session tap (0).

const PTT_KEYS = [0x3b, 0x3d]; // Control, Right Option

// Control+Option+Command pressed together (three adjacent keys, no Space
// needed) toggles push-to-talk — same as the Alt+Space global shortcut.
// Modifier keys arrive as flagsChanged events (type 12), not keyDown.
const COMBO_FLAGS = 0x1C0000; // maskControl | maskAlternate | maskCommand
let comboDown = false;        // fire once per press, re-arm on any release

// One shared entry point for all PTT triggers (global shortcut, key combo):
// widget mode keeps the main window hidden; otherwise bring it up.
function triggerPTT() {
  if (miniWindow && !miniWindow.isDestroyed()) {
    if (win) win.webContents.send('ptt-toggle');
    return;
  }
  if (win) {
    win.show();
    win.webContents.send('ptt-toggle');
  }
}

// Poll the system's live modifier state instead of relying on the CGEvent
// tap: CGEventSourceFlagsState needs NO special permission, works even when
// the tap delivers nothing (observed in the Electron main process), and a
// call every 120ms is negligible. Shares comboDown with the tap path so the
// two can never double-fire.
function startComboWatcher() {
  if (!koffi) return;
  try {
    const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const flagsState = CG.func('CGEventSourceFlagsState', 'uint64', ['int32']);
    setInterval(() => {
      try {
        const flags = Number(flagsState(0)); // 0 = combined session state
        const combo = (flags & COMBO_FLAGS) === COMBO_FLAGS;
        if (combo && !comboDown) {
          comboDown = true;
          if (controlDown) { controlDown = false; if (win) win.webContents.send('ptt-stop'); }
          triggerPTT();
        } else if (!combo && comboDown) {
          comboDown = false; // re-arm once any of the three is released
        }
      } catch { /* never let the poller throw */ }
    }, 120);
    console.log('[jarvis] 🎤 Control+Option+Command toggle ACTIVE (polling watcher)');
  } catch (err) {
    console.log('[jarvis] combo watcher unavailable:', err.message.slice(0, 80));
  }
}

function startControlTap() {
  if (!koffi) { console.log('[jarvis] koffi not available'); return false; }
  try {
    const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const CF = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');

    // koffi types are registered globally — creating 'TapCB' twice throws,
    // so cache it for the permission-granted retry path.
    if (!startControlTap._TapCBPtr) {
      const TapCB = koffi.proto('TapCB', 'void *', ['void *', 'uint32', 'void *', 'void *']);
      startControlTap._TapCBPtr = koffi.pointer(TapCB);
    }
    const TapCBPtr = startControlTap._TapCBPtr;

    // Cache the field-getter so we never load frameworks inside the callback.
    const getField = CG.func('CGEventGetIntegerValueField', 'int64', ['void *', 'uint32']);
    const getFlags = CG.func('CGEventGetFlags', 'uint64', ['void *']);
    const addSrc = CF.func('CFRunLoopAddSource', 'void', ['void *', 'void *', 'void *']);
    const getRL = CF.func('CFRunLoopGetCurrent', 'void *', []);
    const enableTap = CG.func('CGEventTapEnable', 'void', ['void *', 'bool']);

    // kCFRunLoopCommonModes is a CFStringRef constant, not a function.
    // Calling it as a function → SIGBUS (execute in __DATA_CONST).
    // Create the equivalent CFString ourselves via CFStringCreateWithCString.
    const cfStrCreate = CF.func('CFStringCreateWithCString', 'void *', ['void *', 'string', 'int32']);
    const kCFStringEncodingUTF8 = 0x08000100;
    const kCFRunLoopCommonModes = cfStrCreate(null, 'kCFRunLoopCommonModes', kCFStringEncodingUTF8);

    const cb = koffi.register((proxy, type, event, ctx) => {
      try {
        if (type === 12) { // flagsChanged — modifier keys pressed/released
          const flags = Number(getFlags(event));
          const combo = (flags & COMBO_FLAGS) === COMBO_FLAGS;
          if (combo && !comboDown) {
            comboDown = true;
            // If the Control press already opened a walkie-talkie hold,
            // cancel it — the combo is a toggle, not a hold.
            if (controlDown) { controlDown = false; if (win) win.webContents.send('ptt-stop'); }
            triggerPTT();
          } else if (!combo && comboDown) {
            comboDown = false; // re-arm once any of the three is released
          }
          return event;
        }
        const keycode = Number(getField(event, 9));
        if (PTT_KEYS.includes(keycode)) {
          if (type === 10 && !controlDown) { // keyDown
            controlDown = true;
            if (win) win.webContents.send('ptt-start');
          } else if (type === 11 && controlDown) { // keyUp
            controlDown = false;
            if (win) win.webContents.send('ptt-stop');
          }
        }
      } catch { /* callback must not throw */ }
      return event;
    }, TapCBPtr);

    const CGEventTapCreate = CG.func('CGEventTapCreate', 'void *', [
      'uint32', 'uint32', 'uint32', 'uint64', TapCBPtr, 'void *'
    ]);

    const mask = (1n << 10n) | (1n << 11n) | (1n << 12n); // keyDown + keyUp + flagsChanged

    // Try session tap first (0), then HID tap (1)
    let tap = null;
    for (const loc of [0, 1]) {
      tap = CGEventTapCreate(loc, 0, 0, mask, cb, null);
      if (tap) { console.log(`[jarvis] CGEvent tap created (loc=${loc})`); break; }
    }

    if (!tap) {
      console.log('[jarvis] CGEvent tap denied — no Accessibility permission');
      return false;
    }

    const src = CF.func('CFMachPortCreateRunLoopSource', 'void *', ['void *', 'void *', 'int64'])(null, tap, 0n);
    addSrc(getRL(), src, kCFRunLoopCommonModes);
    enableTap(tap, true);

    controlTap = tap;
    const keyNames = PTT_KEYS.map(k => k === 0x3b ? 'Control' : 'Right Option').join(' or ');
    console.log(`[jarvis] 🎤 Walkie-talkie ACTIVE (hold ${keyNames} to talk; press Control+Option+Command to toggle)`);
    return true;
  } catch (err) {
    console.log('[jarvis] CGEvent tap error:', err.message.slice(0, 120));
    return false;
  }
}

function stopControlTap() {
  if (!controlTap) return;
  try {
    const CG = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    CG.func('CGEventTapEnable', 'void', ['void *', 'bool'])(controlTap, false);
  } catch { /* best-effort */ }
  controlTap = null;
  controlDown = false;
}

// ── menu-bar tray + launch at login ─────────────────────────────────────
// The assistant should feel like a system service: a menu-bar face that is
// always reachable, and the app starting with the Mac.

function loginItemEnabled() {
  try { return app.getLoginItemSettings().openAtLogin; } catch { return false; }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Momzu', click: () => { hideMiniWindow(); if (win) { win.show(); win.focus(); } } },
    { label: 'Push to Talk', accelerator: 'Alt+Space', click: () => triggerPTT() },
    { label: 'Dictation Mode', accelerator: 'CmdOrCtrl+Shift+D', click: () => { if (win) win.webContents.send('dictate-toggle'); } },
    { type: 'separator' },
    {
      label: 'Start at Login',
      type: 'checkbox',
      checked: loginItemEnabled(),
      click: (item) => {
        try { app.setLoginItemSettings({ openAtLogin: item.checked }); } catch { /* MAS/dev builds */ }
      },
    },
    { type: 'separator' },
    { label: 'Quit Momzu', accelerator: 'Cmd+Q', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  if (tray) return;
  try {
    const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    // Template image: macOS recolors it (white on dark menu bar, black on light).
    img.setTemplateImage(true);
    tray = new Tray(img);
    tray.setToolTip('Momzu — click to open');
    tray.setContextMenu(buildTrayMenu());
    // Rebuild before showing so the Start-at-Login checkmark stays truthful.
    tray.on('mouse-down', () => tray.setContextMenu(buildTrayMenu()));
  } catch (err) {
    console.log('[jarvis] tray unavailable:', err.message.slice(0, 80));
  }
}

// First packaged run: register as a login item once, and remember that we
// did — if the user later unticks it in the tray, never re-force it.
function initLoginItem() {
  if (!app.isPackaged) return; // dev electron must not register itself
  try {
    const state = JSON.parse(fs.readFileSync(uiStatePath(), 'utf8'));
    if (state.loginItemInitialized) return;
  } catch { /* first run */ }
  try {
    app.setLoginItemSettings({ openAtLogin: true });
    const state = (() => {
      try { return JSON.parse(fs.readFileSync(uiStatePath(), 'utf8')); } catch { return {}; }
    })();
    state.loginItemInitialized = true;
    fs.writeFileSync(uiStatePath(), JSON.stringify(state));
    console.log('[jarvis] registered as login item (toggle in the menu-bar icon)');
  } catch (err) {
    console.log('[jarvis] login item setup failed:', err.message.slice(0, 80));
  }
}

// Global shortcut toggle — press once, speak, auto-stops on silence.
// ALL candidates that register successfully stay active, so the simplest
// combo (Option+Space, two keys) works alongside the old Cmd+Shift+Space.
function registerGlobalPTT() {
  const candidates = [
    'Alt+Space',                     // Option+Space — primary, two keys
    'CommandOrControl+Shift+Space',  // previous shortcut, kept working
  ];
  const registered = [];
  for (const key of candidates) {
    try {
      if (globalShortcut.register(key, triggerPTT)) registered.push(key);
    } catch (err) { console.log(`[jarvis] "${key}" failed:`, err.message.slice(0, 80)); }
  }
  if (registered.length) console.log(`[jarvis] PTT shortcuts: ${registered.join(', ')}`);
  else console.log('[jarvis] WARNING: no PTT shortcut registered');
  return registered[0] || null;
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(permission === 'media');
  });

  loadUiState();
  startOrchestrator();
  createTray();
  initLoginItem();

  // Give the orchestrator a moment to bind its port, then open the window.
  setTimeout(createWindow, 800);

  // Walkie-talkie: hold Control to talk (uses in-process CGEvent tap).
  // If Accessibility isn't granted, show the system prompt once so the user
  // can enable it, and keep retrying quietly — the tap starts working the
  // moment permission is flipped on, no restart needed.
  if (!startControlTap()) {
    const { systemPreferences } = require('electron');
    try { systemPreferences.isTrustedAccessibilityClient(true); } catch { /* prompt is best-effort */ }
    const retry = setInterval(() => {
      if (controlTap) { clearInterval(retry); return; }
      if (startControlTap()) clearInterval(retry);
    }, 15000);
  }

  // Always register the global toggle shortcut — independent of walkie-talkie.
  registerGlobalPTT();

  // Ctrl+Opt+Cmd toggle — permissionless polling watcher, independent of
  // the CGEvent tap and of Accessibility.
  startComboWatcher();

  globalShortcut.register('CommandOrControl+Shift+D', () => {
    if (win) win.webContents.send('dictate-toggle');
  });

  app.on('activate', () => {
    // Dock icon clicked while hidden in widget mode → bring the app back.
    if (win) {
      hideMiniWindow();
      win.show();
      win.focus();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // IPC: mini overlay double-clicked → restore the main window.
  ipcMain.on('restore-main', () => {
    hideMiniWindow();
    if (win) {
      win.show();
      win.restore();
      win.focus();
    }
  });

  // IPC: mini overlay single-clicked → toggle push-to-talk, exactly like
  // the global shortcut (main window keeps running while hidden).
  ipcMain.on('ptt-toggle-request', () => {
    if (win) win.webContents.send('ptt-toggle');
  });

  // IPC: manual widget drag. The renderer streams deltas from the pointer's
  // screen position; we move the window relative to where the drag started.
  let miniDragOrigin = null;
  ipcMain.on('mini-drag-start', () => {
    if (miniWindow && !miniWindow.isDestroyed()) {
      const [x, y] = miniWindow.getPosition();
      miniDragOrigin = { x, y };
    }
  });
  ipcMain.on('mini-drag', (e, pos) => {
    const dx = Number(pos && pos.dx);
    const dy = Number(pos && pos.dy);
    if (!miniWindow || miniWindow.isDestroyed() || !miniDragOrigin
        || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    // A single glitched pointer frame (huge/garbage screenX delta) used to
    // reach setPosition unclamped and crash the app with an uncaught
    // "conversion failure" TypeError. Bound every move to a sane range,
    // clamp to the display, and never let setPosition take the app down.
    const rawX = Math.max(-32000, Math.min(32000, Math.round(miniDragOrigin.x + dx)));
    const rawY = Math.max(-32000, Math.min(32000, Math.round(miniDragOrigin.y + dy)));
    try {
      const { x, y } = clampToDisplay(rawX, rawY, 160, 180);
      miniWindow.setPosition(Math.round(x), Math.round(y));
    } catch (err) { console.error('[jarvis] mini-drag setPosition failed:', err.message); }
  });
  ipcMain.on('mini-drag-end', () => {
    miniDragOrigin = null;
    if (miniWindow && !miniWindow.isDestroyed()) {
      try {
        // Snap fully back on screen if dropped half off the edge, then persist.
        const [x, y] = miniWindow.getPosition();
        const clamped = clampToDisplay(x, y, 160, 180);
        if (clamped.x !== x || clamped.y !== y) miniWindow.setPosition(clamped.x, clamped.y);
        miniSavedPosition = clamped;
        saveUiState();
      } catch (err) { console.error('[jarvis] mini-drag-end failed:', err.message); }
    }
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => {
  stopControlTap();
  globalShortcut.unregisterAll();
  stopOrchestrator();
  saveUiState();
});
app.on('window-all-closed', () => {
  // Only reached on real quit — closing the main window hides it instead.
  hideMiniWindow();
  app.quit();
});
