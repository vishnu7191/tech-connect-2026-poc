# Browser Automation, Evidence and Coverage

Playwright is the **only** source of browser screenshots and video. Figma-rendered node
images (`/v1/images`) are design references and are labelled as such everywhere; they are
never presented as runtime evidence.

## 1. Session model

A `BrowserSession` wraps one Playwright `BrowserContext`:

- **Fixed viewport per device class** (desktop 1440x900, mobile 390x844) so screenshots are
  comparable across runs and the vision model sees consistent framing.
- **Video recording** is enabled at context creation — Playwright can only start recording
  when the context is created, so every execution context is created recording-capable.
- **Deterministic chrome removal.** The Figma viewer injects a cookie consent banner and a
  "enable hardware acceleration" toast (both observed live). These are dismissed before the
  first capture; otherwise every screenshot carries Figma UI that would pollute UX analysis.
- **Guaranteed teardown** via `try/finally`, including on cancellation, so browser processes
  and temp profiles never leak.

## 2. Navigation — two mechanisms, both verified

### Direct node navigation (primary, for capture)
`?node-id=<id>` loads any frame directly. This gives **deterministic coverage**: every
discovered screen can be captured without replaying long click chains, including frames that
are unreachable by interaction. Capture order is independent of graph topology, so one broken
interaction cannot block capture of everything behind it.

### Interaction navigation (for verification and execution)
Clicking at computed coordinates exercises the prototype as a user would. This is what proves
an interaction *works*, and it is how persona test plans execute.

### Destination verification — the backbone of the coverage model
Verified live: from `node-id=1-2` (Home), clicking "Explore Now" moved the URL to
`node-id=145-61` (Dresses) — exactly the destination Figma metadata predicted.

So for every executed interaction Lenz records:

```
expectedDestination   from Figma REST metadata
actualDestination     parsed from the URL after the click settles
verdict               match | mismatch | no-navigation | timeout
```

A **mismatch is a first-class result**, not an error — a prototype whose interaction leads
somewhere unexpected is a genuine UX finding, and this is the mechanism that detects it.

### Coordinate mapping
Figma metadata gives absolute canvas geometry; the viewer scales the frame to fit the
viewport. The engine derives the transform from the active frame's bounds versus the viewport,
then maps a trigger node's absolute centre into viewport coordinates. Targets outside the
viewport are scrolled into view first; if a target cannot be brought into view, the
interaction is recorded `unexecutable` with that reason rather than clicked blindly.

## 3. Screenshot capture and validation

A capture is not trusted until it passes validation:

| Check | Failure meaning |
|---|---|
| File exists and is non-trivial in size | Capture silently failed |
| Decodes as a valid PNG | Truncated or corrupt write |
| **Not blank** — pixel-variance sampling against a threshold | Page never painted |
| Settled — no layout/network churn in a short window | Captured mid-render |
| URL node id matches the intended screen | Captured the wrong screen |

Failures retry with backoff (longer settle, forced reload). A screen that still fails is
recorded with `captureStatus: failed` **and a reason** — never dropped from the inventory,
and never counted as captured.

Every capture persists: screen name, screen/state id, Figma node id, triggering action,
timestamp, status, test execution id, file path, and the verification verdict — satisfying
section 7 of the brief and giving the UI gallery and the analysis stage a complete evidence
record. Duplicate captures of an unchanged state are suppressed by comparing state
signatures.

## 4. Figma Make discovery (Scenario C)

Make is an interactive web app, not a frame graph, and is handled by the **same state-graph
abstraction** rather than a parallel implementation.

Verified: the top-level page is Figma chrome (sign-in, cookie banner, warning bar); the real
app renders in a nested iframe served from `https://<uuid>-figmacachedpreview.figma.site/`,
and it is **real DOM**, so DOM-based discovery works.

The engine therefore:

1. Loads the Make URL and waits for the app to become usable.
2. **Resolves the preview iframe** and binds all subsequent interaction and capture to that
   frame. Capturing the top-level page would embed Figma chrome in every screenshot.
