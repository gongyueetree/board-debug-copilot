from http.server import BaseHTTPRequestHandler
import json
import os
import time


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        openai_key = bool(os.getenv("OPENAI_API_KEY"))
        gemini_key = bool(os.getenv("GEMINI_API_KEY"))
        agora_required = [
            "AGORA_APP_ID",
            "AGORA_APP_CERTIFICATE",
            "AGORA_CUSTOMER_ID",
            "AGORA_CUSTOMER_SECRET",
        ]
        agora_missing = [name for name in agora_required if not os.getenv(name)]
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
            "agora": {
                "configured": not agora_missing,
                "missing": agora_missing,
                "asr_model": os.getenv("AGORA_ASR_MODEL", "nova-3"),
                "llm_model": os.getenv("AGORA_CUSTOM_LLM_MODEL") if os.getenv("AGORA_CUSTOM_LLM_URL") else os.getenv("AGORA_LLM_MODEL", "gpt-4o-mini"),
                "tts_model": os.getenv("AGORA_TTS_MODEL", "speech-2.6-turbo"),
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
