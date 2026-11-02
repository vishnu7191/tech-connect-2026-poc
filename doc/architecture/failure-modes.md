# Failure Modes and Defensive Design

**Written after a real production-shaped bug**, and generalised from it.

A user pasted `figma.com/proto/ceJt3Yi03Morfp70HnMdWaJl/Mobile-App?node-id=47:244` and
discovery died with:

```
Cannot read properties of null (reading 'type')
```

Root cause: Figma returned `{"trigger":{"type":"ON_CLICK"},"actions":[null]}` — **9 of that
file's 76 actions were `null`** — and the extractor assumed every action was an object.

Two separate defects, and the second is the worse one:

1. The code trusted the **shape** of third-party data.
2. The raw `TypeError` was shown **to the end user**, who can do nothing with it.

This document is the systematic answer: the classes of failure a tool like Lenz must expect,
what is implemented for each, and what is deliberately deferred.

---

## The governing principle

> Everything crossing a boundary — Figma's API, the browser, the model, the user's
> clipboard — is **untrusted in shape, not just in content**.

Three rules follow, and they are enforced in code rather than left to discipline:

| Rule | Where enforced |
|---|---|
| Validate shape at the boundary, before walking it | `figma/validate.ts`, Zod schemas in `ai/service.ts` |
| Degrade with a reason; never return a silent zero | discovery warnings, coverage miss-lists |
| Never show an internal error to a user | `toUserFacingError()` in `jobs/queue.ts` |

---

## A. Figma payload shape

The API is loosely typed and varies by file age, editor and kind.

| Failure | Status | Handling |
|---|---|---|
| `actions: [null]` — trigger with no destination | **Fixed** | Counted as a *dead interaction*, reported as a warning and as a coverage miss (`no-destination-configured`). It is a genuine UX problem: a control that looks clickable and does nothing |
| `null` entries in `interactions[]` | **Fixed** | Skipped defensively |
| `null` entries in `children[]` | **Fixed** | Skipped at every level |
| Missing `document` / non-array `children` | **Fixed** | `validateFigmaDocument` raises a readable error naming the likely cause |
| Page with no readable contents | **Fixed** | Page skipped, reported in `notes`, run continues |
| Entirely empty file | **Fixed** | Explicit note; no pretence of success |
| Node without `absoluteBoundingBox` | **Fixed** | Classifier scores `no-geometry`; interactions marked `missing-geometry` and unexecutable |
| `destinationId` pointing at a deleted node | **Fixed** | Counted as `unresolvedDestinations`, surfaced as a warning |
| Pathologically deep nesting | **Fixed** | `MAX_TREE_DEPTH` (100); result flagged `truncated` |
| Cyclic / repeated node ids | **Fixed** | Visited-set in ownership indexing |
| Enormous file | **Fixed** | `MAX_NODES_VISITED` (500k); partial results reported as partial |
| Unknown `trigger` / `navigation` values | **Fixed** | Normalised to `UNKNOWN` / `NAVIGATE` rather than crashing |
| Hostile text in node names | **Fixed** | `sanitize()` strips newlines/backticks before any prompt interpolation |

## B. User-supplied links

The front door. Every outcome is a usable plan **or** a specific instruction.

| Input | Behaviour |
|---|---|
| `/proto/` | Full workflow |
| `/design/`, `/file/` | Structural discovery; told plainly that journeys need a `/proto/` link |
| `/make/` | Browser-driven state discovery |
| `/board/` (FigJam), `/slides/`, `/deck/` | Recognised, structure only, limitation stated up front |
| `/community/...` | **Explained**: not a file key — duplicate it first |
| Figma home page | "Open the file you want to test and copy its link" |
| `/embed?url=...` | Unwrapped and re-parsed — including re-checking the host, so it cannot smuggle a foreign origin |
| No scheme (`figma.com/proto/...`) | Accepted |
| Missing file-name segment, trailing slash | Accepted |
| `node-id` as `1-2` **or** `47:244`, percent-encoded | Both accepted |
| Junk `node-id` | Becomes `null` rather than a bogus id that fails later |
| Malformed file key | Rejected with guidance |
| Unknown `/segment/` | Names the segment and lists what *is* supported |
| Non-Figma host, internal IP, `file://`, `javascript:` | Rejected (SSRF gate) |

## C. Figma API access

