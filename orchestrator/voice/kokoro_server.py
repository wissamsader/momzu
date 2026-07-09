# Kokoro sidecar — local HTTP server keeping the Kokoro neural TTS warm.
# ~80MB model, faster than realtime on Apple Silicon CPU. Started by the
# orchestrator when voice.tts.engine == "kokoro"; tts.js falls back to
# macOS `say` whenever this server is missing or slow.
#
# GET  /health -> 200 {"ok": true} once loaded, else 503
# POST /tts {"text":.., "voice": "af_heart", "lang": "en-us", "speed": 1.0} -> audio/wav

import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8791
MODEL_DIR = os.path.expanduser("~/.momzu/kokoro")

model = None
load_error = None
lock = threading.Lock()


def log(msg):
    # NEVER let logging kill a request: if the parent orchestrator dies, our
    # stdout pipe breaks and a bare print() raises BrokenPipeError — which
    # used to 500 every /tts call until the Mac was rebooted.
    try:
        print(msg, flush=True)
    except OSError:
        pass


def load_model():
    global model, load_error
    try:
        from kokoro_onnx import Kokoro
        m = Kokoro(
            os.path.join(MODEL_DIR, "kokoro-v1.0.onnx"),
            os.path.join(MODEL_DIR, "voices-v1.0.bin"),
        )
        model = m
        log("[kokoro] READY")
    except Exception as e:
        load_error = str(e)
        log(f"[kokoro] load error: {e}")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            if model is not None:
                self._json(200, {"ok": True, "model": "kokoro-v1.0"})
            elif load_error:
                self._json(500, {"ok": False, "error": load_error})
            else:
                self._json(503, {"ok": False, "loading": True})
        else:
            self._json(404, {"ok": False})

    def do_POST(self):
        if self.path != "/tts":
            self._json(404, {"ok": False})
            return
        if model is None:
            self._json(503, {"ok": False, "loading": load_error is None, "error": load_error})
            return
        try:
            n = int(self.headers.get("content-length", 0))
            req = json.loads(self.rfile.read(n))
            text = (req.get("text") or "").strip()
            if not text:
                self._json(400, {"ok": False, "error": "no text"})
                return
            voice = req.get("voice") or "af_heart"
            lang = req.get("lang") or "en-us"
            speed = float(req.get("speed") or 1.0)

            import soundfile as sf
            t0 = time.time()
            with lock:
                samples, sr = model.create(text, voice=voice, speed=speed, lang=lang)
            buf = io.BytesIO()
            sf.write(buf, samples, sr, format="WAV")
            data = buf.getvalue()
            log(f"[kokoro] {len(text)} chars ({voice}/{lang}) -> {len(samples)/sr:.1f}s audio in {time.time()-t0:.1f}s")
            self.send_response(200)
            self.send_header("content-type", "audio/wav")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)[:300]})


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError as e:
        # Port taken (usually a stale sidecar) — exit non-zero so the
        # orchestrator clears the port and respawns us.
        log(f"[kokoro] cannot bind port {PORT}: {e}")
        sys.exit(75)
    log(f"[kokoro] listening on 127.0.0.1:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
