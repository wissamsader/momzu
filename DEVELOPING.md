# Developing Momzu

This repo holds the full app source (plus the momzu.space website and the
release DMGs). Users just want [README.md](README.md) and [GUIDE.md](GUIDE.md);
this file is for running Momzu from source and hacking on it.

## Run from source

Requirements: a Mac with Apple Silicon, Node 20+, and for voice input
`ffmpeg` + `whisper-cli` on your PATH (`brew install ffmpeg whisper-cpp`).
The whisper model (~870 MB, one-time) downloads itself into
`~/.momzu/whisper-models` on first launch.

```
git clone https://github.com/wissamsader/momzu
cd momzu
npm install
npm run dev
```

This starts the orchestrator (backend) and opens the dashboard.

## Build the DMG

```
npm run build        # → dist/Momzu-<version>-arm64.dmg
```

The official DMG bundles its own node/ffmpeg/whisper binaries so users need
nothing preinstalled — see [bin/README.md](bin/README.md) for what to drop
into `bin/` to reproduce that. Without them the build still works; the
packaged app falls back to PATH installs.

## Talk to it

- **Hold spacebar** (when not typing) and speak, release to send
- **⌃⌥⌘** (or ⌥Space / ⌘⇧Space) from anywhere on your Mac toggles the mic
- Or just type in the input bar

Speech-to-text runs locally via whisper.cpp; replies are spoken via Kokoro or
macOS `say` — no audio ever leaves the Mac.

## Architecture

```
dashboard (Electron UI + phone browser)  ←ws/http :8765→  orchestrator (Node)
                                                  ├─ providers/  (claude-agent, claude-cli, anthropic, deepseek, gemini, ollama)
                                                  ├─ tools.js    (shared toolkit: apps, chrome, calendar, music, weather, lists, routines)
                                                  ├─ voice/stt   (mic → ffmpeg → whisper.cpp, local, model auto-downloaded)
                                                  ├─ voice/tts   (kokoro sidecar / say, local)
                                                  ├─ memory.js   (SQLite FTS5 conversation memory, retention-pruned)
                                                  └─ profile.js  (background fact extraction → profile.json → system prompt)
```

All state (config overrides, API keys, memory, reminders, routines) lives in
`config/state/`, which is gitignored — nothing personal can end up in a commit.

## Customize

Defaults live in `config/jarvis.config.json` (user changes are saved as
overrides in `config/state/`):

- `defaultProvider`, per-provider models + effort
- `systemPrompt` — Momzu's personality
- `commandDeck` — the quick-action buttons
- `voice.tts` — Kokoro voice / `say` voices (♪ VOICE panel in the app)
- `voice.stt.model` — whisper model name (`large-v3-turbo-q8_0`, `medium`, …)
- `memory.retentionDays` — how long conversation turns are kept (default 90)

Theme: edit the CSS variables at the top of `dashboard/renderer/theme.css`.
App icon: `build/icon.svg` → regenerate `build/icon.icns` after edits.

## Add a provider

Create `orchestrator/providers/yourmodel.js` exporting
`createProvider(config)` → `{ id, label, reset(), async *chat(messages, opts) }`,
register it in `orchestrator/providers/index.js`, add an entry in the config.
Give it the shared toolkit via `streamOpenAICompatTools` if the API supports
function calling.

## Tests

`test/` holds end-to-end scripts that run against a live orchestrator on
:8765 (start `npm run dev` first), e.g.:

```
node test/stop-command-test.js
node test/speech-gate-test.js
```
