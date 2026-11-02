# Interaction tracking, device emulation and heatmaps

How Lenz records what happened during a test run, and what it can and cannot honestly claim
about it.

Related: [`browser-automation.md`](browser-automation.md) (Playwright engine, capture,
video), [`data-model.md`](data-model.md) (schema), [`../decisions/README.md`](../decisions/README.md)
(ADR-0009, ADR-0010).

---

## 1. What this feature is

A test run now records **where the persona pressed, when, on what, and whether it worked** —
and replays that over the session video, aggregates it into heatmaps, and compares the same
plan across viewport sizes.

```
device profile → emulated browser context → action wrapper + page listeners
   → interaction_events / scroll_samples
   → video markers · click heatmaps · scroll analytics · responsive comparison · PDF report
```

Two sources feed the recorder, and they are kept distinguishable:

| Source | What it knows | Field |
|---|---|---|
| **Action wrapper** (`services/interaction-recorder.ts`) | The step, the intended target, the verified destination | `source = 'lenz-action'` |
| **Page listeners** (`browser/instrumentation.ts`) | What the DOM actually saw, including movement Lenz did not initiate | `source = 'browser-listener'` |

The second exists to *close gaps*, not to duplicate the first. A page-observed pointer event
within **700 ms and 8 CSS px** of a wrapper action is treated as its echo and dropped.

## 2. Device emulation — and what it is not

`packages/shared/src/devices.ts` defines the selectable profiles;
`apps/server/src/browser/devices.ts` **re-resolves every named profile from the installed
Playwright build at runtime** and logs any drift. The static table in `shared` exists only so
the web UI can render a selector without a round trip — it is never trusted as geometry.

Lenz launches **Chromium for every profile**. One engine keeps screenshots, video and
coordinates comparable across devices, which is the entire point of the responsive comparison.
The cost is stated in the data itself:

- `DeviceProfile.descriptorBrowser` records the engine the descriptor was authored for.
- `DeviceProfile.emulationNote` carries the caveat verbatim into the UI and the PDF.

> An iOS profile is **Chromium wearing iOS metrics, not Safari**. Viewport, device pixel ratio,
> touch input and user agent are reproduced. Engine rendering, device performance, network
> conditions, the on-screen keyboard and OS gestures are **not**.

Custom viewports are supported (200–4000 px) and classified by width purely for grouping:
under 600 mobile, under 1100 tablet, otherwise desktop.

**The profile is persisted on the execution row before the run starts**, so the device a report
describes can never disagree with the device that ran. A run recorded before this feature
reads back as `device: null` and is shown as *"device not recorded"* — never assumed to be
desktop, because an assumed viewport silently corrupts every heatmap derived from it.

## 3. The interaction event model

One row per interaction (`interaction_events`). The fields that matter most:

| Field | Why it exists |
|---|---|
| `viewport_x` / `viewport_y` | CSS pixels in the emulated viewport. The only coordinate space everything else derives from. |
| `coordinate_status` | `recorded` or `unavailable`. |
| `coordinate_note` | **Required** whenever the status is `unavailable`. |
| `viewport_width/height`, `device_scale_factor` | Lets a consumer tell whether two events share a layout. |
| `elapsed_ms` | Milliseconds from the execution's monotonic clock origin. |
| `video_offset_ms` | Milliseconds from the **first video frame**. See §5. |
| `result` | `success` / `failure` / `unverified`. |

### Never fabricate a coordinate

A keyboard activation, a `navigateToNode` jump and a scroll gesture genuinely have no click
position. Those record `coordinate_status: 'unavailable'` **with a reason**, the heatmap
excludes them, and the exclusion is reported with its count. A fabricated `0,0` would appear
as a corner hotspot that nobody could explain.

### `result` mapping

`outcomeForVerdict()` in `services/execution.ts`:

| Navigation verdict | Interaction result | Why |
|---|---|---|
| `match` | `success` | Went where intended. |
| `mismatch` | `failure` | The press worked, but not for the persona — they are somewhere they did not want to be. |
| `no-navigation` | `failure` | Nothing happened. |
| `timeout` | `failure` | — |
| `not-applicable` | `unverified` | Dispatched; outcome not checkable. |

The verdict itself is kept on the action row, so nothing is lost by this mapping.

### Privacy

The page listeners **never read `.value`** from any input, textarea or contenteditable, and
blank the accessible name of anything that looks credential-shaped (`password`, `email`, `tel`,
`autocomplete` containing `password` / `cc-` / `one-time`, or `data-sensitive`) to
`[redacted field]`. `redact()` in the recorder is a second net over any label that reaches
storage: it replaces email addresses and runs of six or more digits. **The event model has no
field that could carry a typed value.** Verified — see §8.

