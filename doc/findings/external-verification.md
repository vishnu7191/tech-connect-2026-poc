# External Dependency Verification Report

**Date:** 2026-10-31
**Status:** All four target scenarios empirically verified BEFORE the architecture was fixed.

This document records *measured* facts about external systems, obtained by probing live
endpoints (`tools/probe/`). Everything here was observed, not assumed. The architecture in
`doc/architecture/` is a direct consequence of these findings.

---

## 1. Figma REST API

| Check | Result |
|---|---|
| `GET /v1/me` | **200** — token valid, user `vishnu` |
| `GET /v1/files/TJEIgarZebWrehJFEFycYw` | **200**, `role: "viewer"`, `linkAccess: "view"` |
| Full file payload | **8.67 MB**, fetched in ~5.7 s |
| `depth=1` / `depth=2` support | Works; useful for cheap structural probes |

**Conclusion:** REST discovery is available for the Rosella file. A viewer-role token is
sufficient to read document structure and prototype interactions.

> A public prototype URL does **not** guarantee REST access in general. The engine must
> degrade to browser-only discovery when the API returns 403/404. See
> `doc/architecture/figma-discovery.md`.

## 2. Rosella file structure (`TJEIgarZebWrehJFEFycYw`)

Two canvases:

| Canvas | id | `prototypeStartNodeID` | `flowStartingPoints` | top-level children |
|---|---|---|---|---|
| Mockup | `0:1` | `1:2` | **5 flows** | 102 |
| Wireframe | `463:985` | `null` | **none** | 14 |

Declared flows on *Mockup*:

| Flow | Node | Screen |
|---|---|---|
| Flow 1 | `1:2` | Home |
| Flow 2 | `80:18` | Details |
| Flow 3 | `238:293` | Login |
| Flow 4 | `250:378` | policy |
| Flow 5 | `398:652` | Home_Phone |

**Two findings that shape the design:**

1. **Not every top-level child is a screen.** Of 102 children on *Mockup*, a large share are
   `COMPONENT_SET` nodes (`Heart`, `XS`, `Add to bag`, `ei:arrow-left`, ...) — design-system
   parts, not screens. Naive "every top-level frame is a screen" logic would inflate the
   screen count roughly 2x and poison every downstream coverage metric.
2. **The Wireframe canvas has no declared entry point at all.** It is the live, in-file
   instance of Scenario B. Its 14 frames must still be discovered, classified as
   disconnected, and offered as candidate entry points — never silently dropped.

## 3. Prototype interactions — the decisive finding

Walking every node of the full file yields **1250 interaction actions** (all of
`action.type === "NODE"`; zero `URL` actions in this file).

Triggers:

| Trigger | Count |
|---|---|
| `ON_CLICK` | 1013 |
| `ON_HOVER` | 201 |
| `AFTER_TIMEOUT` | 18 |
| `DRAG` | 17 |
| `ON_PRESS` | 1 |

Navigation modes — **this is the important table**:

| `navigation` | Count | Meaning |
|---|---|---|
| `CHANGE_TO` | **740** | Component **variant swap** — in-screen UI state change |
| `NAVIGATE` | **435** | Real screen-to-screen transition |
| `OVERLAY` | 41 | Overlay opened on top of current screen |
| `SWAP` | 8 | Overlay swapped |
| `SCROLL_TO` | 6 | Scroll within the current screen |

**Conclusion — the single most consequential design decision in Lenz:**
A flat "interaction = navigation edge" model is **wrong for 59% of this file's interactions**.
Treating all 1250 as screen edges would produce a meaningless hairball graph and a wildly
overstated screen count.

The graph engine therefore uses a **typed edge model**: only `NAVIGATE` produces a
screen-level edge. `CHANGE_TO` / `SCROLL_TO` produce **intra-screen UI-state** edges, and
`OVERLAY` / `SWAP` produce **overlay-state** edges. This is what section 6 of the brief
("a simple frame graph cannot represent component states, overlays, variables...") demands,
and the data proves it is not a theoretical concern.

