# Verification probes

Scripts that hit **real** external services. They are deliberately NOT part of `npm test`,
which must stay fast, offline and deterministic.

Run them from the repo root. They read credentials from `.env` and never contain keys.

| Script | What it does | When to use it |
|---|---|---|
| `verify-live.mts` | Full live check: config, AI provider, Figma. `npm run verify:live` | After changing provider config, or to confirm the environment is healthy |
| `verify-interactions.mts [outDir]` | Real Chromium: interaction recording, touch emulation, scroll sampling, privacy redaction, video size, PDF rendering. No credentials, no network. | After changing instrumentation, device profiles, heatmaps or the report |
| `verify-marker-alignment.mts <executionId>` | End-to-end: seeks the recap video to each marker and fingerprints the frame against the run's screenshots. Says whether markers sit on the screen their click happened on. | After changing how interactions are timestamped or how the player seeks |
| `verify-video-sync.mts [seconds]` | Ground truth for wall-clock -> video time: records a colour clock, seeks the video back and reads the pixel. Says whether marker times need rescaling. | Before changing how video markers or timeline seeks are timed |
| `backup-data.mts [label]` | Consistent backup of lenz.db (SQLite VACUUM INTO, so WAL contents are included) plus evidence and figma-cache, into `backups/` | Before deleting projects or changing the schema |
| `verify-migration.mts <db-copy>` | Opens a COPY of a real database and checks the schema migrated and existing evidence still reads back | After a schema change, before letting it touch real data |
| `nim-audit.mts` | Probes a model's real capabilities and parameter support | Before adding a model to `config/ai-providers.json` — never assume flags |
| `check-access.mjs <fileKey>` | Opens a Figma file anonymously and reports what a visitor sees | When a file returns 403/404 and you need to know if it is private |
| `graph-check.mts <file.json>` | Runs extraction + graph analysis on a saved Figma document | Debugging screen/edge counts without hitting the API |
| `extract-debug.mts <file.json>` | Extraction with null-scanning and a stack trace on failure | When a specific file crashes discovery |
| `classify-check.mts <file.json>` | Shows the screen/component verdict for every top-level node | Tuning the classifier |
| `probe-proto.mjs <outDir>` | Confirms a Figma prototype renders headlessly | Baseline browser sanity check |
| `probe-nav.mjs <outDir>` | Confirms URL + click navigation and destination verification | Validating ADR-0004 still holds |
| `probe-make.mjs <outDir>` | Confirms Figma Make loads and exposes its preview iframe | Scenario C sanity check |
| `ui-shots.mjs <outDir>` | Screenshots every frontend page, reports console errors | Visual regression check after UI changes |
| `mermaid-lint.mjs <file.md>` | Verifies every Mermaid diagram in a doc actually renders | After editing docs with diagrams |
| `mermaid-render.mjs <file.md> <n> <out.png>` | Renders diagram *n* to a PNG | Eyeballing a diagram for readability |

To save a Figma document for the offline probes:

```bash
node -e "const t=require('fs').readFileSync('.env','utf8').match(/^FIGMA_ACCESS_TOKEN=(.+)$/m)[1].trim();
fetch('https://api.figma.com/v1/files/<FILE_KEY>',{headers:{'X-Figma-Token':t}})
  .then(r=>r.text()).then(x=>require('fs').writeFileSync('file.json',x))"
```
