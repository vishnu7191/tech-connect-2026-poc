# Architecture Decision Log

Each entry records a decision, the reasoning behind it, and what was rejected. Entries are
append-only; a superseded decision is marked rather than deleted.

---

## ADR-0001 — Typed graph edges instead of a flat interaction graph

**Status:** Accepted · **Date:** 2026-10-31

**Context.** Figma exposes prototype interactions as a flat list. The obvious model is
"interaction = navigation edge". Measuring the live Rosella file showed 1250 interaction
actions broken down as 740 `CHANGE_TO`, 435 `NAVIGATE`, 41 `OVERLAY`, 8 `SWAP`, 6
`SCROLL_TO`.

**Decision.** Edges are typed by Figma `navigation` mode. Only `NAVIGATE` creates a
screen-level edge and affects reachability. `CHANGE_TO`/`SCROLL_TO` become intra-screen
UI-state edges; `OVERLAY`/`SWAP` become overlay-state edges.

**Reasoning.** The flat model would be wrong for **59%** of this file's interactions,
producing a hairball graph, a badly inflated screen count and meaningless coverage figures.
Component variant swaps are genuine UI states but they are *not* screen transitions. Section
6 of the brief demands this distinction; the data shows it is a practical necessity, not a
theoretical nicety.

**Rejected.** Flat edge list (wrong); discarding non-`NAVIGATE` interactions entirely (loses
the variant/overlay states the brief explicitly requires tracking).

---

## ADR-0002 — Screens are classified, not assumed

**Status:** Accepted · **Date:** 2026-10-31

**Context.** 102 top-level children on Rosella's *Mockup* canvas, a large share of them
`COMPONENT_SET` design-system parts (`Heart`, `XS`, `Add to bag`, `ei:arrow-left`).

**Decision.** A scoring classifier assigns `screen | component | ambiguous` using node type,
device-class dimensions, flow membership, inbound `NAVIGATE` edges and name heuristics.
The reasons behind each verdict are persisted and shown in the UI.

**Reasoning.** Treating every top-level frame as a screen would roughly double the screen
count and corrupt every downstream coverage percentage. Because classification is a
heuristic, it must be **auditable and overridable** rather than silent — hence persisting the
reasons.

**Rejected.** Type-only filtering (misses large component frames and small genuine screens);
AI classification (slow, costly and non-deterministic for what is largely a geometry problem).

---

## ADR-0003 — Browser is the sole source of runtime evidence

**Status:** Accepted · **Date:** 2026-10-31

**Context.** Figma's `/v1/images` renders frames server-side — fast, clean, and tempting to
use as "screenshots".

**Decision.** Only Playwright output counts as a browser screenshot. Figma renders are stored
with `source: "figma-render"` and labelled as design references throughout the UI.

**Reasoning.** A Figma render proves a frame *exists in the design*; it proves nothing about
whether the prototype renders, navigates or behaves at runtime. Conflating the two would let
Lenz report success for a prototype that is broken in a browser — the exact dishonesty the
brief forbids.

---

## ADR-0004 — URL node id as ground-truth destination verification

**Status:** Accepted · **Date:** 2026-10-31

**Context.** Verifying that an interaction "worked" usually means a brittle visual diff.
Live probing showed the Figma viewer reflects the current frame in the URL: clicking "Explore
Now" on Home (`node-id=1-2`) changed the URL to `node-id=145-61` (Dresses) — exactly the
destination predicted by REST metadata.

**Decision.** Every executed interaction compares the **expected** `destinationId` from REST
metadata against the **actual** node id parsed from the URL, yielding
`match | mismatch | no-navigation | timeout`.

**Reasoning.** This converts "we clicked something" into a verifiable assertion, cheaply and
deterministically. It also makes a *mismatch* a reportable UX finding rather than a test
error. Direct `?node-id=` navigation additionally lets capture reach every screen without
replaying click chains, so one broken interaction cannot block capture of everything behind
it.

---

## ADR-0005 — SSE for job progress

**Status:** Accepted · **Date:** 2026-10-31

**Decision.** Long-running jobs stream progress over Server-Sent Events, paired with a
snapshot endpoint (`GET /jobs/:id`).

**Reasoning.** Progress is strictly server-to-client. SSE is plain HTTP, reconnects
automatically, and needs no additional protocol handling or proxy configuration. The snapshot
endpoint covers late joiners and reconnects without replaying event history.

**Rejected.** WebSockets (bidirectional machinery for a one-way problem); polling (latency and
wasted requests during multi-minute runs).

---

## ADR-0006 — SQLite + filesystem evidence, behind interfaces

**Status:** Accepted · **Date:** 2026-10-31

**Decision.** `better-sqlite3` at `data/lenz.db`; screenshots and videos on disk behind an
`EvidenceStorage` interface.

