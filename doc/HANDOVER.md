# Session Handover — read this first

**Purpose:** bring a brand-new session up to speed in a few minutes, with no access to any
previous conversation.

**Last updated:** 2026-11-01 · Branch `dev` · ~117 files uncommitted (intentionally — the
user pushes manually)

---

## 1. What this project is

**Lenz UX Validation Engine.** A user pastes a Figma URL. Lenz discovers the screens and the
real navigation structure, generates synthetic personas, writes test plans grounded in that
structure, executes them in a real browser, records the session on video, and reports UX
findings backed by screenshots.

It is a **working application**, not a prototype. Scenarios A, B and C are verified end to end
against live systems.

```
Figma URL → classify → discover (REST + browser) → typed graph → coverage
          → personas → test plans → approval gate → autonomous execution
          → screenshots + video → vision UX analysis → report
```

Full picture with diagrams: [`high-level-workflow/README.md`](high-level-workflow/README.md).

## 2. Orientation in 60 seconds

```
packages/shared/   Zod schemas + types shared by server and web (single source of truth)
apps/server/       Fastify API, domain services, Playwright, AI, SQLite
  src/figma/       URL parsing, REST client, payload validation, extraction, classification
  src/graph/       Pure graph algorithms (no I/O) — the most test-dense module
  src/browser/     Playwright sessions, capture/verify, viewer guards, access probe
  src/ai/          Provider config, adapter, AiService (the only AI entry point)
  src/services/    discovery, personas, testplans, execution, analysis, coverage
  src/jobs/        Background queue + SSE progress
apps/web/          React 18 + Vite + Tailwind + TanStack Query (9 pages)
config/            ai-providers.json — centralized, ${ENV_VAR}-interpolated
doc/               All documentation (start at doc/README.md)
tools/probe/       Live verification scripts (see tools/probe/README.md)
data/              SQLite + evidence + Figma cache — GITIGNORED
```

## 3. Run it

```bash
npm install
npx playwright install chromium
cp .env.example .env     # fill in NVIDIA_API_KEY and FIGMA_ACCESS_TOKEN
npm run dev              # server :4000, web :5173
```

| Command | Purpose |
|---|---|
| `npm test` | 122 unit tests — fast, offline, deterministic |
| `npm run build` | Typecheck + build all three workspaces |
| `npm run verify:live` | Real calls to Figma + NVIDIA (needs credentials) |

**Windows notes:** Vite binds to `localhost` (IPv6) — use `http://localhost:5173`, not
`127.0.0.1`. The server binds `127.0.0.1:4000`. `curl` cannot reach
`integrate.api.nvidia.com` on this host (`CRYPT_E_NO_REVOCATION_CHECK`); **Node's `fetch`
works** — diagnose through Node, never curl.

## 4. The five ideas that explain most of the codebase

1. **Typed edges.** Of 1250 interactions in the reference file, only 416 are real screen
   transitions; 746 are component variant swaps. Only `NAVIGATE` affects reachability.
   Collapsing them would be wrong 59% of the time. (ADR-0001)
2. **Screens are classified, not assumed.** 63 of 116 top-level nodes are design-system
   components. A scoring classifier decides, and persists *why* so it is auditable. (ADR-0002)
3. **Two sources, never merged.** Figma REST = what the designer *wired*. Playwright = what a
   user *experiences*. Disagreement is a finding, not an error. (ADR-0003)
4. **URL node-id is ground truth.** After a click, the viewer URL names the frame actually
   reached, so "did this interaction work?" is a cheap deterministic assertion. (ADR-0004)
5. **Honest reporting is enforced in code.** Seven coverage dimensions tracked separately;
   100% only when the miss-list is empty; a finding can be `observed` only if it links to a
   validated screenshot; there is deliberately **no overall UX score**.

## 5. Hard-won gotchas — do not relearn these

