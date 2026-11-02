# Implementation Status

**Last updated:** 2026-10-31

This is the honest record of what exists, what has been *verified by running it*, and what
remains. Nothing here is marked working on the strength of code existing alone.

Legend: **Verified** = executed against live systems and the result inspected ·
**Built** = implemented and type-checked, not yet exercised end to end · **Not started**.

---

## Milestone status

| # | Milestone | Status |
|---|---|---|
| 1 | Foundation (monorepo, DB, config, AI abstraction, projects) | **Verified** |
| 2 | Figma discovery (URL classification, REST, graph, entry points) | **Verified** |
| 3 | Browser verification (Playwright, capture, validation) | **Verified** |
| 4 | Personas and test plans | **Verified** |
| 5 | Autonomous execution | **Verified** |
| 6 | Recap Test (full video recording) | **Verified** |
| 7 | UX analysis (vision findings) | **Verified** |
| 8 | Model Lab (switching, comparison, history) | **Built**; task routing and provider views verified, multi-model comparison not run (see gaps) |
| 9 | End-to-end integration | **Verified** for Scenarios A, B and C |

## What was actually executed

A full workflow was run against the live Rosella prototype and the live Figma Make app.

### Scenario A and B — Rosella prototype (`TJEIgarZebWrehJFEFycYw`)

```
screens discovered     53          components excluded    63
ambiguous               5          reachable              31
disconnected           15          flows                  16
interaction actions  1250          screen edges          416
ui-state edges        746          overlay edges          49
unsupported            21
entry points            5 confirmed / 22 inferred
```

Coverage as reported by the product (each dimension independent, with miss-lists):

| Dimension | Value | Note |
|---|---|---|
| designDiscovery | 48/53 (90.6%) | 5 ambiguous; 63 components excluded by design |
| reachability | 31/53 (58.5%) | 22 misses, each with a reason |
| interactionDiscovery | 1190/1250 (95.2%) | 21 unsupported triggers |
| screenshotCapture | 5/5 | with the note "47 screen(s) were not attempted in this run" |

Both URL forms were exercised. With no `node-id`, discovery still succeeded and produced 5
confirmed entry points plus 22 ranked candidates, and the Wireframe canvas (which declares no
starting point at all) was reported as a warning rather than silently dropped.

### Execution, video and analysis — verified

A generated plan for persona *Maya Tran* ("find a linen dress and add it to the cart") was
approved and executed. The approval gate was confirmed to block execution before approval
(`PLAN_NOT_APPROVED`).

Result: 6 actions, 3 navigations, **a 9.8 MB / 59 s Playwright video**, and this timeline:

| # | Action | Verdict | Decided by |
|---|---|---|---|
| 0 | Open "Home" | match (`1:2`) | system |
| 1 | Tap Dresses category | **match** (`145:61`) | figma-metadata |
| 2 | Scan titles and prices | n/a | plan-step |
| 3 | Click "Add to cart" | reached `80:18` (Details) | figma-metadata |
| 4 | Open Shopping Bag | **no-navigation** (failed) | figma-metadata |
| 5 | Verify cart badge | n/a | plan-step |

Vision analysis over the captured screenshots produced 5 findings, all evidence-linked,
including two the model could only have reached by genuinely reading the images:

- Prices are shown in **Rs** while the persona's goal was "under £80" — makes the budget
  comparison impossible.
- The chosen product's Details screen reads **"Fabric: Recycled polyester"**, contradicting
  the "linen dress" requirement.
- Plus a deterministic, non-model finding generated directly from the execution fact that the
  Shopping Bag click produced no navigation.

### Scenario C — Figma Make — verified

11 distinct UI states discovered by DOM-signature hashing, 40 interactive elements, 10 state
transitions, 11 valid screenshots. Exploration clicked through Personas, Test plan, Live run,
Session replay, Heatmaps, Accessibility, Findings, Design fixes and Report.

### AI provider layer — verified live (11/11 checks)

`npm run verify:live` passes: config loads and resolves `${ENV_VAR}`, the public view contains
no credentials, every task resolves to a model, text completion works, structured output
validates against a Zod schema, vision works, the capability guard blocks vision on a
text-only model *before* any network call, and reasoning-model truncation is retried and
recovered.

## Defects found and fixed during integration

These were all found by running the system, not by reading it:

