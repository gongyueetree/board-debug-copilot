# LabSight × ESP32-S31 Edge Camera

## Scope

This integration adds ESP32-S31 as a LabSight Edge Camera source in the main product workspace.

Product path:

    ezPLM Project
      -> LabSight A6
      -> CameraCapturePanel
      -> local S31 Edge Bridge (127.0.0.1:18766)
      -> ESP32-S31 over Wi-Fi/LAN
      -> USB UVC camera
      -> JPEG snapshot
      -> existing BoardPhoto upload
      -> Vision / KiCad alignment / Evidence / Debug Session

The browser never needs to reach the S31 private HTTP address directly. The localhost bridge exists because the production LabSight page is HTTPS while the MCU is normally an HTTP device on a private LAN.

## Current product behavior

The LabSight camera source selector now includes:

- USB / UVC
- ESP32-S31 Edge Camera
- Seeed reCamera Pro

S31 mode supports:

- 3840x2160
- 3264x2448
- 1920x1080
- 1280x720
- JPEG quality 50-100
- optional device Bearer token
- manual high-resolution refresh
- optional 1 fps AI Inspect preview
- capture-and-save into the existing project BoardPhoto flow
- capture-and-analyze through the existing multimodal photo analysis flow

The 1 fps preview does not automatically upload photos or call the model. Only explicit Save / AI actions persist evidence, so an idle debug session does not generate storage or model cost every second.

## S31 firmware API contract

The firmware should expose three endpoints.

### Device information

    GET /api/v1/device

Suggested response:

    {
      "deviceId": "LS-S31-001",
      "name": "LabSight S31 Edge Node",
      "hardware": "ESP32-S31",
      "firmware": "0.1.0",
      "camera": {
        "connected": true,
        "format": "MJPEG",
        "maxResolution": "3840x2160",
        "resolutions": [
          "3840x2160",
          "3264x2448",
          "1920x1080",
          "1280x720"
        ]
      }
    }

### Camera status

    GET /api/v1/camera/status

Suggested response:

    {
      "connected": true,
      "uvc": true,
      "format": "MJPEG",
      "resolution": "3840x2160",
      "lastFrameBytes": 2431582
    }

### Capture

    POST /api/v1/camera/capture

Request:

    {
      "resolution": "3840x2160",
      "quality": 92,
      "purpose": "preview"
    }

Preferred response:

    Content-Type: image/jpeg
    <raw JPEG bytes>

The bridge also accepts JSON responses containing imageUrl / image_url / url or imageBase64 / image_base64.

For LabSight, the preferred S31 implementation is to keep the UVC MJPEG/JPEG compressed frame and forward it without decoding to RGB.

## Run the local bridge

macOS / Linux:

    python3 -m venv .venv-s31
    source .venv-s31/bin/activate
    pip install -r tools/requirements-s31-bridge.txt
    python tools/s31_edge_bridge.py --host 127.0.0.1 --port 18766

Windows PowerShell:

    py -m venv .venv-s31
    .\.venv-s31\Scripts\Activate.ps1
    pip install -r tools/requirements-s31-bridge.txt
    python tools/s31_edge_bridge.py --host 127.0.0.1 --port 18766

Health endpoint:

    http://127.0.0.1:18766/health

The bridge only permits RFC1918 private IPs, loopback/link-local addresses, or .local hostnames. It will not proxy arbitrary public hosts.

## Configure LabSight

Open:

    /projects/<projectId>/labsight

Then:

1. Select ESP32-S31 Edge Camera.
2. Enter the S31 IP address or .local hostname.
3. Keep Bridge Port at 18766.
4. Select 3840x2160 or 3264x2448.
5. Set JPEG Quality to about 92 for PCB inspection.
6. Add the device token only when the S31 firmware requires it.
7. Click Connect S31 Edge Camera.
8. Use Refresh HD Frame for an immediate snapshot.
9. Enable AI Inspect 1 fps when continuous visual observation is useful.
10. Use Capture & Save or Capture & AI Detect to persist a frame into the project.

## Evidence semantics

S31 is only a transport/source. Once a snapshot is saved, it follows the same path as every other BoardPhoto:

    S31 JPEG
      -> BoardPhoto
      -> VisualFinding
      -> KiCad alignment / assembly inspection
      -> LabEvidence
      -> Ref / Net / Pin / TestStep
      -> Issue / ECO draft

This avoids building a second S31-specific AI path.

## Production direction

The localhost bridge is the P0 path and is directly usable for development and on-site debugging.

The production device path should later move to an outbound LabSight Device Gateway connection:

    S31 -> outbound WSS/HTTPS -> Device Gateway -> A6

The image payload should use signed object-storage upload while the control channel carries only status, commands and result metadata. This keeps the same camera tool contract while removing dependence on a local desktop bridge.