### Lenz's own housekeeping is excluded

`dismissBanners()` clicks Figma's cookie banner and hardware-acceleration toast before every
capture. Those are real clicks and the listeners duly reported them — which put
*"Clicked Allow all cookies"* into the heatmap of a live run, at the banner's position,
attributed to the persona. `BrowserSession` now suppresses page-observed interactions while
dismissing banners, plus 400 ms of slack for a binding callback still in flight.

## 4. Scroll tracking

Sampled in the page at **120 ms** (`SCROLL_SAMPLE_MS`) with a guaranteed trailing sample, so the
final resting position is exact rather than wherever the throttle happened to stop. A raw
`scroll` listener fires per animation frame — roughly 60/s per container — which would write
tens of thousands of near-identical rows per run.

- `depth_fraction` measures the **bottom** of the viewport: 100 % means the end of the document
  was on screen. It is `null` when the document height was not measurable, never defaulted.
- `dwell_ms` is back-filled when the *next* sample arrives, since how long a position was held
  is only knowable then.
- Nested containers are tracked separately from `window`, keyed by a short structural path.
- A dynamically changing document height is handled by measuring every sample against the
  **tallest** height seen for that screen, so bands do not move under the data as lazy content
  loads.

On a touch profile, `scrollViewport()` performs a **genuine finger drag** through CDP touch
input rather than a wheel event, and records which mechanism was used. A page that drives its
own momentum, a carousel listening for `touchmove`, or a pull-to-refresh affordance all behave
differently under the two.

### Region exposure is not attention

`exposureMs` is the time a band of the document was **at least partly inside the viewport**.
That is what a scroll position can tell us. It is explicitly **not** a claim that the persona
looked at it — no gaze was measured — and the UI and the PDF both say so next to the number.

## 5. Video marker synchronization

Two independent errors live here. Both were measured, not reasoned about.

### 5a. Clicking a timeline step seeked seconds past the click

`ExecutionAction.offsetMs` is stamped when the step **finishes** — after the click, the
navigation, the ~2.5 s settle wait and the screenshot. Measured on live runs:

| Run | Device | Mean gap between the click and the action's own offset |
|---|---|---|
| `exe_wXV5pFkMmE_Q` | desktop 1440×900 | **1.9 s** |
| `exe_FF81fDUGVaZ9` | mobile 393×659 | **5.5 s** |

Seeking to `offsetMs` therefore landed the player *after the navigation the click caused*, on
the following screen — which reads as "the markers do not match the video". The marker itself
was in the right place all along; only the seek was wrong.

`seekOffsetForAction()` (`services/interaction-recorder.ts`) returns the **first interaction
recorded against the step**, falling back to the action offset for a step that recorded nothing
(a pure wait, or a capture that failed before anything happened). The timeline endpoint exposes
it as `seekOffsetMs`.

### 5b. Interactions were timestamped after the navigation they caused

`clickAndVerify()` dispatches the press and then **polls for the resulting navigation**, for
anywhere between one 250 ms poll and four seconds. The interaction used to be timestamped when
that call returned, so every click was recorded ~1.2 s after it happened — by which time the
prototype had already moved to the next screen.

Measured end to end with `tools/probe/verify-marker-alignment.mts`, which seeks the video to
each marker and fingerprints the frame against the run's own screenshots:

| Marker placed at | Frames showing the screen the click was performed on |
|---|---|
| The action's offset (original behaviour) | **0 / 4** |
| The time `recordPointer` was called (after polling) | **1 / 4** |
| `clickAndVerify`'s `dispatchedAt` (current) | **4 / 4** |

So `InteractionResult` now carries `dispatchedAt`, stamped either side of the dispatch itself,
and `RecordPointerInput.occurredAtMs` overrides the recorder's own clock reading. The same
applies to `scrollViewport`, which waits for momentum to settle before returning.

**The rule this gives the codebase:** anything that waits for a result before recording must
pass the time it *began*. The recorder's clock is only correct when the call site is the moment.

### 5c. The recording starts after the run does

> Playwright starts recording when the **page** is created. The execution clock starts when the
> run opens, which is strictly earlier. Without accounting for the gap, every marker and every
> timeline seek is early by the browser's start-up time.

`BrowserSession.videoStartedAt` captures the wall-clock moment the page exists;
`videos.start_offset_ms` persists the difference. The player resolves a marker's time in this
order (`apps/web/src/lib/overlay.ts`):

