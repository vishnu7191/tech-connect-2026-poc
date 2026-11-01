# Implementation Status

**Last updated:** 2026-10-31

This is the honest record of what exists, what has been *verified by running it*, and what
remains. Nothing here is marked working on the strength of code existing alone.

Legend: **Verified** = executed against live systems and the result inspected ·
**Built** = implemented and type-checked, not yet exercised end to end · **Not started**.

---

## Milestone status

| # | Milestone | Status |
|---|---|---|
| 1 | Foundation (monorepo, DB, config, AI abstraction, projects) | **Verified** |
| 2 | Figma discovery (URL classification, REST, graph, entry points) | **Verified** |
| 3 | Browser verification (Playwright, capture, validation) | **Verified** |
| 4 | Personas and test plans | **Verified** |
| 5 | Autonomous execution | **Verified** |
| 6 | Recap Test (full video recording) | **Verified** |
| 7 | UX analysis (vision findings) | **Verified** |
| 8 | Model Lab (switching, comparison, history) | **Built**; task routing and provider views verified, multi-model comparison not run (see gaps) |
| 9 | End-to-end integration | **Verified** for Scenarios A, B and C |

## What was actually executed

A full workflow was run against the live Rosella prototype and the live Figma Make app.

### Scenario A and B — Rosella prototype (`TJEIgarZebWrehJFEFycYw`)

```
screens discovered     53          components excluded    63
ambiguous               5          reachable              31
disconnected           15          flows                  16
interaction actions  1250          screen edges          416
ui-state edges        746          overlay edges          49
unsupported            21
entry points            5 confirmed / 22 inferred
```

Coverage as reported by the product (each dimension independent, with miss-lists):

| Dimension | Value | Note |
|---|---|---|
| designDiscovery | 48/53 (90.6%) | 5 ambiguous; 63 components excluded by design |
| reachability | 31/53 (58.5%) | 22 misses, each with a reason |
| interactionDiscovery | 1190/1250 (95.2%) | 21 unsupported triggers |
| screenshotCapture | 5/5 | with the note "47 screen(s) were not attempted in this run" |

Both URL forms were exercised. With no `node-id`, discovery still succeeded and produced 5
confirmed entry points plus 22 ranked candidates, and the Wireframe canvas (which declares no
starting point at all) was reported as a warning rather than silently dropped.

### Execution, video and analysis — verified

A generated plan for persona *Maya Tran* ("find a linen dress and add it to the cart") was
approved and executed. The approval gate was confirmed to block execution before approval
(`PLAN_NOT_APPROVED`).

Result: 6 actions, 3 navigations, **a 9.8 MB / 59 s Playwright video**, and this timeline:

| # | Action | Verdict | Decided by |
|---|---|---|---|
| 0 | Open "Home" | match (`1:2`) | system |
| 1 | Tap Dresses category | **match** (`145:61`) | figma-metadata |
| 2 | Scan titles and prices | n/a | plan-step |
| 3 | Click "Add to cart" | reached `80:18` (Details) | figma-metadata |
| 4 | Open Shopping Bag | **no-navigation** (failed) | figma-metadata |
| 5 | Verify cart badge | n/a | plan-step |

Vision analysis over the captured screenshots produced 5 findings, all evidence-linked,
including two the model could only have reached by genuinely reading the images:

- Prices are shown in **Rs** while the persona's goal was "under £80" — makes the budget
  comparison impossible.
- The chosen product's Details screen reads **"Fabric: Recycled polyester"**, contradicting
  the "linen dress" requirement.
- Plus a deterministic, non-model finding generated directly from the execution fact that the
  Shopping Bag click produced no navigation.

### Scenario C — Figma Make — verified

11 distinct UI states discovered by DOM-signature hashing, 40 interactive elements, 10 state
transitions, 11 valid screenshots. Exploration clicked through Personas, Test plan, Live run,
Session replay, Heatmaps, Accessibility, Findings, Design fixes and Report.

### AI provider layer — verified live (11/11 checks)

`npm run verify:live` passes: config loads and resolves `${ENV_VAR}`, the public view contains
no credentials, every task resolves to a model, text completion works, structured output
validates against a Zod schema, vision works, the capability guard blocks vision on a
text-only model *before* any network call, and reasoning-model truncation is retried and
recovered.

## Defects found and fixed during integration

These were all found by running the system, not by reading it:

