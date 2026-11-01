# Development Guide

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | >= 20.10 | Verified on 20.20.2. Native `fetch` is required. |
| npm | >= 10 | Workspaces. |
| Chromium (Playwright) | installed via CLI | `npx playwright install chromium` |
| OS | Windows / macOS / Linux | Developed and verified on Windows 11. |

## Install

```bash
npm install
npx playwright install chromium
```

## Environment configuration

Copy `.env.example` to `.env` at the repository root and fill in real values. **`.env` is
gitignored and must never be committed.**

| Variable | Required | Purpose |
|---|---|---|
| `NVIDIA_API_KEY` | yes | Resolves `${NVIDIA_API_KEY}` in `config/ai-providers.json`. |
| `FIGMA_ACCESS_TOKEN` | yes for REST discovery | Figma personal access token. Without it, Lenz falls back to browser-only discovery and says so. |
| `PORT` | no (default `4000`) | Backend port. |
| `NODE_ENV` | no (default `development`) | |
| `DATA_DIR` | no (default `./data`) | SQLite file + evidence artifacts. |
| `HEADLESS` | no (default `true`) | Set `false` to watch the browser drive the prototype. |
| `LOG_LEVEL` | no (default `info`) | pino level. |

Startup **validates the environment and fails fast** with a precise message if an enabled
provider's key placeholder cannot be resolved — Lenz refuses to boot half-configured rather
than failing on the first AI call.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Backend (watch) + frontend (Vite) together. |
| `npm run dev:server` | Backend only, on `PORT`. |
| `npm run dev:web` | Frontend only, proxying `/api` to the backend. |
| `npm run build` | Type-check and build all workspaces. |
| `npm test` | Unit + integration tests (Vitest). |
| `npm run test:watch` | Watch mode. |
| `npm run typecheck` | Type-check without emitting. |
| `npm run verify:live` | **Live** probes against Figma + NVIDIA. Requires real credentials; makes real network calls. |

## Live verification probes

`tools/probe/` holds the scripts used to establish the facts in
[external-verification.md](../findings/external-verification.md). They hit real endpoints and
are intentionally kept out of the unit test suite so that `npm test` stays fast, offline and
deterministic.

```bash
node tools/probe/probe-proto.mjs <output-dir>   # prototype renders headless
node tools/probe/probe-nav.mjs   <output-dir>   # URL + click navigation, destination verify
node tools/probe/probe-make.mjs  <output-dir>   # Figma Make iframe discovery
```

## Testing strategy

| Layer | Approach |
|---|---|
| **Pure logic** (URL parsing, screen classification, graph algorithms, entry-point ranking, coverage math) | Unit tests, no I/O, no mocks needed. This is where the density of tests is highest because it is where the hard logic lives. |
| **Figma REST client** | Tested against **recorded real fixtures** captured from the live Rosella file, so parsing is verified against real payload shape rather than an invented one. |
| **AI adapters** | Unit-tested against recorded real NIM responses — including the `finish_reason: "length"` truncation case and the `reasoning_content` shape. |
| **Browser engine** | Integration tests against the live prototype, marked `live` and excluded from the default run. |
| **API routes** | Fastify `inject()` with an in-memory SQLite database. |

**Mock discipline.** Mocks are used only to isolate units. A mocked result is tagged
`mode: "mock"` end to end, and no test that uses a mock is permitted to assert that a live
integration succeeded. Where this document or the status report claims a live integration
works, it was verified with a real call.

## Troubleshooting

**`curl` fails against `integrate.api.nvidia.com` with `CRYPT_E_NO_REVOCATION_CHECK`** — a
Windows schannel certificate-revocation issue on corporate networks. Node's `fetch` uses its
own CA bundle and works. Diagnose through Node, not curl.

**Figma discovery returns 403/404** — the token cannot read that file. Lenz continues with
browser-only discovery and reports the limitation; it does not fail the run.

**Screenshots are blank** — the Figma viewer needs time to paint. The capture pipeline
already retries with longer settle windows; persistent blankness is recorded as
`blank-screenshot` rather than passed off as a valid capture.

**Prototype screenshots contain a cookie banner** — banner dismissal runs before the first
capture; if Figma changes the banner markup, update the selector list in the browser module.

## Known limitations

- Figma **variables and conditional logic** are detected and reported as unsupported, not
  evaluated. A prototype relying on them will show interactions marked `unsupported` with
  that reason.
- `AFTER_TIMEOUT` and `DRAG` triggers are discovered and reported but not executed.
- Scenario D (`/design/` URLs) yields structural discovery only — there are no prototype
  flows to traverse.
- Single-process job worker; no distributed execution.
- No authentication or multi-tenancy — Lenz is a local, single-operator tool for now.
