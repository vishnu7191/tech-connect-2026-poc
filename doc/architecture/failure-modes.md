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
