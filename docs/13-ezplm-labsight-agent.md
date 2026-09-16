# LabSight A6 → ezPLM project agent

## Product decision

LabSight is no longer treated as a standalone camera demo. The production form is a **project-level callable Agent inside ezPLM**:

```text
ezPLM Project
   ├─ Design / Revision / BOM / Parts / Issues / ECO
   └─ LabSight A6
        ├─ Camera / reCamera
        ├─ KiCad ↔ physical PCB
        ├─ Measurements / waveforms
        ├─ Evidence Timeline
        ├─ Hypotheses / next best test
        └─ Issue / ECO drafts → human confirmation → write
```

The `labsight-vercel/` application remains an experiment sandbox. Product features belong in `apps/web + apps/api + packages/*` and reuse the existing project context, storage, AI provider abstraction and safety rules.

## Current P0 integration

### Callable Agent API

Main API exposes a stable ezPLM-facing surface:

```http
GET  /api/v1/ai/labsight-agent/manifest
POST /api/v1/ai/labsight-agent/invoke
```

Supported actions:

- `chat` — grounded project-context Q&A
- `measure_guide` — next measurement guidance
- `design_review` — deterministic + AI design review
- `analyze_photo` — physical PCB / instrument image analysis
- `assembly_align` — KiCad ↔ physical PCB registration
- `assembly_inspect` — footprint-based population inspection
- `analyze_capture` — waveform / measurement diagnosis

`/ai/chat` remains the native SSE path for realtime UI. `labsight-agent/invoke` collects the same agent stream into JSON for server-to-server ezPLM invocation.

### Project workspace

Route:

```text
/projects/:projectId/labsight
```

It contains two work modes:

1. **Realtime Debug**
   - UVC / Insta360 / reCamera camera entry
   - project engineering context
   - latest evidence strip
   - unified A6 chat
   - measurement / Issue draft / ECO draft actions

2. **PCB Compare**
   - physical PCB photo
   - KiCad-aligned design view
   - annotations and visual findings
   - alignment / footprint population inspection
   - A6 chat in the same project context

## Context rule

A6 must not maintain a shadow copy of ezPLM project state. Context is read from the main project model:

- Project + design revision
- Components / nets / test points
- KiCad design graph
- Board photos and visual findings
- Measurements / captures / instrument metadata
- Latest diagnosis
- Debug plan / current step
- Activity / Evidence Timeline

Every piece of evidence should ultimately be addressable by a stable reference, for example:

```text
photo:<photoId>/ref:U3
capture:<captureId>/net:3V3
kicad:<designVersion>/ref:U3/pad:5
measurement:<captureId>/ch:CH1
session:<debugSessionId>/event:<eventId>
```

## Write policy

LabSight may diagnose automatically; it may **not** silently mutate ezPLM.

```text
Observation / diagnosis         → can render directly
Issue candidate                 → draft Suggestion
ECO candidate                   → draft Suggestion
Project / BOM / revision write  → diff preview + human confirmation
Power / actuator action         → explicit safety confirmation
```

This matches `ezplm-agents` A6 contract: `Suggestion.autoApplyForbidden = true`.

## Next phases

### P1 — Debug → ezPLM closed loop

- Bind every capture to `Net / Pin / RefDes / TestStep`
- Turn confirmed diagnosis into an **Issue draft**
- Turn verified design-change recommendation into an **ECO draft**
- Add project quick links for schematic / PCB / BOM / datasheet / inventory
- Persist Debug Session and Evidence Timeline in the project, not browser localStorage

### P2 — Golden Board

- Known-good board as a project asset
- Compare same test graph node: voltage / waveform / timing / image ROI
- Difference ranking instead of generic “normal/abnormal” answers

### P3 — Guided next measurement

- Hypothesis → expected observation → best next test
- Select the next measurement by information gain and safety cost
- Show why the measurement is requested before the engineer performs it

### P4 — Structured instrument truth

- Scope / DMM / PSU metadata first; camera OCR second
- Bind probe ratio, coupling, timebase, channel scale and sample rate to each capture
- Add additional local instrument adapters behind the existing Bridge safety model

### P5 — Shengwang realtime voice convergence

- Shengwang ASR / turn detection / barge-in calls the same A6 context
- Latest visual evidence is injected by project evidence reference instead of maintaining a second browser-ASR LLM brain
- Voice, text and button actions become three entry points to one Agent session

## ezPLM host bridge

The project workspace emits browser messages for host integration:

```js
{ source: 'ezplm-labsight', type: 'labsight:ready', agent: 'A6', projectId }

{
  source: 'ezplm-labsight',
  type: 'labsight:host-action',
  action: 'create_issue_draft' | 'create_eco_draft',
  projectId,
  context: { diagnosis, latestPhotoId, latestCaptureId }
}
```

The ezPLM host should respond by opening its native Issue/ECO drawer with a diff preview. The embedded LabSight workspace must never write these objects directly.
