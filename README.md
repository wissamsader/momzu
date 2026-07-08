# Momzu

A voice AI that lives on your Mac. Press a key, speak, done. It talks back, browses your real Chrome, opens apps, reads your calendar, plays your music by name, runs routines, remembers you — and answers on your phone from across the house.

**[⬇ Download for macOS](https://github.com/wissamsader/momzu/releases/latest/download/Momzu.dmg)**

free · apple silicon · no account · no tracking

## What it does

- **Talks** — replies are spoken aloud with a natural local voice. Push-to-talk from anywhere with ⌥Space, hold the spacebar in the app, or just type. A soft chime confirms it heard you; say *"stop"* or *"wait"* to instantly abort anything, even mid-task.
- **Does things** — opens apps, controls your Mac, writes files, drives your real logged-in Chrome (with the Claude in Chrome extension), looks at your screen when asked.
- **Knows your day** — Google Calendar agenda, timed spoken reminders, objectives, and routines ("every morning at 8:30, give me my briefing").
- **Plays your music** — "play Kind of Blue" finds the exact record on Spotify and plays it in the desktop app. Skip, pause, volume, "what's playing?".
- **Remembers** — conversations land in a local search index, and durable facts about you are quietly learned between sessions. All of it stays on your Mac; the MEMORY panel shows and clears it.
- **Phone remote** — click 📱 PHONE, scan the QR code, and talk to your Mac from anywhere on your Wi-Fi — typing and voice both work.
- **Any mind** — Claude in full agent mode, DeepSeek, Gemini, or a completely local model through Ollama. Switch in one click and dial how hard it thinks.

## Two minutes of setup

1. **Open it** — drag Momzu into Applications. First launch: right-click → **Open** → **Open** (it's unsigned). Allow the microphone. It downloads its ears once (~900 MB, one time).
2. **Connect a mind** — Momzu is the body; you pick the brain:
   - **Claude (recommended)** — you need a Claude subscription (Pro/Max) and the [Claude Code](https://claude.com/claude-code) command-line tool: open Terminal, run `curl -fsSL https://claude.ai/install.sh | bash`, then run `claude` once and follow the sign-in link. Momzu finds it automatically from then on.
   - **DeepSeek / Gemini** — create an API key (platform.deepseek.com / aistudio.google.com), press **KEYS** in Momzu's top bar, paste it.
   - **Ollama** — fully offline: install [Ollama](https://ollama.com), `ollama pull llama3.2`, pick it in the dropdown.
3. **Talk** — hold space and speak, or press **⌥Space** from anywhere. A soft chime means it got you.

The full manual is in [GUIDE.md](GUIDE.md) — read it once, it answers everything (permissions, phone setup, the face's moods, tips).

## Privacy

- Your **voice never leaves your Mac** — speech-to-text and text-to-speech both run locally.
- Only the **text** of your request goes to the AI model you selected, like any chat app. With Ollama, nothing leaves your machine at all.
- No account, no telemetry, no tracking.

## Requirements

- Mac with Apple Silicon (M1 or newer), macOS 13+
- An AI model connection (see setup above)

## Support

Momzu is free. If it helped you, you can [buy me a coffee](https://buymeacoffee.com/wissamsader) ☕

---

*Momzu is currently distributed as a free app; the source code is not public at this time.*
