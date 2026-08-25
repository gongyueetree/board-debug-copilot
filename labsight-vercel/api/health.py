from http.server import BaseHTTPRequestHandler
import json
import os
import time


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        openai_key = bool(os.getenv("OPENAI_API_KEY"))
        gemini_key = bool(os.getenv("GEMINI_API_KEY"))
        payload = {
            "ok": True,
            "ai": openai_key or gemini_key,
            "providers": {
                "openai": {
                    "configured": openai_key,
                    "vision_model": os.getenv("OPENAI_VISION_MODEL", "gpt-5.6-luna"),
                    "transcribe_model": os.getenv("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"),
                },
                "gemini": {
                    "configured": gemini_key,
                    "vision_model": os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash"),
                    "audio_model": os.getenv("GEMINI_AUDIO_MODEL", os.getenv("GEMINI_VISION_MODEL", "gemini-2.5-flash")),
                },
            },
            "deployment": "vercel-explicit-functions",
            "time": int(time.time()),
        }
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
