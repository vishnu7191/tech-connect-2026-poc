# Figma Discovery and the Navigation Graph

All numbers quoted here were measured against the live Rosella file — see
[external-verification.md](../findings/external-verification.md).

## 1. URL classification

`figma/url.ts` parses any Figma URL into a discriminated union before anything else happens.

| Pattern | Kind | Strategy |
|---|---|---|
| `figma.com/proto/<key>/<name>` | `proto` | REST discovery + browser verification |
| `figma.com/make/<key>/<name>` | `make` | Browser-only state discovery |
| `figma.com/design/<key>/<name>` | `design` | REST structural discovery; no prototype flows |
| `figma.com/file/<key>/<name>` | `file` | Legacy alias of `design` |

Extracted: `fileKey`, `startNodeId` (normalized `1-2` -> `1:2`), `pageId` (`?page-id=`),
plus Make-specific `codeNodeId`. A URL that is not a recognised Figma host is rejected — this
is also the SSRF gate, so classification is security-relevant, not merely cosmetic.

**`node-id` is optional by design.** Its absence selects the Scenario B path; it is never an
error.

## 2. REST discovery

Endpoints used:

| Endpoint | Purpose |
|---|---|
| `GET /v1/files/:key` | Full document — the only way to reach deep `interactions` |
| `GET /v1/files/:key?depth=2` | Cheap structural probe (canvases + top-level children) |
| `GET /v1/images/:key?ids=...` | Design reference renders (never presented as browser screenshots) |
| `GET /v1/me` | Token validation at startup |

The full Rosella document is **8.67 MB**; it is fetched **once per discovery run** and cached
on the project. Interaction data lives on deep descendants, so `depth`-limited responses
cannot be used for graph construction — only for fast previews.

**Degradation.** `403`/`404` means the token cannot read the file. That is reported as an
explicit, named limitation and the run continues with browser-only discovery; it is never a
silent empty result.

## 3. Screen classification — why "frame" is not "screen"

The naive rule *every top-level child of a canvas is a screen* is wrong. On Rosella's
*Mockup* canvas, a large share of the 102 top-level children are `COMPONENT_SET` nodes:
`Heart`, `XS`, `Add to bag`, `ei:arrow-left`, `Quantity`. These are design-system parts, and
counting them as screens would roughly double the reported screen count and corrupt every
coverage percentage downstream.

`figma/classify.ts` scores each top-level node:

| Signal | Effect |
|---|---|
| `type` is `COMPONENT_SET` | Strong **negative** — a variant container, not a screen |
| `type` is `FRAME` / `COMPONENT` / `INSTANCE` | Eligible |
| Width matches a known device class (~390 mobile, ~1440 desktop, tablet) | Strong **positive** |
| Very small area (icon/control scale) | Strong negative |
| Is a declared flow starting point | **Decisive positive** — always a screen |
| Is the target of a `NAVIGATE` edge | Strong positive — something navigates *to* it |
| Name matches component-ish patterns (`icon`, `button`, `arrow`, variant syntax) | Negative |

Each screen records `classification: screen | component | ambiguous` with the reasons that
produced it, so a user can audit and override the decision rather than trusting a black box.

## 4. The typed graph model

**The most important design decision in Lenz.** Rosella's 1250 interaction actions break down
as 740 `CHANGE_TO`, 435 `NAVIGATE`, 41 `OVERLAY`, 8 `SWAP`, 6 `SCROLL_TO`. Treating them all
as screen transitions would be wrong for **59%** of them.

Edges are therefore typed by their Figma `navigation` mode:

| Figma mode | Lenz edge kind | Graph meaning |
|---|---|---|
| `NAVIGATE` | `screen` | Screen A -> screen B. **The only kind that affects reachability.** |
| `OVERLAY`, `SWAP` | `overlay` | Pushes an overlay state onto the current screen |
| `CHANGE_TO` | `ui-state` | Component variant swap — stays on the same screen |
| `SCROLL_TO` | `ui-state` | Scroll within the current screen |

A node therefore carries both a **screen identity** and a set of reachable **UI states**.
This is what makes section 6 of the brief tractable: component variants, overlays and scroll
targets are real, trackable states, but they do not pollute screen-level reachability.

Every edge also retains its `trigger` (`ON_CLICK`, `ON_HOVER`, `AFTER_TIMEOUT`, `DRAG`,
`ON_PRESS`), the **source node's absolute geometry** (needed to compute where to click), and
whether Lenz can execute it. `AFTER_TIMEOUT` and `DRAG` are recorded as discovered-but-
`unsupported` with a stated reason rather than being dropped.

Edges are resolved to **top-level owning screens**: an interaction fires on a deep descendant
(a button inside a card inside a frame), so the engine walks up to the owning top-level node
to place the edge, while keeping the originating node id for click targeting.

## 5. Entry points — confirmed vs inferred

Lenz **never assumes the first frame is the start.**

**Confirmed entries** (from Figma itself):
- `canvas.prototypeStartNodeID` — Rosella *Mockup*: `1:2`
- `canvas.flowStartingPoints[]` — Rosella *Mockup*: 5 flows (Home, Details, Login, policy,
  Home_Phone)

**Inferred candidates** — computed only where confirmed entries do not cover the graph, and
always labelled `inferred`. Ranking signals:

| Signal | Rationale |
|---|---|
| In-degree of 0 on `screen` edges | Nothing navigates to it, so it is a plausible origin |
| Out-degree > 0 | It leads somewhere — an entry should start a journey |
| Name heuristics (`home`, `landing`, `splash`, `login`, `start`) | Weak but real signal |
| Canvas position (top-left-most) | Designers order flows left-to-right, top-to-bottom |
| Device-class width | Separates desktop and mobile flow origins |
| Size of the component reachable from it | A candidate opening a large subgraph outranks a dead end |

The Rosella *Wireframe* canvas is the live Scenario B case: `prototypeStartNodeID: null`,
`flowStartingPoints: []`, 14 frames. Those frames are discovered, classified as disconnected,
ranked as candidates, and surfaced for the user to choose — **never discarded**.

## 6. Graph analysis

Implemented in pure functions over the graph (no I/O), so they are directly unit-testable:

- **Reachability** — BFS over `screen` edges from each entry point; a screen reachable from
  *any* confirmed entry is reachable.
- **Weakly connected components** — identifies genuinely independent flows and the
  disconnected set.
- **Shortest path** — BFS gives the cheapest click-path to a target screen, used by the
  execution engine so a test step can jump a persona to a required starting state.
- **Loop prevention** — traversal state is `(screenId + uiStateSignature)`, so revisiting a
  screen in a *different* UI state is legitimate progress while a true cycle is cut.
- **Multiple paths** — retained; the shortest is used for execution, alternatives are
  reported as redundancy evidence.

## 7. Discovery report

Every run emits a report that names each omission:

```
screensDiscovered     40      componentsExcluded   62
screensReachable      35      disconnected          5
interactionsFound    435      unsupported           4   (DRAG, AFTER_TIMEOUT)
entryPoints            5 confirmed, 3 inferred
warnings             [ "Wireframe canvas declares no starting point", ... ]
```

Each unreachable screen carries a machine-readable reason (`no-incoming-navigate-edge`,
`unsupported-trigger-only`, `api-inaccessible`, `render-failed`), which is what allows the UI
to explain a gap instead of showing an unexplained shortfall.