1. `videoOffsetMs` — measured against the first frame. Exact.
2. `elapsedMs - videoStartOffsetMs` — reconstructed.
3. `elapsedMs` — last resort, and the UI labels the timing **"approximate"**.

Old recordings have no offset and take path 3; they still play, with the badge.

### 5d. Do NOT rescale by the video's reported duration

Playwright's webm reports a duration that **disagrees with the wall time it covers** — measured
at +4.6 % on a controlled 30 s recording, and between −0.3 % and +2.7 % on real runs. The
obvious correction is to rescale marker times by `duration / wallSpan`. **That is wrong, and
measurement proved it.**

`tools/probe/verify-video-sync.mts` records a page whose background is a known colour at every
known instant, then seeks the resulting video and reads the pixel back, so the true mapping from
video position to real instant is measured rather than assumed. Result over seven sample
points on a 30 s recording:

| Mapping | Mean absolute error |
|---|---|
| Direct (`videoTime = wallOffset`) | **186 ms** — every sample inside the correct 500 ms frame window |
| Rescaled by `duration / wallSpan` | 574 ms — three times worse |

The container's *declared duration* is inflated, but its *frame timestamps are real-time*. So
the mapping is a plain subtraction and nothing is scaled. The 186 ms residual is at the
resolution of the measurement itself (500 ms per colour step), so the true error is smaller.

### Overlay geometry

Markers are DOM elements over the `<video>`, driven by `currentTime` **on every animation
frame**. Reading the clock each frame is what makes pause, seek, playback-rate changes and
replay need no special handling — whatever the video says the time is, that is what is drawn.

Position is computed through a **fraction of the recorded viewport**, not a pixel mapping:

```
fx = viewportX / viewportWidth          // 0..1, independent of DPR and video size
left = box.offsetX + fx * box.renderedWidth
```

`computeVideoBox()` accounts for letterboxing: a `<video>` centres its picture with
`object-fit: contain`, so bars appear on two sides whenever the aspect ratios differ — which
they do the moment the layout is responsive. Positioning against the *element* rather than the
*picture* puts every marker off by the bar width, and the error changes as the window resizes.

The recording itself is **never modified**. No text is drawn over the video; the action label
lives in the timeline beside the player, where it does not cover the interface being watched.

## 6. Heatmaps

`services/heatmap.ts` is pure functions over recorded rows. **No model is involved at any
point**, nothing is interpolated beyond the radial falloff the renderer draws, and nothing is
smoothed into existence.

### Grouping is a correctness requirement, not a convenience

The key is `screenId | deviceId | viewportWidth x viewportHeight`. A 390-wide layout and a
1440-wide layout place the same control in different places, so merging their coordinates would
produce a map that describes neither. The grouping is structural and the UI cannot opt out.

### Screenshot compatibility

`Screenshot.width/height` are the **CSS viewport** of the capture, not the PNG's pixel
dimensions (the PNG is `width × deviceScaleFactor` across). A background is marked
`screenshotCompatible` only when its CSS geometry matches the recorded viewport exactly.
Otherwise the group keeps its points, sets the flag false, and explains why — a heatmap floating
over the wrong screenshot is worse than one with no screenshot.

### Rendering

- **UI**: 2D canvas, two passes — accumulate greyscale radial falloff, then map accumulated
  alpha onto a colour ramp. One pass with coloured gradients would make overlapping points
  *brighten* rather than climb the ramp, so a cluster would look like a single strong press.
- **PDF**: SVG radial gradients plus per-point dots (green worked / red did not / grey
  unverified). SVG survives PDF rendering without depending on a filter implementation.

### The data is synthetic

Every heatmap carries `SYNTHETIC_DATA_NOTE` verbatim:

> These positions come from interactions Lenz performed while executing test plans. They are
> synthetic test traffic, not observations of real users.

## 7. Responsive comparison

`services/responsive.ts`. The governing rule, enforced in code rather than left to prose:

> **A responsive layout that differs is not a defect.**

| Severity | Meaning |
|---|---|
| `info` | A measured difference, presented without judgement. Navigation path, action count, scroll depth. |
| `concern` | A measurement crossing a **published** guideline, reported with the number and the guideline named. Touch targets, control availability. |
| `failure` | The test completed on one device and not another. The only category Lenz calls a problem outright, because it is a recorded fact. |

Touch-target concerns use **44 px** (Apple HIG; Material uses 48 dp), are only reported for a
profile with touch, and include the measured size so a reader can judge it.

Figma target sizes are scaled from canvas pixels into viewport pixels by the same transform that
placed the click. This matters: the viewer fits a frame to the viewport **width**, so a
1440-wide frame opened at 390 renders every control at 0.27×. Recording the canvas size would
describe a control that is not what the persona was asked to hit.

