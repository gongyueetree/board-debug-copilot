# LabSight Camera / Voice integration into Board Debug Copilot

## Decision

`apps/web + apps/api + packages/ai` remains the product codebase. `labsight-vercel/` is treated as a fast experimental sandbox for camera / realtime voice ideas.

Do **not** rebuild the mature Board Debug Copilot capabilities inside the static `labsight-vercel` prototype. Instead, move the useful LabSight capabilities into the main application.

## Existing main-product capabilities worth preserving

The main application already has the more complete debugging-agent architecture:

- KiCad ZIP upload and parse pipeline
- design graph, components, nets, test points, ERC/DRC and deterministic rules
- AI design review
- measurement guide
- ADALM2000 local bridge and safety guards
- waveform capture and diagnosis
- board photo storage, annotations and multimodal photo analysis
- parts knowledge search
- debugging plan / step state
- activity timeline and report generation
- SSE agent chat with grounded project context
- provider abstraction for Gemini / Claude / DeepSeek
- auth, storage, queue, contracts and regression tests

These should remain the source of truth.

## LabSight features to migrate

### P0 — live camera acquisition — DONE

Main Photos page now supports:

- browser UVC cameras including Insta360 Link
- request up to 4K / 30 fps
- continuous autofocus where browser UVC capabilities expose it
- firmware-AF fallback for Insta360 Link devices
- Seeed reCamera Pro via local RTSP → WebRTC bridge
- capture the native video frame
- upload the frame into the existing project photo pipeline
- optionally run the existing `/ai/analyze-photo` multimodal analysis immediately

The result is no longer a separate camera demo: camera frames become normal `BoardPhoto` evidence in the project and therefore participate in later diagnosis and reports.

### P1 — Deep Vision ROI capture

Port the useful part of `labsight-vercel` Deep Vision into the main photo flow:

1. capture native full-resolution overview
2. detect / select PCB ROI
3. create 3–6 high-value tiles instead of blindly uploading a low-resolution screenshot
4. send overview + tiles to one structured vision task
5. persist component / connector / marking observations as project evidence

This should be implemented in `apps/api` / `packages/ai`, not as a standalone Vercel endpoint.

### P1 — assembly inspection against KiCad placement

The important rule is that a footprint, not an individual pad, is the comparison unit.

Required flow:

1. extract each PCB footprint from the parsed `.kicad_pcb`
2. retain reference, value, package, XY, rotation, side and all pad coordinates
3. group all pads belonging to the same footprint
4. align the physical PCB photo to the design board coordinates
5. determine whether the expected component body is present at each footprint
6. exclude mechanical holes, test points, pogo contact patterns and `exclude_from_bom / exclude_from_pos_files`
7. return only direct results: confirmed missing and uncertain

The UI should avoid generic board descriptions. Example output:

`确认未安装：J2 (SYN)、J4 (WAV)`

### P1 — photo-to-PCB homography

Replace seed / placeholder alignment with real alignment using board outline, mounting holes and distinctive reference features. Once aligned, project component references and missing-component warnings directly onto the live camera image.

### P2 — Shengwang realtime voice

Migrate the ConvoAI adapter into the main app after the live camera path stabilizes. Voice should call the same main agent / context APIs, not maintain a second LLM stack.

Target conversation context:

- current project design graph
- latest camera frame / selected ROI when the question is visual
- latest measurements
- current debug step
- recent diagnosis

## Architecture target

```text
Insta360 / UVC / reCamera Pro
            |
       Browser WebRTC/UVC
            |
        BoardPhoto evidence
            |
  +---------+----------+
  |                    |
KiCad design graph   Deep Vision
  |                    |
  +---------+----------+
            |
      AI Orchestrator
            |
  design review / assembly check /
  measurement guide / diagnosis
            |
     Shengwang realtime voice
```

## Integration rule

New LabSight experiments should first prove UX in `labsight-vercel`, then migrate into the main product as reusable components / agent skills. Avoid duplicating project state, KiCad parsing, AI routing or persistence in the prototype.