| Gotcha | Consequence if forgotten |
|---|---|
| **Never declare a named function inside `page.evaluate()`** | esbuild (via `tsx`) rewrites it with a `__name` helper that does not exist in the browser → `ReferenceError: __name is not defined`. Cost a silent, empty Make discovery run. Inline everything. |
| **Never swallow errors with a bare `catch {}`** | That `__name` crash was invisible for exactly this reason. Log it. |
| **Figma returns `actions: [null]`** | A trigger wired with no destination. 9 of 76 in one real file. Crashed discovery. Treated now as a *dead interaction* and reported. |
| **Figma 404 ≠ "does not exist"** | It returns 404 for inaccessible files too. Never claim "denied"; `browser/access.ts` probes anonymously to find the real cause. |
| **NVIDIA does not validate `max_tokens`** | 200k and 262k are "accepted" but prove nothing. Only trust values seen to work end to end. |
| **Reasoning models eat the output budget** | With `max_tokens: 4096` a call returned `content: null`, `finish_reason: length`. The adapter retries with a larger budget. |
| **A schema is not instructions** | Terse prompt + `json_schema` produced schema-valid garbage. Every field must be described in the prompt text. |
| **Don't use `scaling=contain`** on prototype URLs | Shrinks a 1440×5446 page to an unreadable thumbnail — useless as vision input. |
| **Dismiss Figma banners before *every* capture** | They reappear after navigation and end up baked into screenshots. |
| **Figma file-read quota is long** | A `retry-after` of ~109 h was observed. The 6-hour on-disk document cache is what keeps development working. |
| **Heredocs mangle backticks/`${}`** in this shell | Use the Write tool for files containing template literals or markdown. |

## 6. Working agreements

- **Verify, don't assume.** Every capability flag, token limit and behaviour claim in this repo
  was measured against the live service. If you add a model or provider, run
  `tools/probe/nim-audit.mts` first.
- **Never claim something works without running it.** `doc/development/status.md` distinguishes
  *Verified* (executed, result inspected) from *Built* (compiles only).
- **Report gaps honestly.** Coverage misses carry machine-readable reasons. Do not let a
  number reach 100% while something failed.
- **Secrets stay in `.env`** (gitignored). `config/ai-providers.json` holds `${ENV_VAR}`
  placeholders only; a literal key there is rejected at startup.
- **Do not commit or push.** The user does this manually. Make changes and report.
- **Do not add dependencies casually.** Check `npm audit --omit=dev` after any install.

## 7. Current state

**Verified end to end:** Scenario A (prototype with start node), Scenario B (no start node),
Scenario C (Figma Make), discovery → personas → test plans → approval → execution → video →
vision analysis, and Model Lab comparison.

**Known gaps:**
- Pause/resume/stop are implemented and wired, but never exercised mid-run.
- Scenario D (`/design/` links) does structural discovery only; untested against a real
  design-only file.
- FigJam `/board/` and Slides `/slides/` are recognised and structurally readable, but their
  node models were never tested against real files.
- `npm run verify:live` currently reports **10 passed, 1 failed** — the failure is the Figma
  file-read quota (external, resets ~Nov 5). Discovery still works from cache.
- Branch URLs (`?branch-id=`) are parsed but Lenz reads the main file, not the branch.

Authoritative detail: [`development/status.md`](development/status.md).

## 8. Where to look for what

| Question | Document |
|---|---|
| How does the whole thing work? | [`high-level-workflow/`](high-level-workflow/README.md) |
| What was actually measured about Figma/NIM/Playwright? | [`findings/external-verification.md`](findings/external-verification.md) |
| Why is it built this way? | [`decisions/README.md`](decisions/README.md) (8 ADRs) |
| What breaks and how is it handled? | [`architecture/failure-modes.md`](architecture/failure-modes.md) |
| What works right now? | [`development/status.md`](development/status.md) |
| How do I run/debug something? | [`development/setup.md`](development/setup.md), [`../tools/probe/README.md`](../tools/probe/README.md) |

## 9. Keep this current

When you finish meaningful work, update:

1. `doc/development/status.md` — what became Verified, what defects were found
2. `doc/architecture/failure-modes.md` — any new failure class
3. `doc/decisions/README.md` — any significant architectural decision, with the reasoning
4. This file — if the orientation above stops being true

Documentation that lies is worse than none. If you could not verify something, say so.