3. Captures the initial state.
4. Discovers interactive elements — buttons, links, inputs, tabs, menus, dropdowns — by role
   and semantics, filtering to visible, enabled, in-viewport controls.
5. Executes **safe** interactions only (see section 6).
6. Detects state change after each action, by **route change OR DOM-signature change** — a
   dropdown opening, a tab switching or a modal appearing are meaningful states with no URL
   change, so URL alone is insufficient.
7. Assigns each distinct state a stable identity: `hash(route + normalized DOM signature)`.
8. Captures on meaningful change and records the action history as graph edges.

The result is a browser-discovered state graph consumed by the same UI, coverage and analysis
code as a Figma prototype graph.

## 5. Video recording (Recap Test)

Playwright's native context-level video recording captures the **actual browser session**,
start to finish. A recap is never assembled from stitched screenshots — section 11 of the
brief rules that out explicitly, and it would also misrepresent timing and motion.

- Recording is bound to the execution's context, so the file covers the whole run.
- The video is finalized on context close; the path is only resolved after close, which is
  why teardown must always run.
- Metadata persisted: execution id, persona, test plan, start/end timestamps, duration, file
  size, dimensions.
- Each timeline action stores its offset from execution start, so a screenshot in the
  timeline can seek the video to that moment.
- A recording that is missing or zero-length is reported as a **failed recording** with a
  reason; the execution is still valid, but the recap is explicitly marked incomplete.

## 6. Safe execution

The AI may propose actions, but it can never execute arbitrary commands. Proposals are
validated against a Zod schema and constrained to a closed action set:

`click(x, y)` on a known element, `navigateToNode(id)` for an id present in the graph,
`scroll(direction, amount)`, `wait(ms)`, `typeText(field, syntheticValue)`, `goBack()`.

Explicitly impossible: executing JavaScript, opening arbitrary URLs, uploading files,
accessing the filesystem, or any network call outside the allow-listed origins.

Additional guards:

| Guard | Purpose |
|---|---|
| Origin allow-list | Only Figma origins + the resolved Make preview origin |
| Max actions / max navigations per execution | Bounds runaway loops |
| Per-action and per-execution timeouts | Bounds hangs |
| Loop detection on `(state, action)` repetition | Stops oscillation between two states |
| Synthetic data only | Test-safe values; never real credentials or payment details |
| Destructive-intent screening | Actions whose labels suggest purchase, delete, submit-payment or send are skipped and logged as deliberately-not-executed |
| Cooperative cancellation | Checked between actions so stop is prompt |

Error recovery: a failed action is retried once, then recorded as failed and the run attempts
to continue from a known state (re-navigating to the step's starting screen) rather than
aborting the whole plan.

## 7. Coverage model

Seven dimensions, tracked and reported **independently**. Collapsing them into one percentage
is precisely the misleading summary the brief forbids.

| # | Dimension | Measures |
|---|---|---|
| 1 | Design discovery | Screens found vs. total eligible nodes in the file |
| 2 | Reachability | Screens reachable from an entry point via `screen` edges |
| 3 | Interaction discovery | Interactions extracted vs. supported interactions present |
| 4 | Interaction execution | Interactions actually executed in a browser |
| 5 | Screenshot capture | Screens with a *validated* capture |
| 6 | Test execution | Plan steps completed successfully |
| 7 | Video recording | Executions with a verified non-empty recording |

Rules enforced in code:

- A dimension shows **100% only when its miss-list is empty.** Any screen or interaction with
  a recorded failure reason keeps the number below 100.
- Every miss carries a machine-readable reason, so the UI explains the gap:
  `no-incoming-navigate-edge`, `unsupported-trigger`, `render-failed`, `blank-screenshot`,
  `destination-mismatch`, `api-inaccessible`, `cancelled`, `action-limit-reached`.
- Components excluded by classification are reported separately from screens that failed —
  excluding a `COMPONENT_SET` is correct behaviour, not a coverage gap, and conflating the two
  would hide real failures.
