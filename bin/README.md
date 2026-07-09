# bin/ — bundled binaries (not in git)

The packaged DMG ships self-contained copies of its runtime tools in this
folder. They are large prebuilt binaries, so they are not committed — for
development you don't need any of them: `npm run dev` falls back to whatever
is on your PATH.

To produce a fully self-contained DMG like the official one, place:

- `bin/node/node` — a standalone Node.js runtime (arm64 build from nodejs.org).
  Without it the packaged app looks for node in fnm / Homebrew / PATH.
- `bin/ffmpeg/ffmpeg` — a static ffmpeg build (used to convert mic audio for
  whisper). Without it, `ffmpeg` from PATH is used (`brew install ffmpeg`).
- `bin/whisper/` — a whisper.cpp build: `whisper-cli` plus its dylibs
  (`libwhisper`, `libggml*`, `libomp`). Without it, `whisper-cli` from PATH is
  used (`brew install whisper-cpp`). Whisper **models** are never bundled —
  the app downloads its model into `~/.momzu/whisper-models` on first launch.

`speech-recognizer.swift` is the source of a legacy Apple-SFSpeechRecognizer
helper; it is kept for reference and no longer bundled.