| Defect | Resolution |
|---|---|
| Cookie banner appeared in every screenshot after the first navigation | Banner dismissal was latched by a one-shot flag; now runs before every capture, using a fast `count()` check |
| `scaling=contain` shrank a 1440x5446 page to an unreadable thumbnail | Dropped the parameter; the viewer's default fits to width, restoring full-size captures (462 KB vs 132 KB) |
| Blankness threshold rejected genuinely sparse screens | Re-calibrated against a measured solid-fill floor (0.00458 bpp) and split into `blank` vs `sparse`, so thin evidence is flagged rather than failed |
| Figma 429 rate limit from repeated 8.67 MB fetches | Added a 6-hour on-disk document cache |
| Test-plan generation failed with `finish_reason: length` | The brief's example `maxOutputTokens: 4096` was too small for a reasoning model; verified the endpoint accepts up to 131072 and raised it. The adapter now also reports clearly when the budget is already at the model ceiling |
| `llama-3.1-nemotron-70b-instruct` returns 404 for this account although `/v1/models` lists it | Disabled in config with the reason recorded, rather than offered as a broken option |
| Figma Make app stuck on its loading screen | The SSRF allow-list blocked `cdnjs.cloudflare.com`. Split into document navigation (Figma only) vs subresources (plus a CDN allow-list) |
| Make discovery returned 0 states **with no warning** | Two causes: an esbuild `__name` helper crashed the `page.evaluate` body (named inner functions are not safe there under tsx), and the error was swallowed by a bare `catch`. Both fixed, plus an explicit warning when a run yields nothing |
| Navigation graph was an unreadable squashed blob | Replaced canvas-coordinate layout with a layered layout by navigation depth |
| Known vulnerabilities in `fastify`, `@fastify/static`, `playwright`, `zod`, `react-router` | Upgraded; remaining advisories are moderate and transitive through Playwright's dev tooling only |
| **`Cannot read properties of null (reading 'type')` on a user-supplied prototype** | Figma returned `{"trigger":{"type":"ON_CLICK"},"actions":[null]}` — 9 of 76 actions were null. Now counted as *dead interactions*, reported as a warning and a coverage miss. See [failure-modes.md](../architecture/failure-modes.md) |
| Raw `TypeError` text shown to the end user | `toUserFacingError()` normalizes any non-`AppError` into a job-specific explanation; stacks go to the log only |
| `interactionDiscovery` showed 88.2% with an **empty** miss-list | Dead interactions now appear as misses with reason `no-destination-configured`, so the shortfall is explained |
| Only 4 Figma link types recognised | All of `/proto/`, `/design/`, `/file/`, `/make/`, `/board/`, `/slides/`, `/deck/` classified with a support level; community links, the Figma home page, embed wrappers, scheme-less and name-less links all handled with actionable messages |
| A private prototype would have been screenshotted as a real screen | `detectViewerBlock()` detects sign-in walls, permission errors and deleted files — and only fires when the prototype canvas is absent, so login-screen *designs* are not false positives |

## Tests

122 unit tests pass via **npm test**. Density is highest exactly where untrusted data enters
the system:

| Suite | Tests | Covers |
|---|---|---|
| url.test.ts | 51 | Every Figma link type, real-world link shapes, malformed input, SSRF |
| analyze.test.ts | 29 | Typed-edge graph, reachability, pathfinding, flows, entry-point ranking |
| validate.test.ts | 12 | Malformed and partially-damaged Figma documents |
| classify.test.ts | 11 | Screen classification, pinned against **real captured Rosella nodes** |
| capture.test.ts | 11 | Blankness calibration from measured values, coordinate mapping |
| extract.test.ts | 8 | The real null-action payload shape and null-tolerance |

Live integration checks live in tools/probe/ and **npm run verify:live**, deliberately
separate so the unit suite stays fast, offline and deterministic.

## Known gaps and limitations

**Not yet exercised end to end**

- **Model Lab comparison across two models.** The API, job and UI exist and task reassignment
  works, but a real side-by-side run was not executed: only one vision-capable model is
  reachable on this account (`llama-3.1-nemotron-70b-instruct` 404s, and
  `nemotron-3.5-lightning` is flagged text-only pending verification). A comparison needs two
  usable models.
- **Pause / resume / stop controls.** Implemented and wired to the UI, but not exercised
  mid-run; executions so far completed faster than a manual interrupt.
- **Scenario D** (`/design/` URLs) is implemented as structural discovery only and was not run
  against a real design file.

**By design**

- Figma **variables and conditional logic** are detected and reported as unsupported, not
  simulated. `AFTER_TIMEOUT` and `DRAG` triggers are discovered but not executed.
- Text entry inside a Figma prototype viewer is recorded as `skipped` — the viewer has no real
  inputs.
- No overall "UX score" is published. The report states this explicitly and gives severity
  counts, evidence quality and coverage instead.
