# Lenz UX Validation Engine — project instructions

**Before doing anything substantial, read [`doc/HANDOVER.md`](doc/HANDOVER.md).** It is the
orientation document for this repo: what the project is, how to run it, the hard-won gotchas,
and the current verified state. Then consult the specific doc you need via
[`doc/README.md`](doc/README.md).

## What this is

An AI-powered UX validation platform. A user pastes a Figma URL; Lenz discovers screens and
navigation structure, generates synthetic personas, writes and executes test plans in a real
browser, records video, and reports evidence-backed UX findings.

It is a working application, verified end to end — not a prototype.

## Non-negotiables

1. **Verify, don't assume.** Every capability flag, token limit and behavioural claim here was
   measured against the live service. Before adding a model or provider, run
   `tools/probe/nim-audit.mts`. Never fill in limits from memory.
2. **Never claim something works without running it.** `doc/development/status.md`
   distinguishes *Verified* (executed and inspected) from *Built* (compiles only). Keep that
   distinction honest.
3. **Report gaps, never hide them.** Coverage misses carry machine-readable reasons. A
   dimension reaches 100% only when its miss-list is empty. There is deliberately no overall
   "UX score".
4. **Secrets live in `.env`** (gitignored). `config/ai-providers.json` contains `${ENV_VAR}`
   placeholders only — a literal key there is rejected at startup. Never paste a key into any
   tracked file, including probe scripts.
5. **Do not commit or push.** The user handles git manually. Make the change, verify it,
   report what you did.
6. **Treat external data as untrusted in shape, not just content.** Figma payloads contain
   nulls in unexpected places. Validate at the boundary; never let a raw `TypeError` reach the
   user.

## Critical technical gotchas

- **Never declare a named function inside `page.evaluate()`** — esbuild/`tsx` injects a
  `__name` helper that does not exist in the browser context. Inline everything.
- **Never use a bare `catch {}`** — log the error. A swallowed exception once turned a real
  crash into a silently empty discovery run.
- **Use Node, not `curl`, to reach NVIDIA** on this Windows host
  (`CRYPT_E_NO_REVOCATION_CHECK`).
- **Vite serves on `http://localhost:5173`** (IPv6), the API on `127.0.0.1:4000`.
- **Heredocs mangle backticks and `${}`** in this shell — use the Write tool for files
  containing template literals or markdown.

## Commands

| Command | Purpose |
|---|---|
| `npm run dev` | Server (:4000) + web (:5173) |
| `npm test` | 122 unit tests — fast, offline, deterministic |
| `npm run build` | Typecheck + build all workspaces |
| `npm run verify:live` | Real calls to Figma + NVIDIA (needs credentials) |

Live probes live in `tools/probe/` — see [`tools/probe/README.md`](tools/probe/README.md).

## Keeping docs honest

After meaningful work, update `doc/development/status.md` (what became verified, what broke),
`doc/architecture/failure-modes.md` (new failure classes), and `doc/decisions/README.md`
(significant decisions, with reasoning). Documentation that lies is worse than none.
