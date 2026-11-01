# Lenz UX Validation Engine — Documentation Index

This `doc/` tree is the permanent reference for the project. It is written so that a future
engineer (or a future Claude session) can understand and continue the work **without access to
the original conversation**.

## Read in this order

| # | Document | What it answers |
|---|---|---|
| **0** | **[HANDOVER.md](HANDOVER.md)** | **New session? Start here.** Orientation, how to run it, hard-won gotchas, working agreements, current state. |
| 1 | [findings/external-verification.md](findings/external-verification.md) | What we actually **measured** about Figma, NVIDIA NIM and Playwright. Read this first — the architecture is a consequence of it. |
| 1b | [high-level-workflow/](high-level-workflow/README.md) | **Start here for the big picture**: diagrams of the whole flow from URL to report, and which tool does each job. |
| 2 | [product/vision.md](product/vision.md) | Why Lenz exists, who it serves, what it must do, MVP scope. |
| 3 | [architecture/overview.md](architecture/overview.md) | System shape, module boundaries, request and job lifecycle. |
| 4 | [architecture/figma-discovery.md](architecture/figma-discovery.md) | URL classification, REST discovery, the typed graph model, entry-point ranking. |
| 5 | [architecture/browser-automation.md](architecture/browser-automation.md) | Playwright engine, screenshot verification, Make discovery, video recording. |
| 6 | [architecture/ai-providers.md](architecture/ai-providers.md) | Centralized JSON provider config, adapters, task-to-model routing, Model Lab. |
| 7 | [architecture/data-model.md](architecture/data-model.md) | Persistence schema and entity relationships. |
| 8 | [architecture/api-design.md](architecture/api-design.md) | HTTP surface and real-time progress. |
| 8b | [architecture/failure-modes.md](architecture/failure-modes.md) | Every class of failure and how it is handled. |
| 9 | [development/setup.md](development/setup.md) | Environment, install, run, test. |
| 10 | [development/status.md](development/status.md) | **Honest current state**: what works, what is verified, what remains. |
| 11 | [decisions/](decisions/) | Architecture Decision Records. |

## Core principle

Lenz is an **evidence-driven** platform. Every claim it makes to a user — a screen was
discovered, an interaction was executed, a destination was reached, a UX finding is real —
must be traceable to captured evidence. The codebase treats "we do not know" as a first-class,
reportable outcome rather than something to paper over with a default value.

Two rules follow from that and are enforced throughout:

- **Never report a coverage number that flatters the run.** Discovery, reachability,
  execution and capture coverage are tracked and surfaced *separately*, each with the
  explicit reason for every miss.
- **Never present inferred data as observed data.** Figma-rendered node images are design
  references; only Playwright output counts as a browser screenshot. Candidate entry points
  are labelled as inferred and never silently promoted to confirmed starting points.
