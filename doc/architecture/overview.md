# Architecture Overview

## Shape of the system

Lenz is a **local-first monorepo**: a TypeScript backend that owns all secrets, browser
automation and AI calls, and a React frontend that is a pure consumer of the backend API.

```
lenz/
  packages/shared/     Types + Zod schemas shared by both sides (single source of truth)
  apps/server/         Fastify API, domain services, Playwright, AI, SQLite
  apps/web/            React + Vite dashboard
  config/              ai-providers.json  (centralized, env-interpolated)
  data/                SQLite db + evidence artifacts (gitignored)
  doc/                 This documentation
  tools/probe/         Live-endpoint verification scripts
```

### Why a monorepo with a shared package

Lenz's domain objects (navigation graph, coverage report, finding, execution timeline) are
elaborate and are rendered almost verbatim in the UI. Duplicating those shapes across two
repos guarantees drift. `packages/shared` holds the Zod schemas; the server validates with
them and the web app infers its TypeScript types from the same definitions, so a backend
field rename becomes a frontend compile error rather than a runtime `undefined`.

## Backend module boundaries

The server is organized by **domain capability**, not by technical layer. Each module owns its
types, services and routes; modules communicate through explicit service interfaces.

| Module | Responsibility | Must not |
|---|---|---|
| `figma/` | URL classification, REST client, document traversal, screen classification | Touch Playwright or AI |
| `graph/` | Typed navigation graph, reachability, flows, entry-point ranking, pathfinding | Perform I/O of any kind |
| `browser/` | Playwright session lifecycle, navigation, screenshots, video, Make discovery | Decide *what* to test |
| `ai/` | Provider registry, adapters, task routing, structured output, experiments | Contain feature-specific prompts beyond its task contracts |
| `personas/`, `testplans/` | Persona and plan CRUD, AI generation, approval gating | Execute anything |
| `execution/` | Orchestrates plans against the browser engine; timeline; controls | Talk to Figma REST directly |
| `analysis/` | Vision-based UX evaluation over captured evidence; findings | Capture evidence itself |
| `coverage/` | The seven coverage dimensions | Mutate domain data |
| `jobs/` | Background job queue, progress streaming, cancellation | Know domain specifics |
| `db/` | SQLite access, migrations, typed repositories | Contain business rules |
| `storage/` | Evidence file persistence behind an interface | Assume a local disk forever |

`graph/` being **pure** (no I/O) is deliberate: it is the most logic-dense part of the system
and the part most worth unit-testing exhaustively. It takes a discovered screen inventory as
input and returns a graph; it never fetches anything.

## The two-source discovery model

The central architectural idea. Lenz builds its picture of a prototype from **two
independent sources** and keeps them distinguishable forever:

| Source | Gives | Trust |
|---|---|---|
| **Figma REST** | Declared structure: frames, flows, interactions, destinations, geometry | *Intent* — what the designer wired up |
| **Playwright** | Runtime truth: what rendered, what a click actually did, pixels | *Reality* — what a user would experience |

Neither alone is sufficient. REST metadata can declare an interaction that misbehaves at
runtime; the browser alone cannot tell you a frame exists if nothing links to it. Lenz
reconciles them: REST proposes, the browser verifies, and **disagreement is a reportable
finding**, not an error to be smoothed over.

This is why the coverage model has separate *discovery* and *execution* dimensions — they
measure different sources and routinely differ.

## Job lifecycle

Discovery, execution and analysis are long-running (minutes) and must survive partial
failure, so they run as **background jobs**, never inside a request.

```
POST /api/v1/.../discover
      -> create job row (queued), return { jobId } immediately (202)
      -> worker picks it up, emits progress events
      -> client subscribes: GET /api/v1/jobs/:id/events   (SSE)
      -> terminal state persisted: succeeded | failed | cancelled
```

Properties:

- **Cancellable** — a cooperative cancellation token is checked between steps, so a stop
  request releases the browser promptly rather than after the whole run.
- **Resumable in effect** — every discovered screen/capture is persisted as it is produced,
  so a failed job leaves behind everything it had already proven.
- **Step-level failure isolation** — one unreachable screen records a reason and the run
  continues; only an unrecoverable error fails the job.

SSE was chosen over WebSockets: progress is strictly server-to-client, SSE reconnects
automatically, and it needs no extra protocol handling. See
[ADR-0005](../decisions/README.md).

## Request flow (typical)

```
React (TanStack Query)
   |  fetch /api/v1/*
   v
Fastify route  -- Zod validate --> domain service --> repository --> SQLite
                                        |
                                        +--> ai/ (provider adapter) --> NVIDIA NIM
                                        +--> browser/ (Playwright)   --> Figma
                                        +--> storage/ (evidence files)
```

Routes are thin: validate, delegate, serialize. All business rules live in services, which
keeps them testable without HTTP.

## Technology choices

| Choice | Why | Alternative rejected |
|---|---|---|
| **TypeScript** everywhere | Domain shapes are complex; types are the cheapest defence | — |
| **Fastify** | Fast, first-class schema validation, clean plugin isolation, good SSE support | Express — weaker typing and no built-in validation |
| **SQLite** (`better-sqlite3`) | Zero-config, durable, transactional, synchronous API removes a whole class of race bugs; local-first fits a single-operator tool | Postgres — operational weight unjustified for MVP |
| **Zod** | Runtime validation *and* static types from one declaration; also validates AI output | Hand-written guards |
| **Playwright** | Required by the brief; robust auto-waiting, native video recording, reliable headless Chromium | Puppeteer — weaker video/tracing story |
| **React + Vite** | Fast HMR, mature ecosystem for the data-dense UI needed here | Next.js — SSR adds no value to a local dashboard |
| **Tailwind CSS** | Consistent spacing/type scale without a parallel CSS architecture | CSS-in-JS — runtime cost, worse for a dense dashboard |
| **TanStack Query** | Server-state caching, polling and invalidation for job-driven UI | Redux — far more ceremony for mostly-server state |
| **SSE** | One-way progress, auto-reconnect, trivial to proxy | WebSockets — bidirectional machinery not needed |

## Security posture

- `config/ai-providers.json` contains **`${ENV_VAR}` placeholders only**; real keys live in
  `.env`, which is gitignored. Resolution happens once at startup and fails fast.
- The API exposes a **redacted** provider view: ids, display names, model metadata and
  capabilities — never `apiKey`, never `baseUrl` credentials.
- **SSRF defence:** browser navigation is restricted to an allow-list of Figma origins plus
  the resolved Make preview origin. Arbitrary user URLs are never opened.
- **AI output is untrusted.** Generated actions are validated against a Zod schema and
  constrained to a closed set of safe operations (click at coordinates, navigate to a known
  node id, scroll, wait, type synthetic text). The model can never supply raw JavaScript or
  an arbitrary URL.
- **Prototype text is untrusted input** and is never interpolated into a prompt in a way that
  lets it issue instructions; it is passed as clearly delimited data.
- Errors crossing the API boundary are normalized — no stack traces, no secrets.

## Mock vs live mode

Every AI and Figma integration reports its mode in the response envelope and in logs. The UI
renders a persistent badge when any part of a result came from a mock. Mocks exist for unit
tests and offline development only; a mocked result is never presented as a live one.
