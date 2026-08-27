# LabSight × Seeed reCamera Pro

LabSight's browser UI can use USB/UVC cameras directly through `getUserMedia()`. Seeed reCamera Pro is different: over Wi‑Fi it exposes a network stream (RTSP) plus HTTP APIs, and mainstream browsers do **not** play RTSP directly.

This local bridge converts reCamera Pro's RTSP stream into JPEG frames that LabSight can consume from `localhost`, while keeping the existing LabSight capture / Deep Vision code unchanged.

## Official reCamera Pro software stack

- reCamera OS (Linux on RV1126B)
- Wi‑Fi 5.2 / Ethernet / USB CDC-NCM networking
- RTSP streaming
- HTTP/HTTPS Web API under `/cgi-bin/entry.cgi/...`
- built-in Web UI
- Node-RED / C/C++ secondary development

For Wi‑Fi use there is no PC camera driver to install. The camera is a network device. USB networking uses CDC-NCM; modern Linux/macOS and recent Windows support it without a vendor-specific driver.

## Run the bridge

From the repository root:

```bash
python3 -m venv .venv-recamera
source .venv-recamera/bin/activate
pip install -r tools/requirements-recamera-bridge.txt
python tools/recamera_bridge.py
```

Windows PowerShell:

```powershell
py -m venv .venv-recamera
.\.venv-recamera\Scripts\Activate.ps1
pip install -r tools/requirements-recamera-bridge.txt
python tools/recamera_bridge.py
```

The bridge listens on:

```text
http://127.0.0.1:8765
```

Health check:

```text
http://127.0.0.1:8765/health
```

## In LabSight

1. Put reCamera Pro and the computer on the same Wi‑Fi/LAN.
2. In LabSight choose **Seeed reCamera Pro（Wi‑Fi）**.
3. Enter the reCamera Pro IP, username and device password.
4. Keep Bridge URL at `http://127.0.0.1:8765`.
5. Click **连接 reCamera Pro**.

The bridge uses this RTSP form by default:

```text
rtsp://USER:PASSWORD@CAMERA_IP:554/live
```

If your reCamera Pro firmware uses a different stream path, edit `rtsp_path` in `camera-adapters.js` or extend the UI to expose the path.

## Audio

The first integration uses reCamera Pro for video and keeps LabSight's selected local/USB microphone for voice input. reCamera Pro has dual microphones, but forwarding RTSP audio into a browser MediaStream requires a WebRTC audio bridge and is intentionally left for the next adapter revision.

## Autofocus

reCamera Pro's default M12 camera module is treated as a lens-controlled/fixed-focus source. LabSight does not claim autofocus unless the specific replacement camera/lens exposes a controllable focus actuator.

For Insta360 Link/Link 2/Link 2C, LabSight checks the browser's `MediaStreamTrack.getCapabilities().focusMode`; if `continuous` is exposed it explicitly enables continuous AF. If the browser does not expose the UVC focus control, LabSight leaves the camera firmware's native autofocus behavior active and reports that state in the UI.