| Defect | Resolution |
|---|---|
| Cookie banner appeared in every screenshot after the first navigation | Banner dismissal was latched by a one-shot flag; now runs before every capture, using a fast `count()` check |
| `scaling=contain` shrank a 1440x5446 page to an unreadable thumbnail | Dropped the parameter; the viewer's default fits to width, restoring full-size captures (462 KB vs 132 KB) |
| Blankness threshold rejected genuinely sparse screens | Re-calibrated against a measured solid-fill floor (0.00458 bpp) and split into `blank` vs `sparse`, so thin evidence is flagged rather than failed |
| Figma 429 rate limit from repeated 8.67 MB fetches | Added a 6-hour on-disk document cache |
| Test-plan generation failed with `finish_reason: length` | The brief's example `maxOutputTokens: 4096` was too small for a reasoning model; verified the endpoint accepts up to 131072 and raised it. The adapter now also reports clearly when the budget is already at the model ceiling |
| `llama-3.1-nemotron-70b-instruct` returns 404 for this account although `/v1/models` lists it | Disabled in config with the reason recorded, rather than offered as a broken option |
| Figma Make app stuck on its loading screen | The SSRF allow-list blocked `cdnjs.cloudflare.com`. Split into document navigation (Figma only) vs subresources (plus a CDN allow-list) |
| Make discovery returned 0 states **with no warning** | Two causes: an esbuild `__name` helper crashed the `page.evaluate` body (named inner functions are not safe there under tsx), and the error was swallowed by a bare `catch`. Both fixed, plus an explicit warning when a run yields nothing |
| Navigation graph was an unreadable squashed blob | Replaced canvas-coordinate layout with a layered layout by navigation depth |
| Known vulnerabilities in `fastify`, `@fastify/static`, `playwright`, `zod`, `react-router` | Upgraded; remaining advisories are moderate and transitive through Playwright's dev tooling only |
| **`Cannot read properties of null (reading 'type')` on a user-supplied prototype** | Figma returned `{"trigger":{"type":"ON_CLICK"},"actions":[null]}` — 9 of 76 actions were null. Now counted as *dead interactions*, reported as a warning and a coverage miss. See [failure-modes.md](../architecture/failure-modes.md) |
| Raw `TypeError` text shown to the end user | `toUserFacingError()` normalizes any non-`AppError` into a job-specific explanation; stacks go to the log only |
| `interactionDiscovery` showed 88.2% with an **empty** miss-list | Dead interactions now appear as misses with reason `no-destination-configured`, so the shortfall is explained |
| Only 4 Figma link types recognised | All of `/proto/`, `/design/`, `/file/`, `/make/`, `/board/`, `/slides/`, `/deck/` classified with a support level; community links, the Figma home page, embed wrappers, scheme-less and name-less links all handled with actionable messages |
| A private prototype would have been screenshotted as a real screen | `detectViewerBlock()` detects sign-in walls, permission errors and deleted files — and only fires when the prototype canvas is absent, so login-screen *designs* are not false positives |

## Tests

122 unit tests pass via **npm test**. Density is highest exactly where untrusted data enters
the system:

| Suite | Tests | Covers |
|---|---|---|
| url.test.ts | 51 | Every Figma link type, real-world link shapes, malformed input, SSRF |
| analyze.test.ts | 29 | Typed-edge graph, reachability, pathfinding, flows, entry-point ranking |
| validate.test.ts | 12 | Malformed and partially-damaged Figma documents |
| classify.test.ts | 11 | Screen classification, pinned against **real captured Rosella nodes** |
| capture.test.ts | 11 | Blankness calibration from measured values, coordinate mapping |
| extract.test.ts | 8 | The real null-action payload shape and null-tolerance |

Live integration checks live in tools/probe/ and **npm run verify:live**, deliberately
separate so the unit suite stays fast, offline and deterministic.

## Known gaps and limitations

**Not yet exercised end to end**

- **Model Lab comparison across two models.** The API, job and UI exist and task reassignment
  works, but a real side-by-side run was not executed: only one vision-capable model is
  reachable on this account (`llama-3.1-nemotron-70b-instruct` 404s, and
  `nemotron-3.5-lightning` is flagged text-only pending verification). A comparison needs two
  usable models.
- **Pause / resume / stop controls.** Implemented and wired to the UI, but not exercised
  mid-run; executions so far completed faster than a manual interrupt.
- **Scenario D** (`/design/` URLs) is implemented as structural discovery only and was not run
  against a real design file.

**By design**

- Figma **variables and conditional logic** are detected and reported as unsupported, not
  simulated. `AFTER_TIMEOUT` and `DRAG` triggers are discovered but not executed.
- Text entry inside a Figma prototype viewer is recorded as `skipped` — the viewer has no real
  inputs.
- No overall "UX score" is published. The report states this explicitly and gives severity
  counts, evidence quality and coverage instead.
- Single-process job worker; no authentication, multi-tenancy, or distributed execution.

**Operational notes**

- **Figma file-read quota is currently exhausted for the supplied token.** Repeatedly fetching
  the 8.67 MB Rosella document during development triggered a long rate limit: `/v1/me` still
  returns 200, but file endpoints return 429 with `retry-after` ≈ 393,000 s (~109 h, resetting
  2026-11-05). This is external quota state, not a defect. Two things follow:
  - `npm run verify:live` currently reports **10 passed, 1 failed**, the failure being the
    uncached shallow-metadata probe. Full discovery still passes because it is served from the
    on-disk document cache — which is precisely why that cache exists.
  - The client now detects a long `retry-after`, stops retrying immediately rather than
    backing off pointlessly, and reports when access returns.
- `curl` cannot reach `integrate.api.nvidia.com` on this Windows host
  (`CRYPT_E_NO_REVOCATION_CHECK`); Node's `fetch` works. Diagnose through Node.
- Do not declare named functions inside a `page.evaluate` body: esbuild (via `tsx`) rewrites
  them with a `__name` helper that does not exist in the browser context.

## Next steps

1. Verify `nemotron-3.5-lightning` capabilities and run a real two-model comparison.
2. Exercise pause/resume/stop against a longer execution.
3. Broaden capture beyond the current per-run cap so screenshot coverage can approach the full
   screen inventory.
4. Add API-level route tests using Fastify `inject()` with an in-memory database.
5. Run Scenario D against a real `/design/` file.
