# How Lenz Works

Start here. This page explains the whole system in plain language, with simple pictures.
Technical detail comes later — skip to [Part 2](#part-2--technical-detail) only if you need it.

---

## Part 1 — The simple version

### In one sentence

> You paste a Figma link. Lenz pretends to be a user, clicks through your prototype in a real
> browser, and tells you where that user got stuck — with screenshots proving it.

### The seven steps

```mermaid
flowchart LR
    A("1·Paste a<br/>Figma link"):::s --> B("2·Find all<br/>the screens"):::s --> C("3·Map how they<br/>connect"):::s --> D("4·Create<br/>test users"):::s --> E("5·Write<br/>test plans"):::s --> F("6·Run them in a<br/>real browser"):::s --> G("7·Read the<br/>UX report"):::g
    classDef s fill:#EEF2FF,stroke:#6366F1,stroke-width:2px,color:#1E1B4B,font-size:15px
    classDef g fill:#DCFCE7,stroke:#16A34A,stroke-width:2px,color:#052E16,font-size:15px
```

| Step | What happens | In plain words |
|---|---|---|
| **1** | Paste a Figma link | Lenz checks the link is one it can open, and tells you what it will be able to do with it |
| **2** | Find all the screens | Reads your design file and works out which frames are real screens and which are just buttons and icons |
| **3** | Map how they connect | Works out which button leads to which screen — the "map" of your prototype |
| **4** | Create test users | Invents realistic people: a confident shopper, a hesitant first-timer, someone with low tech confidence |
| **5** | Write test plans | For each person, writes a task to attempt — "find a dress and add it to the cart" — using only screens that really exist |
| **6** | Run them in a real browser | Actually opens your prototype and clicks through it, taking screenshots and recording video |
| **7** | Read the UX report | Lists the problems it hit, each linked to the screenshot that proves it |

### Who does the actual work

Lenz itself is the coordinator. Three outside systems do the heavy lifting:

```mermaid
flowchart TD
    U("YOU<br/>paste a Figma link"):::you --> L
    L("LENZ"):::lenz
    L --> F("FIGMA API<br/>reads the design file:<br/>screens, buttons, where<br/>each button should go"):::ext
    L --> B("REAL BROWSER<br/>opens the prototype,<br/>clicks it, takes screenshots,<br/>records video"):::ext
    L --> A("AI MODEL<br/>invents test users,<br/>writes test plans,<br/>looks at screenshots"):::ext
    F --> R("UX REPORT<br/>problems found, each with<br/>a screenshot proving it"):::out
    B --> R
    A --> R
    classDef you fill:#FEF3C7,stroke:#D97706,stroke-width:2px,color:#451A03,font-size:15px
    classDef lenz fill:#EDE9FE,stroke:#7C3AED,stroke-width:3px,color:#2E1065,font-size:17px
    classDef ext fill:#EFF6FF,stroke:#3B82F6,stroke-width:2px,color:#172554,font-size:14px
    classDef out fill:#DCFCE7,stroke:#16A34A,stroke-width:2px,color:#052E16,font-size:15px
```

| System | Its job | Why it is needed |
|---|---|---|
| **Figma API** | Reads the design file | Tells us what *should* happen when a button is clicked |
| **Real browser** (Playwright) | Drives the prototype | Tells us what *actually* happens |
| **AI model** (NVIDIA NIM) | Thinks like a user | Invents people, writes tasks, and looks at screenshots to spot problems |

**The key trick:** Figma says what *should* happen. The browser shows what *does* happen.
When those two disagree, that disagreement **is** the bug.

### A real example

This is an actual run against a real e-commerce prototype:

```
1.  Pasted the Figma link
2.  Found 53 screens  (and correctly ignored 63 buttons/icons that aren't screens)
3.  Mapped 416 real screen-to-screen links
4.  Created "Maya Tran" — a confident online shopper
5.  Wrote her a task: "find a linen dress and add it to the cart"
6.  Ran it in a browser: 6 actions, 59 seconds of video

7.  REPORT:
    CRITICAL  Clicking the Shopping Bag does nothing — Maya cannot reach her cart
    HIGH      Prices shown in "Rs" but Maya's budget is in "£" — she can't compare
    MEDIUM    The dress she picked is polyester, not the linen she wanted
```

Those last two came from the AI **reading the screenshots** — it saw "Rs. 2,000" on the page
and "Fabric: Recycled polyester" on the product page. The first came from the browser
genuinely clicking and genuinely going nowhere.

### What makes it trustworthy

| Principle | What it means for you |
|---|---|
| **Every finding has evidence** | If there's no screenshot, it can't be labelled "observed" |
| **It admits what it missed** | "31 of 53 screens reachable" — and *why* each of the other 22 wasn't |
| **No made-up score** | No "UX score: 72/100". A score needs a proven method; we don't have one, so we don't invent one |
| **It won't run without your OK** | Test plans must be approved before anything executes |

---

## Part 2 — Technical detail

Everything below is for people working on the code.

### The full flow, including failures

```mermaid
flowchart TD
    A["User pastes a Figma URL"] --> B{"URL classification<br/>figma/url.ts"}

    B -->|"not figma.com / community /<br/>bad key / unknown type"| BX["Rejected with an<br/>actionable message"]
    B -->|"/proto/ /design/ /file/<br/>/board/ /slides/ /deck/"| C["REST discovery path"]
    B -->|"/make/"| M["Browser discovery path"]

    C --> C1{"FIGMA_ACCESS_TOKEN<br/>present?"}
    C1 -->|no| CX["Degrade: browser-only<br/>+ explicit warning"]
    C1 -->|yes| C2["GET /v1/files/:key<br/>figma/client.ts (cached 6h)"]

    C2 -->|"403 / 404"| P["Browser access probe<br/>browser/access.ts"]
    P -->|"sign-in wall"| PX["STOP: 'This file is private'<br/>+ how to fix"]
    P -->|"not found"| PX2["STOP: 'Check the link'"]
    P -->|"renders publicly"| CX

    C2 -->|200| V["Validate document shape<br/>figma/validate.ts"]
    V --> E["Extract screens + interactions<br/>figma/extract.ts"]
    E --> G["Build typed navigation graph<br/>graph/analyze.ts"]
    G --> BR["Browser verification<br/>browser/capture.ts"]

    M --> M1["Resolve preview iframe<br/>(*.figma.site)"]
    M1 --> M2["Wait for hydration,<br/>discover controls, click safely"]
    M2 --> M3["Hash DOM signature<br/>= UI state identity"]
    M3 --> BR

    BR --> COV["Coverage: 7 independent<br/>dimensions + miss-lists"]
    COV --> PER["Personas<br/>(manual or AI)"]
    PER --> TP["Test plans<br/>grounded in the real graph"]
    TP --> AP{"Approved?"}
    AP -->|no| APX["Execution refused<br/>PLAN_NOT_APPROVED"]
    AP -->|yes| EX["Autonomous execution<br/>services/execution.ts"]

    EX --> EV["Evidence: screenshots,<br/>full session video, timeline"]
    EV --> AN["Vision UX analysis<br/>services/analysis.ts"]
    AN --> REP["Findings + coverage report"]
```

### Stage by stage

| # | Stage | Module | Tool | Output |
|---|---|---|---|---|
| 1 | URL classification | `figma/url.ts` | Pure TS + WHATWG `URL` | Link kind, file key, start node, support level. Also the **SSRF gate** |
| 2 | Access check (on REST failure) | `browser/access.ts` | Playwright (anonymous) | `public-renders` / `requires-sign-in` / `not-found` |
| 3 | REST discovery | `figma/client.ts` | Figma `GET /v1/files/:key` | Full document (~8.7 MB), cached 6 h |
| 4 | Payload validation | `figma/validate.ts` | Pure TS guards | Usable canvases, or a readable error |
| 5 | Extraction | `figma/extract.ts` | Bounded tree walk | Screens, typed edges, flows, dead interactions |
| 6 | Classification | `figma/classify.ts` | Weighted scoring | `screen` / `component` / `ambiguous` + reasons |
| 7 | Graph analysis | `graph/analyze.ts` | BFS, connected components | Reachability, flows, paths, entry-point ranking |
| 8 | Browser verification | `browser/capture.ts` | Playwright Chromium | Validated screenshots + URL-verified destinations |
| 9 | Make discovery | `services/make-discovery.ts` | Playwright + DOM hashing | Browser-discovered UI states |
| 10 | Coverage | `services/coverage.ts` | Pure TS | 7 dimensions, each with a miss-list |
| 11 | Personas | `services/personas.ts` | NVIDIA NIM | Structured, Zod-validated personas |
| 12 | Test plans | `services/testplans.ts` | NIM + real graph context | Plans with graph-validated node ids |
| 13 | Execution | `services/execution.ts` | Playwright + NIM vision | Timeline, screenshots, video |
| 14 | UX analysis | `services/analysis.ts` | NIM vision | Evidence-linked findings |
| 15 | Delivery | `routes/*`, React | Fastify + SSE, React/Vite | Dashboard, recap player, report |

**Infrastructure:** Fastify 5 · SQLite (`better-sqlite3`) · local disk behind `EvidenceStorage`
· in-process job queue · Server-Sent Events · Zod 4 · Playwright · React 18 + Vite 6 +
Tailwind + TanStack Query · Vitest (122 tests).

### Why edges are typed

Measured on the reference file: **1250 interactions, but only 416 are screen transitions.**

```mermaid
flowchart TD
    I["1250 interaction actions"] --> T{"Figma navigation mode"}
    T -->|"NAVIGATE (416)"| S["screen edge<br/>➜ affects reachability"]
    T -->|"CHANGE_TO / SCROLL_TO (746)"| U["ui-state edge<br/>➜ same screen, new state"]
    T -->|"OVERLAY / SWAP (49)"| O["overlay edge<br/>➜ layered on current screen"]
    T -->|"null action (9 seen in the wild)"| D["dead interaction<br/>➜ reported as a UX problem"]
    S --> G["Reachability BFS"]
    U --> G2["Tracked as UI state,<br/>never inflates reachability"]
    O --> G2
```

Treating all 1250 as navigation would be wrong **59% of the time** and would roughly double
the reported screen count. (ADR-0001)

### Long-running work

```mermaid
sequenceDiagram
    participant U as Browser (React)
    participant A as Fastify API
    participant J as Job queue
    participant W as Worker
    participant X as Figma / Playwright / NIM
    participant D as SQLite + disk

    U->>A: POST /projects/:id/discovery
    A->>J: enqueue(discovery)
    A-->>U: 202 { jobId }
    U->>A: GET /jobs/:id/events (SSE)
    A-->>U: replay current state
    loop each step
        W->>X: fetch / navigate / capture / infer
        X-->>W: result (or a named failure)
        W->>D: persist incrementally
        W-->>U: progress event
    end
    W->>D: terminal state + coverage
    W-->>U: done event
```

Cancellable between steps · partial results persist as they are proven · SSE replays state so
a reconnecting client is immediately consistent.

### Where untrusted input is stopped

```mermaid
flowchart LR
    U["User URL"] --> G1["Host allow-list<br/>(SSRF gate)"]
    F["Figma payload"] --> G2["Shape validation<br/>+ depth/cycle bounds"]
    P["Prototype text"] --> G3["sanitize() before<br/>any prompt"]
    M["Model output"] --> G4["Zod schema +<br/>closed action set"]
    N["Browser requests"] --> G5["Documents: Figma only<br/>Subresources: + CDN allow-list"]
    G1 & G2 & G3 & G4 & G5 --> SAFE["Trusted core"]
```

The model may propose only `click`, `clickElement`, `navigateToNode`, `scroll`, `type`,
`wait`, `back`, `done`. Raw JavaScript and arbitrary URLs are **not representable** in the
action type — unsafe actions are impossible, not merely discouraged.

### Honest reporting, enforced in code

1. A coverage dimension reaches 100% **only** when its miss-list is empty. Seven dimensions
   tracked separately; no combined score, because averaging hides gaps.
2. A finding is `observed` **only** if it links to a validated screenshot; otherwise it is
   downgraded to `potential`.

Real output from the reference run:

```
designDiscovery        48/53  90.6%   misses=5    (63 components excluded by design)
reachability           31/53  58.5%   misses=22   each with a machine-readable reason
interactionDiscovery 1190/1250 95.2%  misses=21
screenshotCapture        5/5   100%   note: "47 screen(s) were not attempted in this run"
```

---

## Related documents

| Document | Purpose |
|---|---|
| [`../HANDOVER.md`](../HANDOVER.md) | New session? Orientation, gotchas, working agreements |
| [`../findings/external-verification.md`](../findings/external-verification.md) | What was **measured** about Figma, NIM and Playwright |
| [`../architecture/overview.md`](../architecture/overview.md) | Module boundaries and technology choices |
| [`../architecture/failure-modes.md`](../architecture/failure-modes.md) | Every failure class and its handling |
| [`../decisions/README.md`](../decisions/README.md) | Architecture Decision Records |
| [`../development/status.md`](../development/status.md) | Honest current state and gaps |