## 8. Figma prototype limitations

These are properties of the surface, not of the tracking:

| Limitation | Consequence |
|---|---|
| The prototype renders to a **canvas** | DOM listeners fire on the canvas element. Coordinates are correct; element names and sizes come from Figma metadata via the wrapper, not the DOM. |
| No measurable element boxes | Touch-target concerns simply do not appear for canvas-rendered controls. **That absence is a limitation of the surface, not evidence of compliance.** |
| Figma Make runs in a **cross-origin iframe** | `addInitScript` and `exposeBinding` reach all frames, so instrumentation works — but a frame Lenz cannot address is reported as unverified rather than assumed. |
| No real text inputs | `type` steps are recorded as *not executed* with that reason. |
| The viewer scrolls its own canvas | Document height is often not measurable, so `depth_fraction` is `null` and the UI says "not measurable" rather than 0 %. |

When instrumentation cannot be installed at all, the run still produces wrapper-recorded
interactions and the execution's notes say so — a thinner dataset is never presented as complete.

## 9. Reports

`services/report.ts` builds self-contained HTML and prints it with the Chromium that Playwright
already ships (no PDF dependency). The renderer **aborts all network access**: the document is
entirely self-contained, so it cannot be made to fetch anything.

Sections are numbered and the contents page is generated from the same list, so they cannot
drift. Order is front-loaded: the answer to *"what should we fix?"* is in section 1.

1. Executive summary — counts, severity and evidence donuts, **Fix these first**, task completion
2. How to read this report — severity and evidence strength explained
3. What was tested — sessions, personas, devices
4. Findings — by severity, each with impact, recommendation and screenshot
5. Interaction evidence — heatmaps and scroll depth
6. Across devices *(only when more than one device ran)*
7. Coverage — with the miss list
8. Limitations

Screenshots are embedded as base64 within a **24 MB** budget; anything dropped is counted and
printed. Charts are inline SVG and plain divs with no scripting — a PDF renderer lays the page
out once and prints it, so anything needing a second animation frame is a liability.

## 10. Verified behaviour

`npx tsx tools/probe/verify-interactions.mts [outDir]` — real Chromium, no credentials, no
network (fixtures over `file://`). **10/10 passing**, last run 2026-11-02:

| Check | Measured |
|---|---|
| Desktop click recorded with accessible name | "Add to Cart" at 84,162 in 1440×900, target 129×50 px |
| Wheel scrolling sampled and throttled | 6 samples, scrollY 1972 of a 2872 px document |
| Nested container tracked separately | `#list` at scrollTop 120 of 360 px |
| Touch tap recorded as a tap, no duplicate click | 390×844, DPR 3, `pointer=touch` |
| Finger drag classified as a swipe | dy = 321 px over 378 ms, plus 3 scroll samples |
| Password value never leaks | name recorded as `[redacted field]`, no value anywhere in the payload |
| Undersized control measured | 24×18 px, below the 44 px guideline |
| Mobile recording produced | frame size 390×844 CSS px, matching recorded coordinates |
| PDF renders from aggregated data | 104 kB, 9 pages |
| Caveats present even in an empty report | no-score, synthetic-data and both emulation notes |

`npx tsx tools/probe/verify-migration.mts <db-copy>` — against a copy of the real database:
33 projects, 11 executions, **11 playable recordings, 230 screenshots, 0 missing evidence
files**, all pre-existing executions reading back as *"device not recorded"*.

End to end in the running application (2026-11-02): desktop and mobile runs of the same plan
recorded 32 interactions across 8 heatmap groups; the project PDF rendered at 1.4 MB / 27 pages;
the UX Analysis page showed live progress 40 % → 100 % with no console errors.

## 11. Known limitations

- **Scroll depth inside the Figma viewer is usually unknown.** The viewer manages its own
  canvas, so document height is frequently not measurable. Reported as `null`.
- **Page events are timed by the page's wall clock.** Server-side elapsed time uses a monotonic
  source; page events carry `Date.now()` and are placed on the timeline by subtracting the
  wall-clock origin. A system clock stepped mid-run would skew them — rare and bounded, and
  preferable to timing them by when the binding callback was serviced.
- **Per-run caps**: 5000 interaction events and 4000 scroll samples. Beyond them the recorded
  set is a *prefix* of the run, which the execution's notes state explicitly.
- **No annotated video export.** Markers are a non-destructive player overlay. Burning them in
  would need a re-encode and was not required.
- **Appium and native automation are out of scope.** Browser surfaces only.
- **One Chromium for all profiles.** An iOS profile does not exercise WebKit.
