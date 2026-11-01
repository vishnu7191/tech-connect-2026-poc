# API Design

Base path `/api/v1`. JSON throughout. Versioned from day one so the contract can evolve
without breaking a deployed frontend.

## Conventions

- **Long operations return `202 Accepted` with `{ jobId }`.** Discovery, execution, analysis
  and experiments never block a request; the client subscribes to the job's event stream.
- **Errors are normalized** to `{ error: { code, message, details? } }`. No stack traces, no
  secrets. `code` is a stable machine-readable string (`FIGMA_FORBIDDEN`,
  `PROVIDER_TRUNCATED`, `PLAN_NOT_APPROVED`, `INVALID_URL`).
- **Every response carries `mode: "live" | "mock"`** wherever an external system was
  involved, so the UI can badge non-live results and a mock can never masquerade as real.
- Request and response bodies are validated with the Zod schemas in `packages/shared`.

## Projects

| Method | Path | Notes |
|---|---|---|
| `POST` | `/projects` | Create. Validates and classifies the Figma URL. |
| `GET` | `/projects` | List with summary counts. |
| `GET` | `/projects/:id` | Detail incl. coverage summary. |
| `PATCH` | `/projects/:id` | Update name/description. |
| `DELETE` | `/projects/:id` | Cascades; deletes evidence files. |

## Figma discovery

| Method | Path | Notes |
|---|---|---|
| `POST` | `/figma/parse-url` | Classify + validate without creating a project. Powers live URL feedback in the new-project form. |
| `POST` | `/projects/:id/discovery` | Start discovery -> `202 { jobId }`. |
| `GET` | `/projects/:id/discovery` | Latest run: status, warnings, coverage. |
| `GET` | `/projects/:id/screens` | Discovered screens; filterable by `classification`, `reachable`. |
| `GET` | `/projects/:id/graph` | Nodes + typed edges for visualization. |
| `GET` | `/projects/:id/flows` | Independent flows / connected components. |
| `GET` | `/projects/:id/entry-points` | Confirmed and inferred, with ranking signals. |
| `POST` | `/projects/:id/entry-points/select` | Choose the entry point for exploration. |
| `GET` | `/projects/:id/coverage` | All seven dimensions with miss-lists. |

## Personas

`POST /personas` (create) · `POST /personas/generate` (AI, `202`) · `GET /personas`
(library + project-scoped) · `GET /personas/:id` · `PATCH /personas/:id` ·
`DELETE /personas/:id`.

## Test plans

| Method | Path | Notes |
|---|---|---|
| `POST` | `/projects/:id/test-plans/generate` | AI generation grounded in the real graph -> `202`. |
| `POST` | `/projects/:id/test-plans` | Create manually. |
| `GET` | `/projects/:id/test-plans` | List. |
| `GET` | `/test-plans/:id` | Detail with steps. |
| `PATCH` | `/test-plans/:id` | Edit plan and steps. |
| `POST` | `/test-plans/:id/approve` | The execution gate. |

## Execution

| Method | Path | Notes |
|---|---|---|
| `POST` | `/test-plans/:id/execute` | Refuses unless approved (or project auto-approve is on) -> `202 { jobId, executionId }`. |
| `GET` | `/executions/:id` | Status, counts, timings. |
| `GET` | `/executions/:id/actions` | Full action-by-action timeline. |
| `POST` | `/executions/:id/pause` · `/resume` · `/stop` · `/retry` | Controls. |

## Evidence

`GET /executions/:id/screenshots` · `GET /projects/:id/screenshots` (gallery) ·
`GET /screenshots/:id/file` (bytes) · `GET /executions/:id/video` (metadata) ·
`GET /executions/:id/video/file` (**range-request streaming**, required for seeking) ·
`GET /executions/:id/timeline` (actions + screenshots + video offsets joined).

## UX analysis

`POST /executions/:id/analysis` (`202`) · `GET /executions/:id/findings`
(filter by severity/category/evidence type) · `GET /projects/:id/findings` ·
`POST /projects/:id/report` (`202`) · `GET /projects/:id/report`.

## AI model management

| Method | Path | Notes |
|---|---|---|
| `GET` | `/ai/providers` | **Redacted** — no keys, no credentials. `hasApiKey: boolean` only. |
| `GET` | `/ai/tasks` | Current task -> model assignments. |
| `PUT` | `/ai/tasks/:task` | Reassign a task to a provider+model. |
| `PATCH` | `/ai/models/:providerId/:modelId` | Enable/disable. |
| `POST` | `/ai/experiments` | Run the same input across models -> `202`. |
| `GET` | `/ai/experiments` · `/ai/experiments/:id` | History and detail. |
| `POST` | `/ai/experiments/:id/rate` | Attach a human quality rating. |

## Jobs and real-time progress

| Method | Path | Notes |
|---|---|---|
| `GET` | `/jobs/:id` | Snapshot (for reconnect / initial load). |
| `GET` | `/jobs/:id/events` | **SSE** progress stream. |
| `POST` | `/jobs/:id/cancel` | Cooperative cancellation. |

SSE event shape:

```
event: progress
data: {"jobId":"...","progress":0.42,"message":"Capturing Dresses (12/35)","phase":"capture"}

event: done
data: {"jobId":"...","status":"succeeded","result":{...}}
```

A snapshot endpoint accompanies the stream so a client that connects late or reconnects can
recover current state without replaying the whole event history.

## Health

`GET /health` — process liveness. `GET /health/dependencies` — checks the Figma token, the
configured AI provider and the Playwright browser, each reported independently so a partial
outage is visible rather than being hidden behind a single boolean.