**Reasoning.** Lenz is a local-first single-operator tool; Postgres would add operational
weight with no benefit. SQLite is transactional and durable, and its synchronous API removes
a class of race conditions in the job worker. Multi-megabyte video in a database column would
bloat it and complicate backup. The storage interface keeps a future move to object storage a
one-file change, as the brief requires.

---

## ADR-0007 — Provider quirks live only in adapters

**Status:** Accepted · **Date:** 2026-10-31

**Context.** The configured NIM model is a reasoning model: it returns `reasoning_content`
alongside `content`, reports `reasoning_tokens` separately, and with `max_tokens: 300` a
vision call returned `content: null` with `finish_reason: "length"` because the reasoning
trace consumed the whole budget.

**Decision.** Feature code calls `AiService` with a **task name** and never a model id. All
provider- and model-specific behaviour — reasoning token budgeting, separating the trace from
the answer, retrying truncation — lives in the adapter.

**Reasoning.** Model choice is meant to be an experiment driven by configuration. If a
feature knew that its model reasons, swapping models would become a code change, defeating
the brief's central requirement. Treating truncation as retryable inside the adapter also
removes what would otherwise be the product's most common and most confusing failure mode:
an unexplained empty result.

---

## ADR-0008 — AI output is untrusted until schema-validated

**Status:** Accepted · **Date:** 2026-10-31

**Decision.** Every structured AI response is validated against a Zod schema before use.
Proposed browser actions are additionally constrained to a closed action set (click known
coordinates, navigate to a node id already in the graph, scroll, wait, type synthetic text,
go back). Raw JavaScript execution and arbitrary URL navigation are not expressible.

**Reasoning.** The model reads untrusted prototype content, so its output is an injection
vector into a browser that the system controls. A closed action vocabulary makes unsafe
actions *unrepresentable* rather than merely discouraged, which is a stronger guarantee than
filtering. Schema validation is also the correctness boundary — malformed output becomes a
typed, retryable error instead of a corrupt record.

---

## ADR-0009 — Interaction coordinates are recorded or absent, never inferred

**Status:** Accepted · **Date:** 2026-11-02

**Context.** Click and tap positions drive the video markers and every heatmap. Some actions
genuinely have no position: a keyboard activation, a `navigateToNode` jump by node id, a
scroll gesture, a step where no control could be mapped at all.

**Decision.** `InteractionEvent` carries `coordinateStatus` (`recorded` | `unavailable`) and a
`coordinateNote` that is **required** whenever the status is `unavailable`. Heatmap aggregation
excludes unpositioned events and reports each exclusion with its reason and count. No code path
writes a default coordinate.

**Reasoning.** A fabricated `0,0` is not a missing value — it is a visible hotspot in the
top-left corner of a heatmap that nobody can explain and that looks like real behaviour. The
same applies to scroll depth: `depthFraction` is `null` when the document height was not
measurable, because a defaulted 0 % reads as "the persona never scrolled", which is a different
claim entirely. Forcing a written reason at the point of recording is what makes the gap
explainable later, rather than an unexplained shortfall in a report.

---

## ADR-0010 — Heatmaps group by screen *and* viewport geometry

**Status:** Accepted · **Date:** 2026-11-02

**Context.** The same plan can now run on desktop, tablet and mobile. A responsive layout puts
the same control in a different place at each width.

**Decision.** The heatmap grouping key is `screenId | deviceId | viewportWidth x viewportHeight`.
Coordinates recorded at different viewports are never merged, and the UI has no option to
override this. A background screenshot is used only when its CSS geometry matches the recorded
viewport exactly; otherwise the group keeps its points, flags the mismatch and explains it.

**Reasoning.** Merging a 390-wide and a 1440-wide run produces a map that describes neither
layout while looking entirely plausible — the worst class of error this product can make,
because nothing about the output signals that it is wrong. Making the separation structural
rather than a convention means it cannot be forgotten. The same reasoning drives the related
rule in `services/responsive.ts`: a difference between layouts is reported as a measurement
(`info`), and only an execution that failed on one device while succeeding on another is called
a `failure`.

---

## ADR-0011 — One browser engine for every device profile

**Status:** Accepted · **Date:** 2026-11-02

**Context.** Playwright ships WebKit and Firefox alongside Chromium, and its iOS device
descriptors declare `defaultBrowserType: 'webkit'`.

**Decision.** Lenz launches **Chromium for every device profile**. The engine a descriptor was
authored for is persisted on the profile as `descriptorBrowser`, and each profile carries an
`emulationNote` that the UI and the PDF print verbatim.

**Reasoning.** The responsive comparison only means anything if the runs differ in *viewport*
and nothing else. Changing the engine between runs would make screenshots, video encoding,
layout rounding and coordinate space all vary simultaneously, so no difference could be
attributed to the breakpoint. The cost — an iOS profile is Chromium wearing iOS metrics, not
Safari — is real, so it is recorded in the data rather than in prose that a report could omit.
Swapping engines later is a change to `browser/devices.ts` alone.