## 4. NVIDIA NIM provider

Endpoint `https://integrate.api.nvidia.com/v1`, **85 models** listed. The model named in the
brief, `nvidia/nemotron-3.5-super-vl-120b-a12b`, **exists and is reachable**.

| Capability | Result |
|---|---|
| Vision (`image_url`, base64 data URI) | PASS — correctly described a generated test image |
| `response_format: json_schema` | PASS — returned schema-valid JSON |
| `response_format: json_object` | PASS |
| Latency (small prompts) | ~0.8 s - 2.8 s |

**It is a reasoning model.** Responses carry `message.reasoning_content` alongside
`message.content`, and `usage.completion_tokens_details.reasoning_tokens` is reported
separately.

> **Operational consequence:** with `max_tokens: 300`, a vision call returned
> `content: null` and `finish_reason: "length"` — the reasoning trace consumed the entire
> budget. The adapter must budget generously for reasoning, surface `reasoning_content`
> separately from the answer, and treat `finish_reason === "length"` with empty content as a
> retryable truncation rather than a model failure.

### TLS note (environment-specific)

`curl` on this Windows host fails against `integrate.api.nvidia.com` with
`CRYPT_E_NO_REVOCATION_CHECK` (schannel revocation check through the corporate network).
**Node's `fetch` succeeds**, using its own CA bundle. Since the application runs on Node,
this is not a product defect — but it means `curl`-based smoke tests are unreliable here and
diagnostics must be run through Node.

## 5. Playwright against the Figma prototype

| Check | Result |
|---|---|
| Headless Chromium loads the proto | PASS — no authentication required |
| Design actually renders | PASS — Home screen rendered pixel-accurate |
| Cookie / hardware-acceleration banners | Present — must be dismissed before capture |
| Direct `?node-id=` URL navigation | PASS — jumps straight to any frame |
| Click-driven navigation | PASS |
| **URL reflects the reached screen** | PASS — **this is the key unlock** |

Observed: loading `?node-id=1-2` (Home) and clicking the "Explore Now" button changed the URL
to `?node-id=145-61`, which is the **Dresses** frame — exactly the destination Figma metadata
predicted for that interaction.

**Conclusion:** Lenz gets *ground-truth destination verification*. For any interaction we can
compare the **expected** `destinationId` (from REST metadata) against the **actual** node id
in the URL after the click. This turns "we clicked something" into a verifiable assertion and
is the backbone of the coverage model.

Direct `node-id` navigation additionally lets the capture pass reach every frame
deterministically, without replaying long click chains — including frames that are
unreachable by interaction.

## 6. Figma Make (Scenario C)

URL: `.../make/p1kRdgwLVWLh06BbR8fpIB/Lenz-UX-Validation-Engine?fullscreen=1&...`

- Page loads; title `Lenz UX Validation Engine - Figma Make`.
- The top-level page is Figma's own chrome (sign-in buttons, cookie banner, warning bar).
- **The actual application runs in a nested iframe** served from
  `https://<uuid>-figmacachedpreview.figma.site/`.
- The app inside that iframe is **real DOM** (not a canvas), so standard DOM-based element
  discovery, text extraction and clicking all work.

**Conclusion:** Make discovery must target the preview iframe, not the top-level page.
Screenshots of the top-level page include Figma chrome and would corrupt UX analysis.
Because the preview origin is addressable, the engine resolves and drives that frame directly.
Since there are no Figma prototype node ids here, Make uses **browser-discovered UI state**
identity (route + DOM-signature hash) instead — handled by the same state-graph abstraction.

---

## What this report licenses us to claim

Verified working: Figma REST discovery, interaction extraction, NIM text + vision + structured
output, headless prototype rendering, URL-verified navigation, Make iframe discovery.

Nothing in this document asserts that a full end-to-end Lenz run has executed. See
`doc/development/status.md` for the honest, current implementation state.
