# Momzu — Getting Started

Momzu is a voice assistant that lives on your Mac. You talk to it, it talks back,
and it can answer questions, open apps, set reminders, and keep track of your goals.
Your voice never leaves your computer — speech recognition and speech output both
run locally on your Mac.

## Requirements

- A Mac with Apple Silicon (M1 or newer)
- macOS 13 or newer

## Install

1. Open the file `Momzu-x.x.x-arm64.dmg`.
2. Drag **Momzu** into your **Applications** folder.
3. Open Momzu from Applications. The first time, macOS may ask you to confirm —
   if it does, right-click the app, choose **Open**, then **Open** again.
4. When macOS asks for **Microphone** and **Speech Recognition** access, click
   **Allow**. Momzu can't hear you without it.
5. On first launch Momzu downloads its ears — a ~900 MB speech model, one
   time only. You can type to it right away; the ticker at the bottom shows
   the download progress, and the voice gets sharp when it finishes.

Momzu also puts a small face in the **menu bar** (top right of your screen)
and starts automatically when you log in — you can turn that off from the
menu-bar icon ("Start at Login").

## Connect a brain (do this once, or Momzu can't answer)

Momzu is the voice and the hands — the thinking is done by an AI model of
your choice. Pick one of these, then select it in the dropdown next to the
input bar:

- **Claude (recommended, the full experience)** — you need two things:
  1. A **Claude subscription** (Pro or Max) from claude.ai, or a Claude API key.
  2. The **Claude Code** command-line tool installed and signed in **once**:
     open the **Terminal** app, paste
     `curl -fsSL https://claude.ai/install.sh | bash`, press Enter, then type
     `claude` and follow the sign-in link it prints. That's it — Momzu finds
     it automatically from then on.
  - Optional but great: install the **Claude in Chrome** extension
    (chrome.google.com/webstore, search "Claude") and Momzu can drive your
    real browser — open pages, click, fill forms — when you ask.
- **DeepSeek (easiest, pay-as-you-go)** — create an API key at
  platform.deepseek.com, click **KEYS** in Momzu's top bar, and paste it.
  A few dollars lasts a long time.
- **Gemini** — same idea: key from aistudio.google.com, paste it under **KEYS**.
- **Ollama (free, fully offline)** — for tinkerers: install Ollama
  (ollama.com), run `ollama pull llama3.2`, and pick Ollama in the dropdown.
  Nothing ever leaves your Mac, but it's the least capable option.

If Momzu answers with an error about a model, this section is almost always
the reason — the selected brain isn't connected yet, or its key/login is
missing. Switch the dropdown or add the key and try again.

## Talking to Momzu

There are three ways to give it a command:

- **Hold the spacebar** while the Momzu window is open (and you're not typing in
  the text box), speak, then release. Your words are sent when you let go.
- **Press ⌃⌥⌘ (Control+Option+Command together) from anywhere** on your Mac —
  even when Momzu is in the background — to switch the microphone on or off.
  ⌥Space and ⌘⇧Space do the same.
- **Type** in the input bar at the bottom of the window, like a chat.

Momzu replies out loud and on screen. Keep questions short and natural —
"what's on my calendar", "open Spotify", "remind me to call Alex at 6" — it's a
conversation, not a search engine.

A soft rising **chime** right after you speak means Momzu got your message
and is on it — no filler words, just the chime, then the answer or the result.

- Say **"stop"**, **"wait"** or **"cancel"** to instantly abort whatever it's
  doing — a falling chime confirms. This is immediate, even mid-task.
- If it's busy and you ask for something new, it queues your request and runs
  it right after — nothing you say gets lost.

## The face

The animated face tells you what Momzu is doing:

| Face | Meaning |
|---|---|
| Blue ring, eyes open | Idle — waiting for you |
| Green ring | Listening to you speak |
| Squinting eyes | Thinking / working on your request |
| Mouth moving | Speaking its answer |
| Red ring | Something went wrong — try again |
| Eyes closed, dim glow | Sleeping — use the mic shortcut or start typing to wake it |

While Momzu works on a long task the face keeps its squinting "thinking" look
the whole time — if it's slow, it's working, not stuck.

## Choosing a brain

Momzu can think with different AI models — see **Connect a brain** above for
the one-time setup. Use the dropdown next to the input bar to switch anytime;
Momzu keeps the conversation going across switches. If a model doesn't
respond, its key or login is missing — pick another one or click **KEYS**.

## Permissions Momzu may ask for

- **Microphone** — required, or it can't hear you.
- **Screen Recording** — only needed the first time you use the **SCREEN**
  button or ask "what's on my screen?". macOS will point you to the setting.
- **Automation / Accessibility** — macOS may ask when Momzu opens apps or
  controls music for the first time. Click Allow / OK.

## Privacy

- Your **voice is processed entirely on your Mac** — recordings are never uploaded.
- Only the **text** of your request is sent to the AI model you selected, the same
  way a chat website works. If you use a local model (Ollama), nothing leaves
  your machine at all.

## Nice things to try

- **"What's on my calendar today?"** — the first time, Momzu explains how to
  connect your Google Calendar (you paste one link, once).
- **"Play some music"**, "next song", "what's playing?", "volume 40".
- **"What's the weather?"** — or for any city.
- **"Every morning at 8:30, give me my briefing."** — Momzu will speak a
  morning summary (date, weather, calendar, reminders) on its own. Say
  "remove the morning briefing" to stop it.
- **On your phone**: click **📱 PHONE** in the top bar and scan the QR code
  with your phone camera (same Wi-Fi). You can chat with your Mac — typing
  AND voice — from anywhere in the house. The first time, your phone's
  browser shows a security warning (Momzu uses a self-made certificate on
  your own network): tap **Advanced → proceed** once and it's remembered.
- **"Play Habaytak Bisayf by Fairuz"** — it finds the exact song on Spotify
  and plays it in the app. Skip, pause, and "what's playing?" also work.

## Tips

- Speak normally — no wake word needed, the mic shortcut is the trigger.
- If Momzu mishears you, just say "no, I meant…" — it remembers the conversation.
- Momzu quietly remembers useful things about you between conversations
  (projects, people, preferences) — everything stays on your Mac. The MEMORY
  panel shows and clears it.
- Quit and reopen the app if the voice ever gets stuck.

Enjoy — and if something breaks, quit and reopen the app; nine times out of
ten that's the whole fix.
