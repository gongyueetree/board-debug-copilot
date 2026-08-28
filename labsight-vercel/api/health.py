from http.server import BaseHTTPRequestHandler
import json
import os
import time


def _has(*names):
    return any(bool(os.getenv(name)) for name in names)


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        openai_key = bool(os.getenv("OPENAI_API_KEY"))
        gemini_key = bool(os.getenv("GEMINI_API_KEY"))

        shengwang_checks = [
            ("SHENGWANG_APP_ID", "AGORA_APP_ID"),
            ("SHENGWANG_APP_CERTIFICATE", "AGORA_APP_CERTIFICATE"),
            ("SHENGWANG_CUSTOMER_ID", "AGORA_CUSTOMER_ID"),
            ("SHENGWANG_CUSTOMER_SECRET", "AGORA_CUSTOMER_SECRET"),
        ]
        shengwang_missing = [a for a, b in shengwang_checks if not _has(a, b)]
        if not gemini_key:
            shengwang_missing.append("GEMINI_API_KEY")

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
                    "tts_model": os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
                    "tts_voice": os.getenv("GEMINI_TTS_VOICE", "Kore"),
                },
            },
            "shengwang": {
                "configured": not shengwang_missing,
                "missing": shengwang_missing,
                "endpoint": "cn",
                "turn_detection": "semantic",
                "semantic_silence_ms": int(os.getenv("SHENGWANG_SEMANTIC_SILENCE_MS", "240")),
                "semantic_max_wait_ms": int(os.getenv("SHENGWANG_SEMANTIC_MAX_WAIT_MS", "3000")),
                "tts_vendor": "generic_http",
                "tts_provider": "gemini",
                "tts_model": os.getenv("GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
                "tts_voice": os.getenv("GEMINI_TTS_VOICE", "Kore"),
                "tts_sample_rate": 24000,
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