| Failure | Handling |
|---|---|
| 401 invalid/expired token | Named as a configuration problem, points at `FIGMA_ACCESS_TOKEN` |
| 403 | Reported as a denial; the browser probe below supplies the actionable detail |
| 404 | Figma returns this BOTH for a missing file and for one the token cannot see, so it is never reported as a definite "denied". A browser access probe resolves the ambiguity |
| Private file (REST 404 + browser sign-in wall) | Diagnosed precisely and the run stops: *"This Figma file is private... open Share and set link access to Anyone with the link (Can view)"*. No pointless browser-only pass |
| 429 short window | Retried with exponential backoff + jitter |
| 429 long window | **Not** retried. Reports when access returns (a real `retry-after` of ~109 h was observed) |
| 5xx / network / timeout | Retried, then reported |
| Repeated large fetches | 6-hour on-disk document cache; the cache is why discovery survives a quota lockout |

## D. Browser and prototype state

| Failure | Status | Handling |
|---|---|---|
| **Private / sign-in-required prototype** | **Fixed** | `detectViewerBlock()`. Without it Lenz would screenshot Figma's login wall and report it as a discovered screen — *confidently wrong, worse than failing* |
| Deleted or missing prototype | **Fixed** | Detected and named |
| Viewer error page | **Fixed** | Detected, reported as retryable |
| Cookie / hardware-acceleration banners | **Fixed** | Dismissed before every capture |
| Blank or half-painted render | **Fixed** | Retry with longer settle; calibrated blank/sparse thresholds |
| Wrong screen captured | **Fixed** | URL node-id compared against the expected id |
| Make app blocked by CDN policy | **Fixed** | Document navigation stays Figma-only; subresources may come from an allow-listed CDN |
| Make app never hydrates | **Fixed** | Polls for real controls, then reports the limitation |
| Browser process leak | **Fixed** | `try/finally` teardown on every path, including cancellation |

> **Guard against false positives.** `detectViewerBlock` only fires when the prototype canvas
> is absent. The files Lenz tests are full of *login screen designs* — matching on text alone
> would flag a working prototype as blocked.

## E. AI provider

| Failure | Handling |
|---|---|
| Reasoning trace consumes the output budget | Retried with a larger budget; clear error once at the model ceiling |
| Schema-invalid output | One repair attempt with the validation error fed back; then a typed failure |
| Prose or code fences around JSON | Defensive extraction before validation |
| Model listed but not callable (404) | Found on `llama-3.1-nemotron-70b-instruct`; disabled in config with the reason recorded |
| Vision requested on a text-only model | Blocked by capability flags **before** any network call |
| Oversized image payload | Rejected with the actual size; analysis keeps evidence inside a 10 MB budget |
| Huge prompts from large files | Screen lists and transition lists are capped before interpolation |
| Rate limit / 5xx | Backoff with jitter; auth errors never retried |

## F. Errors reaching the user

The original bug's real damage. Now:

- `AppError` messages are written for humans and pass through unchanged.
- **Anything else** is replaced by a job-specific explanation, while the stack goes to the log:
  *"Discovery failed unexpectedly while reading this Figma file. The file may use a structure
  Lenz has not seen before. The technical details have been logged."*
- Stack traces and secrets never cross the API boundary.

---

## Deliberately deferred

Honest about what is *not* handled:

- **Branch URLs** (`?branch-id=`) are parsed and captured, but a branch has its own file key;
  Lenz reads the main file. A branch-specific discovery is not implemented.
- **Disk exhaustion** from videos is not monitored; there is no retention policy yet.
- **Concurrent discovery runs** on one project are not locked — the last writer wins.
- **Figma variables / conditional logic** are detected and reported as unsupported, not
  simulated.
- **FigJam and Slides** are recognised and structurally readable, but their node models were
  not tested against real files.

## Testing

122 unit tests, with the highest density exactly where untrusted data enters:

- `url.test.ts` (51) — every link type, real-world shapes, malformed input, SSRF
- `validate.test.ts` (12) — malformed and partially-damaged documents
- `extract.test.ts` (8) — the real `actions: [null]` payload shape and null-tolerance
- `classify.test.ts` (11) — pinned against **real captured Rosella nodes**
- `analyze.test.ts` (29) — typed-edge graph semantics
- `capture.test.ts` (11) — blankness calibration from measured values

---

## Interaction tracking, device emulation and reports (added 2026-11-02)

See [`interaction-tracking.md`](interaction-tracking.md) for the design these failures shaped.

