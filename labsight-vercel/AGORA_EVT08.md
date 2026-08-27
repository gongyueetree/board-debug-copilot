# LabSight EVT0.8 · Agora Voice Adapter

EVT0.8 keeps the existing LabSight camera / PCB Deep Vision path intact and adds Agora as an A/B realtime voice runtime.

## Architecture

```text
Browser microphone
  -> Agora Web RTC SDK
  -> Agora Conversational AI Engine
     -> managed Deepgram ASR
     -> LabSight OpenAI-compatible streaming gateway (/api/agora_chat)
        -> OpenAI or Gemini selected in the LabSight UI
     -> managed MiniMax TTS
  -> Agora RTC remote audio
  -> browser speaker
```

Legacy Voice remains available from the `语音模式` selector.

## Required Vercel environment variables

```text
AGORA_APP_ID
AGORA_APP_CERTIFICATE
AGORA_CUSTOMER_ID
AGORA_CUSTOMER_SECRET
```

`AGORA_CUSTOMER_ID` and `AGORA_CUSTOMER_SECRET` are the REST API credentials used by the backend to start/stop a Conversational AI agent. Do not put them in browser JavaScript.

The backend generates short-lived RTC tokens for the browser user and the agent with `agora-token-builder`.

## Optional tuning

```text
AGORA_ASR_MODEL=nova-3
AGORA_ASR_LANGUAGE=multi
AGORA_LLM_MAX_TOKENS=220
AGORA_LLM_TEMPERATURE=0.35
AGORA_TTS_VENDOR=minimax
AGORA_TTS_MODEL=speech-2.6-turbo
AGORA_TTS_VOICE_ID=
```

Leave `AGORA_TTS_VOICE_ID` empty until Agora provides the preferred Mandarin voice ID for the account/model catalog. The adapter intentionally omits an unknown voice override rather than failing the entire agent start.

## LabSight LLM gateway

On Vercel the session endpoint automatically derives the public deployment URL and points Agora to:

```text
https://<current-vercel-deployment>/api/agora_chat
```

The gateway implements OpenAI Chat Completions-style SSE streaming. The LabSight `AI Provider` selection is passed when the Agora session starts:

- `OpenAI` -> `AGORA_OPENAI_MODEL` (default `gpt-4o-mini`)
- `Gemini` -> `AGORA_GEMINI_MODEL` (default `gemini-2.5-flash`)

Optional overrides:

```text
AGORA_OPENAI_MODEL=gpt-4o-mini
AGORA_GEMINI_MODEL=gemini-2.5-flash
AGORA_CUSTOM_LLM_URL=https://your-domain/api/agora_chat
AGORA_CUSTOM_LLM_API_KEY=<random-secret>
```

If `AGORA_CUSTOM_LLM_API_KEY` is not set, EVT0.8 uses the app certificate as the server-to-server gateway credential. For production use a separate random secret.

## Browser flow

1. Connect the camera/microphone as usual.
2. Choose `Agora 实时语音` under `语音模式`.
3. Click `启动 Agora 对话` or the microphone button.
4. Speak continuously. There is no manual submit step.
5. While the AI is speaking, speak again to test interruption/barge-in.
6. Click `结束 Agora 对话` to leave the RTC channel and stop the agent.

The selected microphone in the LabSight device selector is passed to the Agora Web SDK. AEC, AGC and ANS are enabled on the Agora microphone track.

## EVT0.8 scope / known limitation

EVT0.8 replaces the voice transport/ASR/turn-taking/TTS path only. It does **not yet automatically inject the current camera frame into every voice turn**. If a spoken question requires the live PCB/instrument image, the LabSight gateway tells the user to run `分析当前画面` or `PCB Deep Vision`.

The next multimodal step is EVT0.9: bind the Agora voice session to a LabSight visual-session ID, let the browser/reCamera publish current best-frame/ROI context, and inject that context into `/api/agora_chat` before the LLM request.

## Troubleshooting

- `/api/health` exposes `agora.configured` and missing variable names.
- If session start fails with 401/403, verify Agora Customer ID/Secret and Conversational AI feature enablement.
- If the agent starts but the browser cannot join, verify App ID/App Certificate and RTC token settings.
- If there is no AI audio, inspect the browser console for `user-published`, and verify the configured TTS model is enabled for managed mode.
- If Chinese ASR quality is poor, ask Agora to recommend the best Deepgram `language`/multilingual setting and domain phrase hints for electronics terms.