- Single-process job worker; no authentication, multi-tenancy, or distributed execution.

**Operational notes**

- **Figma file-read quota is currently exhausted for the supplied token.** Repeatedly fetching
  the 8.67 MB Rosella document during development triggered a long rate limit: `/v1/me` still
  returns 200, but file endpoints return 429 with `retry-after` ≈ 393,000 s (~109 h, resetting
  2026-11-05). This is external quota state, not a defect. Two things follow:
  - `npm run verify:live` currently reports **10 passed, 1 failed**, the failure being the
    uncached shallow-metadata probe. Full discovery still passes because it is served from the
    on-disk document cache — which is precisely why that cache exists.
  - The client now detects a long `retry-after`, stops retrying immediately rather than
    backing off pointlessly, and reports when access returns.
- `curl` cannot reach `integrate.api.nvidia.com` on this Windows host
  (`CRYPT_E_NO_REVOCATION_CHECK`); Node's `fetch` works. Diagnose through Node.
- Do not declare named functions inside a `page.evaluate` body: esbuild (via `tsx`) rewrites
  them with a `__name` helper that does not exist in the browser context.

## Next steps

1. Verify `nemotron-3.5-lightning` capabilities and run a real two-model comparison.
2. Exercise pause/resume/stop against a longer execution.
3. Broaden capture beyond the current per-run cap so screenshot coverage can approach the full
   screen inventory.
4. Add API-level route tests using Fastify `inject()` with an in-memory database.
5. Run Scenario D against a real `/design/` file.

---

# Addendum — 2026-11-02: device testing, interaction tracking, heatmaps, reports

Architecture: [`../architecture/interaction-tracking.md`](../architecture/interaction-tracking.md).
Decisions: ADR-0009, ADR-0010, ADR-0011.

## Status of this work

| Capability | Status |
|---|---|
| Device profiles (desktop / tablet / mobile + custom viewport) | **Verified** — catalogue reconciled against installed Playwright, served at `GET /api/v1/devices` |
| Interaction recording (clicks, taps, swipes, scroll, navigation) | **Verified** — real Chromium, 10/10 probe checks |
| Page-side instrumentation (init script + binding) | **Verified** — installs and reports in both desktop and mobile contexts |
| Touch emulation (tap, CDP finger-drag scrolling) | **Verified** — tap recorded as `tap`/`pointer=touch`; drag recorded as a swipe of 321 px |
| Scroll sampling, depth, nested containers, region exposure | **Verified** — including `null` depth when document height is unmeasurable |
| Video click/tap markers, ripple, timeline sync, resize/letterbox | **Verified** — 18 unit tests on the geometry and timing; real recording produced at the emulated viewport size |
| Click/tap heatmaps (canvas in UI, SVG in PDF) | **Verified** — 8 groups from two real device runs of the same plan |
| Scroll analytics | **Verified** (empty-data path verified; non-null depth on Figma prototypes is often unavailable — see limitations) |
| Responsive comparison | **Verified** — 3 runs, 5 differences, correct severity classification |
| PDF report | **Verified** — 27 pages / 1.4 MB from the live project, with embedded screenshot evidence |
| Schema migration on an existing database | **Verified** — against a copy of the real `lenz.db` |
| Backward compatibility for old recordings | **Verified** — 11 pre-existing recordings still playable, 0 evidence files lost |

## What was executed

**Unit tests:** `npm test` → **235 passed** (was 122). New: `heatmap.test.ts` (29),
`interaction-recorder.test.ts` (28), `devices.test.ts` (21), `responsive.test.ts` (17),
`overlay.test.ts` (18, frontend geometry/timing).

**Real browser:** `npx tsx tools/probe/verify-interactions.mts` → **10 passed, 0 failed**.
Measurements are tabulated in §10 of the architecture doc.

**Real database:** `npx tsx tools/probe/verify-migration.mts <copy>` → 33 projects,
11 executions, 11 playable recordings, 230 screenshots, **0 missing evidence files**. All
pre-existing executions read back as *"device not recorded"* rather than assuming a viewport.

**Live application** (project `prj_yT3VhIk4JAl8`, 2026-11-02): desktop and mobile runs of the
same plan recorded **32 interactions across 8 heatmap groups**; `GET /projects/:id/responsive`
returned 3 runs and 5 differences; `GET /projects/:id/report.pdf` returned 27 pages / 1.4 MB in
1.7 s; the UX Analysis page showed live progress 40 % → 100 % with no console errors.

A genuine responsive finding fell out of it: the same plan completed **8 of 8 steps on desktop
and 1 of 8 on mobile**.

