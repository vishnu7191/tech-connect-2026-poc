# Product Documentation

## Product vision

Lenz turns a design prototype into **evidence about how it will be used**, before a single
line of production code is written.

A designer pastes a Figma URL. Lenz discovers the screens and the real navigation structure,
generates synthetic personas, writes test plans those personas would plausibly attempt,
executes the plans in a real browser, records the whole journey on video, and reports UX
findings backed by screenshots of the exact moment the problem occurred.

## Problem statement

Usability problems are cheapest to fix while the work is still a prototype, but that is
exactly when validation is hardest to obtain:

- **Recruiting real users is slow and expensive**, so early-stage prototypes are usually
  reviewed by the team that designed them — the people least able to see them freshly.
- **Design review is opinion-shaped.** Feedback arrives as assertions ("this feels
  confusing") without a record of what was attempted or where the attempt broke down.
- **Prototype complexity is invisible.** A Figma file with a hundred frames hides which
  screens are actually reachable, which are orphaned, and which interactions were never
  wired up. Nobody knows what coverage a review achieved.
- **Generic AI design critique is unreliable.** Asking a model to "review this screenshot"
  produces plausible, unfalsifiable prose with no link to an actual user journey.

Lenz addresses all four: it makes the prototype's real structure explicit, drives it the way
a user would, and ties every finding to recorded evidence.

## Product objectives

1. **Discover the truth about a prototype** — all screens, real reachability, orphans,
   and unsupported interactions, with no flattering defaults.
2. **Simulate plausible users** rather than an idealized one, via explicit personas whose
   proficiency, goals and frustrations differ.
3. **Execute, don't speculate** — drive a real browser and verify each navigation actually
   landed where it was supposed to.
4. **Produce evidence, not opinions** — every finding carries a screenshot, a test step, and
   a confidence level.
5. **Stay honest about coverage** — report what was *not* reached as prominently as what was.
6. **Make model choice an experiment, not a commitment** — swap and compare AI models per
   task from configuration.

## Target users

| User | Need from Lenz |
|---|---|
| **Product designer** | Early signal on whether a flow works, without recruiting participants. |
| **UX researcher** | A reproducible, evidence-backed first pass that focuses scarce real-user sessions on genuine uncertainty. |
| **Product manager** | A shareable report showing which journeys complete and where users stall. |
| **Design-system / QA engineer** | Objective prototype coverage: orphaned screens, dead interactions, broken links. |
| **AI engineer (this project's operator)** | A harness for comparing models on real, repeatable UX tasks. |

> **Scope boundary.** Lenz produces *synthetic* evidence. Personas are generated
> constructs, not research participants. Findings are hypotheses with supporting evidence —
> strong enough to prioritize design work and to target real user research, but they do not
> replace testing with real humans, and the product must never imply otherwise.

## Core user workflows

The primary workflow:

```
Figma URL
  -> URL classification        (proto / make / design / file)
  -> Screen discovery          (REST structure + browser verification)
  -> Navigation analysis       (typed graph, flows, entry points, orphans)
  -> Entry point selection     (user confirms or picks a candidate)
  -> Persona creation          (manual or AI-generated)
  -> Test plan generation      (AI, grounded in the real graph)
  -> Review and approval       (human gate)
  -> Autonomous execution      (Playwright, screenshots, video)
  -> UX analysis               (vision model over captured evidence)
  -> Report                    (prioritized findings + coverage)
```

Secondary workflows: re-running a plan after a design change; reusing a persona library
across projects; comparing two models on identical input in the Model Lab.

## Functional requirements

### FR1 — URL handling
Classify and support prototype URLs with a start node (A), without one (B), Figma Make
applications (C), and design URLs (D). Never fail merely because `node-id` is absent.

### FR2 — Screen discovery
Enumerate pages and frames via REST where authorized; distinguish genuine screens from
design-system components; fall back to browser-only discovery when the API is unavailable;
report the precise reason for anything missing.

### FR3 — Navigation graph
Build a typed directed graph. Screen transitions, in-screen UI-state changes and overlays are
distinct edge kinds. Compute reachability, orphans, multiple independent flows, and paths.

### FR4 — Entry points
Use declared `flowStartingPoints` and `prototypeStartNodeID` as **confirmed** entries. Where
none exist, rank **candidates** by in-degree, naming, size and canvas position — always
labelled as inferred, never auto-promoted.

### FR5 — Persona management
Create, AI-generate, edit, save, reuse and select personas with the attributes in section 8
of the brief.

### FR6 — Test plans
Generate persona-grounded plans from the real graph, with editable steps, and an explicit
approval gate before execution.

### FR7 — Execution
Execute approved plans in a real browser with screenshots, full-session video, an
action-by-action log, and start/pause/resume/stop/retry controls.

### FR8 — Verification
Compare the actual reached node against the expected destination for every navigation, and
validate every screenshot (exists, readable, non-blank).

### FR9 — UX analysis
Produce findings with severity, category, affected screen, screenshot evidence, persona
impact, recommendation and confidence — separating observed issues from heuristic ones.

### FR10 — AI configuration
Centralized JSON provider config, per-task model assignment, and side-by-side model
comparison with history.

### FR11 — Coverage
Track the seven coverage dimensions independently and never display a misleading 100%.

## Non-functional requirements

| Area | Requirement |
|---|---|
| **Security** | Secrets backend-only; never returned by any API. Strict URL allow-listing (SSRF). AI output validated before any browser action. |
| **Reliability** | Long jobs survive individual step failures; a failed screen is recorded with a reason, not fatal to the run. Browser resources always released. |
| **Observability** | Structured logs with job correlation; every external call timed and recorded. |
| **Performance** | Discovery of a ~100-node file within a few minutes; full document fetched once and cached per project. |
| **Portability** | Local-first (SQLite + local filesystem), with storage behind an interface so object storage can replace it without touching business logic. |
| **Maintainability** | Strong TypeScript types end to end; provider-specific quirks isolated in adapters. |
| **Honesty** | Mock mode and live mode visibly distinct in UI, API responses and logs. |

## MVP scope

**In scope**

- Scenarios A, B, C; D as structural discovery only.
- Figma REST discovery, typed graph, entry-point ranking, coverage reporting.
- Playwright verification, screenshot validation, session video.
- Personas (manual + AI), test plans (AI + editable + approval).
- Autonomous execution with controls and full timeline.
- Vision-based UX analysis with evidence links.
- NVIDIA NIM provider; centralized config; per-task routing; Model Lab comparison.
- React dashboard covering the full workflow.

**Explicitly out of scope for MVP**

- Multi-user accounts, authentication, tenancy, RBAC.
- Figma files requiring OAuth beyond a personal access token.
- Figma variables/conditional-logic *evaluation* (detected and reported as unsupported,
  not simulated).
- Cloud object storage, horizontal scaling, distributed job workers.
- Automated remediation or writing fixes back to Figma.

## Future enhancements

Real-user session comparison; regression tracking across prototype versions; WCAG-rule
accessibility auditing alongside heuristic findings; object storage and distributed workers;
team collaboration and shareable report links; Figma variable/conditional simulation;
additional providers (OpenAI-compatible, Anthropic, local vLLM) through the existing adapter
interface; cost-aware model routing driven by Model Lab results.
