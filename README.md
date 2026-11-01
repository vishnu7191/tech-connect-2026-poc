# Lenz — UX Validation Engine

Lenz turns a Figma prototype into **evidence about how it will be used**, before any
production code is written.

Paste a Figma URL. Lenz discovers the screens and the real navigation structure, generates
synthetic personas, writes test plans grounded in that structure, executes them in a real
browser, records the whole session on video, and reports UX findings backed by screenshots of
the exact moment the problem occurred.

```
Figma URL → Screen discovery → Navigation analysis → Personas → Test plans
          → Autonomous execution → Screenshots + video → UX analysis → Report
```

## What makes it different

- **It distinguishes navigation from UI state.** On the reference prototype, 59% of
  interactions are component variant swaps, not screen transitions. Lenz types every edge, so
  reachability means something.
- **It tells you what it missed.** Seven coverage dimensions are tracked independently, each
  with a machine-readable reason for every gap. A dimension reaches 100% only when its
  miss-list is empty.
- **It verifies, rather than assumes.** Every interaction compares the destination Figma
  *declared* against the node the browser *actually* reached. A mismatch becomes a finding.
- **Evidence beats opinion.** A finding can only be recorded as "observed" if it references a
  screen with a validated screenshot. There is deliberately no overall UX score.
- **Model choice is configuration.** Providers, models and per-task routing live in one JSON
  file. No feature knows a model id.

## Quick start

```bash
npm install
npx playwright install chromium

cp .env.example .env     # then fill in real values
npm run dev              # backend on :4000, frontend on :5173
```

Open <http://localhost:5173>, create a project from a Figma URL, and run discovery.

### Environment

| Variable | Required | Purpose |
|---|---|---|
| `NVIDIA_API_KEY` | yes | Resolves `${NVIDIA_API_KEY}` in `config/ai-providers.json` |
| `FIGMA_ACCESS_TOKEN` | for REST discovery | Without it Lenz degrades to browser-only discovery and says so |
| `PORT` | no (4000) | Backend port |
| `DATA_DIR` | no (`./data`) | SQLite database and evidence files |
| `HEADLESS` | no (`true`) | Set `false` to watch the browser drive the prototype |

`.env` is gitignored. `config/ai-providers.json` contains **`${ENV_VAR}` placeholders only** —
a literal key there is rejected at startup.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Backend + frontend together |
| `npm run build` | Type-check and build every workspace |
| `npm test` | 80 unit tests — fast, offline, deterministic |
| `npm run typecheck` | Type-check without emitting |
| `npm run verify:live` | **Live** checks against Figma and NVIDIA (needs real credentials) |

## Layout

```
packages/shared/   Zod schemas + types shared by server and web
apps/server/       Fastify API, domain services, Playwright, AI, SQLite
apps/web/          React + Vite dashboard
config/            ai-providers.json — centralized, env-interpolated
doc/               Full documentation (start at doc/README.md)
tools/probe/       Live-endpoint verification scripts
data/              SQLite + evidence artifacts (gitignored)
```

## Supported inputs

| Scenario | URL | Handling |
|---|---|---|
| A | `/proto/...?node-id=1-2` | Declared start node used as the confirmed entry point |
| B | `/proto/...` (no node-id) | **Not an error.** Uses declared flows; ranks candidates where none exist |
| C | `/make/...` | Drives the live app in its preview iframe; tracks DOM-signature UI states |
| D | `/design/...`, `/file/...` | Structural discovery only; no prototype flows to traverse |

## Documentation

**Picking this up fresh? Read [`doc/HANDOVER.md`](doc/HANDOVER.md) first** — it is written to
bring a new engineer or AI session fully up to speed without any prior context.

Then [`doc/README.md`](doc/README.md) indexes everything else. Most useful first reads:

- [`doc/findings/external-verification.md`](doc/findings/external-verification.md) — what was
  actually measured about Figma, NVIDIA NIM and Playwright. The architecture follows from it.
- [`doc/development/status.md`](doc/development/status.md) — honest current state: what is
  verified, what is merely built, and what is missing.
- [`doc/decisions/README.md`](doc/decisions/README.md) — architecture decision log.

## Status

Scenarios A, B and C are verified end to end against live systems, including a real
browser-recorded test session and vision-based UX findings. See
[`doc/development/status.md`](doc/development/status.md) for the full picture, including the
defects found during integration and the gaps that remain.