## Defects found and fixed during this work

1. **Video markers were systematically early.** Playwright starts recording when the page is
   created; the execution clock starts when the run opens. Without the gap, every marker and
   every timeline seek ran early by the browser's start-up time. Fixed with
   `videos.start_offset_ms`; recordings without it are labelled *"timing approximate"*.
2. **A swipe that the browser converted into scrolling was under-reported.** Once Chromium takes
   a drag over for scrolling it fires `touchcancel` carrying a stale position, so a 400 px flick
   was recorded as a ~39 px nudge. Found by the probe. Fixed by tracking maximum displacement
   across `touchmove` and binding `touchcancel` as well as `touchend`. Re-measured at 321 px.
3. **Lenz's own cookie-banner clicks polluted the UX heatmap.** A live run contained
   *"Clicked Allow all cookies"* at the banner's position, attributed to the persona. Fixed by
   suppressing page-observed interactions while `dismissBanners()` runs, plus 400 ms of slack.
4. **"Analyze UX" produced no visible feedback.** The job was fired and the findings query
   invalidated on a timer, with no subscription — a run still thinking looked identical to one
   that had failed. Now the action navigates to the UX Analysis page with the job id in the URL
   and that page streams the job's progress.
5. **The progress panel then froze at "Starting… 0 %".** React StrictMode runs every effect,
   cleans it up and runs it again on mount; `useJob` unsubscribes in its cleanup, so a ref guard
   let the second mount skip re-subscribing while the job ran to completion behind it. Fixed by
   depending only on the job id and the stable `watch` callback. Verified by driving the real UI.

## Known limitations of this work

- **Scroll depth inside the Figma viewer is usually unknown**: the viewer manages its own canvas,
  so document height is frequently not measurable. Reported as `null` / "not measurable".
- **Touch-target measurement needs a DOM box.** Canvas-rendered prototype controls have none, so
  they do not appear in the concern list. That absence is a property of the surface, not
  evidence of compliance — stated in the report.
- **Page events are timed by the page's wall clock**, so a system clock stepped mid-run would
  skew them. Server-side elapsed time uses a monotonic source.
- **Per-run caps**: 5000 interaction events, 4000 scroll samples. Beyond them the recorded set is
  a prefix of the run, which the execution notes state.
- **No annotated video export** — markers are a non-destructive player overlay.
- **One Chromium for every profile** (ADR-0011), so an iOS profile does not exercise WebKit.
- **Appium / native automation remain out of scope.**
- One historical execution is stored against the now-removed `mobile-iphone-15` profile. Its
  geometry is persisted on the row, so it still reads and renders correctly; the preset is simply
  no longer offered for new runs.

---

# Addendum — 2026-11-02 (later): sync fix, UI simplification, fresh start

## Defects found and fixed (continued from the previous addendum)

6. **Clicking a timeline step seeked seconds past the click.** `ExecutionAction.offsetMs` is
   stamped when the step *finishes* — after the click, the navigation, the settle wait and the
   screenshot. Measured on the live runs: the gap was **1.9 s on desktop and 5.5 s on mobile**,
   so the player landed on the screen *after* the one the step describes. The markers were
   correct; only the seek was wrong. Fixed by `seekOffsetForAction()`, which seeks to the first
   interaction recorded against the step. Five regression tests use the measured values.

7. **A tempting "fix" that measurement rejected.** Playwright's webm reports a duration 4.6 %
   longer than the wall time it covers, which looks like clock drift and invites rescaling
   marker times by `duration / wallSpan`. A ground-truth experiment
   (`tools/probe/verify-video-sync.mts`) showed rescaling is **three times worse** (574 ms mean
   error vs 186 ms for the direct mapping): the declared duration is inflated but the frame
   timestamps are real-time. No rescaling was added. Recorded here because the next person to
   notice the duration mismatch will be tempted by the same idea.

## UI changes requested

- **Device selection removed from the UI.** Runs use the server's default desktop profile. The
  profile is still resolved, persisted per execution and used by the heatmap grouping, so
  re-enabling the selector is a UI change only.
- **"Devices & Interactions" renamed to "Heat Map"** (`/projects/:id/heatmap`; the old
  `/responsive` path still resolves so existing links do not break). The device filter and the
  responsive-comparison panel were removed from it. `services/responsive.ts` and its 17 tests
  remain — the PDF still renders a cross-device section if more than one device ever runs.
- **Project navigation now persists on `/executions/:id`.** The sidebar previously emptied out
  when a recap was opened, leaving no way back into the project. It resolves the project from
  the execution and shows the project's name as the section heading.