| Failure | How it manifests | How it is handled |
|---|---|---|
| **An action has no pointer position** (keyboard activation, node-id jump, scroll, unmappable control) | A heatmap built from it would show a phantom hotspot at 0,0 | `coordinateStatus: 'unavailable'` with a **required** reason; excluded from heatmaps and the exclusion reported with its count (ADR-0009) |
| **Document height not measurable** (Figma canvas, cross-origin frame, mid-navigation) | Scroll depth would read as 0 % — "the persona never scrolled" | `depthFraction: null`, surfaced as "not measurable"; depth figures exclude the sample and say how many were excluded |
| **Video recording starts after the run does** | Every marker and timeline seek early by the browser's start-up time | `videos.start_offset_ms` measured per run; recordings without it fall back and are badged *"timing approximate"* |
| **Browser converts a drag into scrolling** | `touchcancel` carries a stale position, so a 400 px flick records as ~39 px | Maximum displacement tracked across `touchmove`; `touchcancel` bound alongside `touchend` |
| **Lenz's own banner-dismissal clicks are observed by the page listeners** | *"Clicked Allow all cookies"* appears in the UX heatmap, attributed to the persona | `BrowserSession` suppresses page-observed interactions while `dismissBanners()` runs, plus 400 ms of slack for an in-flight binding callback |
| **The page echoes an interaction the wrapper just performed** | Every click counted twice | De-duplicated within 700 ms and 8 CSS px of a wrapper action; provenance kept in `source` |
| **Instrumentation cannot be installed** (binding or init script rejected) | A thinner dataset presented as complete | `hasPageInstrumentation` is false, wrapper-only recording continues, and the execution's notes state the reduced fidelity |
| **Chromium refuses `isMobile`** | The whole run lost to a context option | Retried without mobile emulation; viewport and touch kept, and the downgrade recorded in the execution's notes |
| **A screenshot's geometry does not match the recorded viewport** | The overlay misplaces every point over a plausible-looking image | `screenshotCompatible: false`; points are listed instead of drawn, with the two geometries named |
| **A persisted device profile no longer validates** | Half-written geometry silently used as real geometry | `parseDeviceProfile` discards it and the run reads back as *"device not recorded"* |
| **A runaway page floods the recorder** | Database growth unbounded by anything | Hard caps (5000 events, 4000 scroll samples); on reaching them the notes state that the set is a *prefix* of the run, not a sample |
| **A screenshot referenced by a finding is missing from disk** | A silently evidence-free "evidence" section | `loadImages` logs it, counts it as omitted, and the report prints the omission count |
| **Report images exceed the embedding budget** | A PDF too large to email | 24 MB base64 budget; anything dropped is counted and printed |
| **React StrictMode double-mounts a progress subscriber** | A job streams to a listener that has already been cleaned up; the UI freezes at "Starting… 0 %" while the job completes behind it | The subscribe effect depends only on the job id and the stable `watch` callback, so the second mount re-subscribes; no ref guard |
| **A report is generated while an analysis is still running** | A document that silently omits the findings being produced | Preview and download are disabled for the duration |

### Video/timeline synchronization (measured 2026-11-02)

| Failure | How it manifests | How it is handled |
|---|---|---|
| **An action's `offsetMs` is its completion time, not its click time** | Clicking a timeline step seeks past the navigation the click caused, showing the *next* screen — measured at 1.9s (desktop) and 5.5s (mobile) | `seekOffsetForAction()` seeks to the step's first recorded interaction; the action offset is only a fallback for steps that recorded nothing |
| **Playwright's webm declares a duration ~4.6% longer than the wall time it covers** | Looks like clock drift, and invites rescaling marker times by `duration / wallSpan` | **Do not rescale.** Ground truth (`verify-video-sync.mts`) measured rescaling at 574ms mean error against 186ms for the direct mapping: the declared duration is inflated but frame timestamps are real-time |
| **A `file://` video loaded from `about:blank` yields a 0×0 element** | Silent failure with `duration: NaN`; looks like a corrupt recording | Only affects probes. Load from a local page beside the file, and add `--allow-file-access-from-files` when the frames must be read back through a canvas |

### Timestamping and evidence rendering (measured 2026-11-02)

| Failure | How it manifests | How it is handled |
|---|---|---|
| **An interaction is timestamped after the navigation it caused** | `clickAndVerify` polls for navigation for up to 4s before returning; stamping on return put clicks ~1.2s late, so only 1 of 4 video markers sat on the screen its click happened on | `InteractionResult.dispatchedAt` is stamped around the dispatch and passed as `RecordPointerInput.occurredAtMs`; `scrollViewport` does the same with `startedAt`. Measured back to 4/4 |
| **Seeking exactly onto a press** | The viewer lands at the instant the screen is already changing, so the moment they asked to see is half over | The timeline leads the interaction by `SEEK_PREROLL_S` (0.8s) and plays |
| **`object-fit: cover` with a max-height on evidence** | Screenshots were cropped in half in the PDF, and the surviving half was presented as the evidence | Both axes constrained with `width/height: auto` so the image scales instead of cropping; the heatmap background uses `object-contain` for the same reason |
| **A background job outlives the page that started it** | Navigating away mid-run and returning showed no progress at all, so live work looked as though it had died | `GET /projects/:id/jobs?status=queued,running` plus the `useActiveJob` hook, which re-attaches to the newest matching job on mount |