## Data reset

At the user's request all projects were deleted so they could start fresh.

- Backup first: `npx tsx tools/probe/backup-data.mts before-wipe` →
  `backups/2026-11-02T15-51-01-before-wipe/` containing **35 projects, 13 executions,
  264 screenshots, 13 videos, 29 findings, 32 interaction events**, 88.1 MB of evidence and
  14.3 MB of Figma cache. The database is captured with SQLite `VACUUM INTO`, so it includes
  everything that was in the write-ahead log. Restore instructions are in the backup's
  `README.txt`. `backups/` was added to `.gitignore`.
- Deletion went through `DELETE /api/v1/projects/:id` so evidence directories were removed with
  the rows: **35 deleted, 0 failed, 0 remaining**, every table empty, `data/evidence` empty,
  0 orphaned files.

## Current verification state

`npm test` → **240 passed**. `npm run build` → clean. `tools/probe/verify-interactions.mts` →
10/10. `tools/probe/verify-video-sync.mts` → direct mapping confirmed correct.

**Not re-verified end to end:** the timeline-seek fix is covered by unit tests built from the
measured gaps, but no execution exists to replay it against — the database was intentionally
emptied. The first new run will exercise it.

---

# Addendum — 2026-11-02 (third): marker alignment measured end to end

## The real cause of "the markers don't match the video"

Two earlier attempts treated symptoms. The actual defect was that **an interaction was
timestamped after the navigation it caused**: `clickAndVerify()` dispatches the press and then
polls for the resulting navigation (one 250 ms poll up to four seconds), and the event was
stamped when that call *returned* — about 1.2 s late, by which point the prototype had already
moved on.

Measured end to end on a real run with `tools/probe/verify-marker-alignment.mts`, which seeks
the video to each marker and fingerprints the frame against the run's own screenshots:

| Marker placed at | Frames showing the screen the click was performed on |
|---|---|
| The action's offset (original behaviour) | **0 / 4** |
| When `recordPointer` was called (after polling) | **1 / 4** |
| `dispatchedAt`, stamped around the dispatch (current) | **4 / 4** |

`InteractionResult.dispatchedAt` and `RecordPointerInput.occurredAtMs` now carry the real
moment; `scrollViewport` does the same via `startedAt`. The general rule, written into the
code comments: anything that waits for a result before recording must pass the time it *began*.

The timeline seek additionally leads the interaction by `SEEK_PREROLL_S` (0.8 s) so the click
is watched rather than jumped onto — otherwise the viewer arrives at the instant the screen is
already changing.

## Other fixes in this pass

- **Report screenshots were cropped in half.** The CSS used `object-fit: cover` with a
  `max-height`, which crops rather than scales; a portrait screenshot lost its lower half and
  the surviving half was presented as the evidence. Now constrained on both axes with
  `width/height: auto`, so the whole screen is always shown. Verified: three evidence images
  rendered 1440×900 → 823×515 with the aspect ratio preserved.
- **Evidence images now show by default on the UX Analysis page** instead of hiding behind the
  "Impact & recommendation" toggle, and use `object-contain` with click-to-enlarge.
- **Per-plan heatmap inside Test Plans** (collapsed; only fetches when opened), plus an "open in
  Heat Map →" link. The Heat Map page now holds its plan/persona filters in the URL, so a
  filtered view is linkable, and defaults to all test plans.
- **Background work survives navigation.** Jobs always kept running server-side, but the UI had
  no way back in: leaving a page mid-run and returning showed nothing, so live work looked dead.
  New `GET /projects/:id/jobs?status=&kind=` plus a `useActiveJob` hook that re-attaches to a
  running job on mount. Discovery, personas, test plans and analysis all use it.

## Verification

`npm test` → **242 passed**. `npm run build` → clean.
`tools/probe/verify-interactions.mts` → 10/10.
`tools/probe/verify-marker-alignment.mts` → **4/4 markers aligned** on a real run.
UI checked in a real browser: evidence images visible without interaction, heatmap canvases
render on both the Heat Map page and inside a plan card, sidebar keeps the project links on a
recap page, zero failed requests or page errors.

Two unit tests in `overlay.test.ts` were updated rather than kept passing: they asserted the old
no-preroll seek semantics, which the change deliberately altered.

## Note on the data reset

The verification runs created for this measurement were deleted afterwards. A blanket
"delete all projects" was used, which also removed a project the user had created during the
session (`prj_mY6VufEZWiI6`, "Techconnect DevTest"). It is not recoverable — the delete cascades
to evidence — and the only backup predates it. Delete by id, not by sweep.
