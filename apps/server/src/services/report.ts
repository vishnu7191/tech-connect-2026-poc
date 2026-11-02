import fsp from 'node:fs/promises';
import { chromium } from 'playwright';
import type {
  CoverageMetric,
  Execution,
  ExecutionAction,
  Finding,
  HeatmapGroup,
  HeatmapReport,
  Persona,
  Project,
  ResponsiveComparison,
  ScrollReport,
  Screenshot,
  TestPlan,
} from '@lenz/shared';
import { logger } from '../core/logger.js';

/**
 * Printable UX report.
 *
 * Rendered as self-contained HTML and converted to PDF by the Chromium that
 * Playwright already ships - no additional PDF dependency, and the layout is
 * ordinary CSS that can be inspected in a browser when something looks wrong.
 *
 * Three constraints shape the whole document:
 *
 *  1. IT MUST READ IN ORDER. Numbered sections, a contents page that matches
 *     them, and a front-loaded summary: the answer to "what should we fix?"
 *     is on page two, not buried behind the methodology.
 *  2. IT MUST BE READABLE BY SOMEONE WHO HAS NEVER USED LENZ. Every term that
 *     carries a specific meaning here - "observed", "coverage", "emulated",
 *     "synthetic" - is explained in the report itself, not assumed.
 *  3. IT MUST NOT OVERSTATE. There is no overall score, evidence strength sits
 *     next to every finding, and what was NOT tested gets its own section
 *     rather than being left as an absence the reader has to notice.
 */

export interface ReportInput {
  project: Project;
  generatedAt: string;
  executions: Array<{
    execution: Execution;
    plan: TestPlan | null;
    persona: Persona | null;
    actions: ExecutionAction[];
    coverage: CoverageMetric[];
    interactionCount: number;
  }>;
  findings: Finding[];
  screenshotsById: Map<string, Screenshot>;
  /** Base64 PNG data for the screenshots that fit the embedding budget. */
  imagesById: Map<string, string>;
  omittedImages: number;
  discoveryCoverage: CoverageMetric[];
  heatmap: HeatmapReport;
  scroll: ScrollReport;
  responsive: ResponsiveComparison | null;
  screenCount: number;
}

/**
 * Total base64 budget for embedded screenshots.
 *
 * Images dominate the file size and a report nobody can email is not much use.
 * 24 MB of base64 is roughly 18 MB of PNG, which comfortably covers a few dozen
 * screenshots; anything beyond it is dropped and the count is PRINTED, so the
 * reader knows evidence was omitted rather than absent.
 */
export const IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'] as const;

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#b91c1c',
  high: '#dc2626',
  medium: '#d97706',
  low: '#2563eb',
  info: '#64748b',
};

const SEVERITY_MEANING: Record<string, string> = {
  critical: 'The person cannot complete what they came to do.',
  high: 'A significant obstacle; many people would struggle or give up.',
  medium: 'Noticeable friction that slows people down or causes mistakes.',
  low: 'A small rough edge worth fixing when convenient.',
  info: 'An observation, not a problem.',
};

const EVIDENCE_EXPLAINED: Array<{ key: string; label: string; meaning: string; color: string }> = [
  {
    key: 'observed',
    label: 'Observed',
    color: '#16a34a',
    meaning:
      'Something visible in a saved screenshot, or a recorded fact from the run such as a click that led to the wrong screen. The strongest category.',
  },
  {
    key: 'potential',
    label: 'Potential',
    color: '#d97706',
    meaning:
      'A plausible problem that the captured evidence supports but does not prove on its own.',
  },
  {
    key: 'heuristic',
    label: 'Heuristic',
    color: '#2563eb',
    meaning:
      'A general usability principle applied to what was seen, rather than a problem caught in the act.',
  },
  {
    key: 'needs-human-validation',
    label: 'Needs human validation',
    color: '#7c3aed',
    meaning: 'A question a real person would have to answer. Treat it as a prompt, not a result.',
  },
];

const COVERAGE_EXPLAINED: Record<string, string> = {
  designDiscovery: 'How much of the design file Lenz could interpret with confidence.',
  reachability: 'How many screens can actually be reached by following the prototype’s own links.',
  interactionDiscovery: 'How many of the file’s interactions became usable, executable steps.',
  interactionExecution: 'How many of those interactions this particular test session exercised.',
  screenshotCapture: 'How many attempted screenshots produced valid, verified evidence.',
  testExecution: 'How many steps of the test plan completed successfully.',
  videoRecording: 'Whether a complete session recording was produced.',
};

const COVERAGE_LABEL: Record<string, string> = {
  designDiscovery: 'Design discovery',
  reachability: 'Screen reachability',
  interactionDiscovery: 'Interaction discovery',
  interactionExecution: 'Interaction execution',
  screenshotCapture: 'Screenshot capture',
  testExecution: 'Test execution',
  videoRecording: 'Video recording',
};

/* ------------------------------------------------------------------ *
 * Chart primitives
 *
 * Inline SVG and plain divs, with no chart library and no scripting: a PDF
 * renderer runs the page once and prints it, so anything that needs a second
 * animation frame to lay out is a liability. Every value drawn is a count the
 * reader can also find in the table beside it.
 * ------------------------------------------------------------------ */

/**
 * Donut showing how a total splits between categories.
 *
 * Drawn with stroke-dasharray on concentric arcs rather than paths, which keeps
 * the geometry trivial and exact. The total sits in the middle because that is
 * the number people look for first.
 */
function donut(
  segments: Array<{ label: string; value: number; color: string }>,
  centerLabel: string,
  centerSub: string,
): string {
  const total = segments.reduce((a, s) => a + s.value, 0);
  if (total === 0) return '';
  const r = 54;
  const circumference = 2 * Math.PI * r;
  let offset = 0;

  const arcs = segments
    .filter((s) => s.value > 0)
    .map((s) => {
      const fraction = s.value / total;
      const dash = `${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`;
      const arc = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${s.color}" stroke-width="22"
        stroke-dasharray="${dash}" stroke-dashoffset="${(-offset * circumference).toFixed(2)}"
        transform="rotate(-90 70 70)"/>`;
      offset += fraction;
      return arc;
    })
    .join('');

  return `<svg width="140" height="140" viewBox="0 0 140 140" xmlns="http://www.w3.org/2000/svg">
    <circle cx="70" cy="70" r="${r}" fill="none" stroke="#eceff4" stroke-width="22"/>
    ${arcs}
    <text x="70" y="66" text-anchor="middle" font-size="26" font-weight="700" fill="#11141c">${esc(centerLabel)}</text>
    <text x="70" y="84" text-anchor="middle" font-size="9" fill="#5b6475">${esc(centerSub)}</text>
  </svg>`;
}

/** Horizontal bars with a label, a count and a proportional bar. */
function hBars(
  rows: Array<{ label: string; value: number; color?: string; note?: string }>,
  max?: number,
): string {
  const peak = max ?? Math.max(1, ...rows.map((r) => r.value));
  return `<div class="bars">${rows
    .map(
      (r) => `<div class="barrow">
      <div class="barlabel">${esc(r.label)}</div>
      <div class="bartrack"><span style="width:${((r.value / peak) * 100).toFixed(1)}%;background:${
        r.color ?? 'var(--accent)'
      }"></span></div>
      <div class="barvalue">${esc(String(r.value))}</div>
    </div>${r.note ? `<div class="barnote">${esc(r.note)}</div>` : ''}`,
    )
    .join('')}</div>`;
}

/** A percentage bar with its fraction printed beside it. */
function pctBar(numerator: number, denominator: number, percentage: number | null): string {
  if (percentage === null) {
    return `<div class="pctwrap"><div class="bartrack"><span style="width:0%"></span></div>
      <div class="pctlabel">not applicable</div></div>`;
  }
  const pct = Math.round(percentage * 100);
  const color = pct >= 95 ? '#16a34a' : pct >= 70 ? '#d97706' : '#dc2626';
  return `<div class="pctwrap">
    <div class="bartrack"><span style="width:${pct}%;background:${color}"></span></div>
    <div class="pctlabel">${pct}% <span class="muted">(${numerator}/${denominator})</span></div>
  </div>`;
}

/* ------------------------------------------------------------------ *
 * Document
 * ------------------------------------------------------------------ */

export function buildReportHtml(input: ReportInput): string {
  const { project, findings } = input;
  const date = new Date(input.generatedAt);
  const dateLabel = date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  const bySeverity = SEVERITY_ORDER.map((s) => ({
    severity: s,
    items: findings.filter((f) => f.severity === s),
  })).filter((g) => g.items.length > 0);

  const observedCount = findings.filter((f) => f.evidenceType === 'observed').length;
  const blockers = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  const devices = [
    ...new Set(input.executions.map((e) => e.execution.device?.label ?? 'device not recorded')),
  ];
  const totalInteractions = input.executions.reduce((a, e) => a + e.interactionCount, 0);
  const hasResponsive = Boolean(input.responsive && input.responsive.runs.length > 1);

  // Section numbering is computed once so the contents page and the headings
  // can never drift apart.
  const sections = [
    'Executive summary',
    'How to read this report',
    'What was tested',
    'Findings',
    'Interaction evidence',
    ...(hasResponsive ? ['Across devices'] : []),
    'Coverage',
    'Limitations',
  ];
  const n = (title: string) => sections.indexOf(title) + 1;

  /**
   * What to fix first.
   *
   * Ranked by severity, then by how strongly it is evidenced, then by
   * confidence - so an observed high beats a suspected critical. Deliberately
   * capped at five: a prioritised list of thirty is not a prioritised list.
   */
  const evidenceRank: Record<string, number> = {
    observed: 0,
    potential: 1,
    heuristic: 2,
    'needs-human-validation': 3,
  };
  const topIssues = [...findings]
    .sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.severity as (typeof SEVERITY_ORDER)[number]) -
          SEVERITY_ORDER.indexOf(b.severity as (typeof SEVERITY_ORDER)[number]) ||
        (evidenceRank[a.evidenceType] ?? 9) - (evidenceRank[b.evidenceType] ?? 9) ||
        b.confidence - a.confidence,
    )
    .slice(0, 5);

  const sessionsRun = input.executions.length;
  const sessionsCompleted = input.executions.filter((e) => {
    const steps = e.actions.filter((a) => a.stepId !== null);
    const total = Math.max(e.plan?.steps.length ?? 0, steps.length);
    return (
      e.execution.status === 'succeeded' &&
      total > 0 &&
      steps.filter((a) => a.result === 'ok').length === total
    );
  }).length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(project.name)} — UX validation report</title>
<style>
  /* System fonts only: the document is rendered with no network access, so a
     web font would silently fall back and change the layout. */
  :root {
    --ink: #11141c;
    --muted: #5b6475;
    --line: #dfe3ea;
    --accent: #6d28d9;
    --bg-soft: #f6f7fa;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: var(--ink);
    font-size: 10.5pt;
    line-height: 1.55;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  h1, h2, h3, h4 { margin: 0 0 .4em; line-height: 1.25; }
  h1 { font-size: 26pt; letter-spacing: -0.01em; }
  h2 { font-size: 16pt; margin-top: 0; }
  h3 { font-size: 12pt; margin-top: 16pt; }
  h4 { font-size: 10.5pt; }
  p { margin: 0 0 .7em; }
  a { color: var(--accent); text-decoration: none; word-break: break-all; }
  .muted { color: var(--muted); }
  .small { font-size: 9pt; }
  .tiny { font-size: 8pt; }

  /* Each numbered section starts a page, so the contents page is navigable. */
  section { page-break-before: always; padding: 0 0 8pt; }
  .cover { page-break-after: always; padding-top: 36pt; }

  .secnum {
    display: inline-block; background: var(--accent); color: #fff;
    width: 20pt; height: 20pt; border-radius: 50%; text-align: center;
    line-height: 20pt; font-size: 10pt; font-weight: 700; margin-right: 7pt;
    vertical-align: 2pt;
  }
  .eyebrow {
    text-transform: uppercase; letter-spacing: .14em; font-size: 8pt;
    font-weight: 700; color: var(--accent); margin-bottom: 8pt;
  }
  .rule { height: 3px; background: var(--accent); width: 56pt; margin: 14pt 0 18pt; }

  table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt; }
  th, td { text-align: left; padding: 5pt 7pt; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 8pt; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  td { font-size: 9.5pt; }
  tbody tr:nth-child(even) { background: var(--bg-soft); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }

  .grid { display: flex; flex-wrap: wrap; gap: 8pt; margin: 10pt 0 14pt; }
  .stat {
    flex: 1 1 100pt; border: 1px solid var(--line); border-radius: 6pt;
    padding: 8pt 10pt; background: #fff;
  }
  .stat .k { font-size: 8pt; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  .stat .v { font-size: 19pt; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat .s { font-size: 8pt; color: var(--muted); }

  .callout {
    border-left: 3px solid var(--accent); background: var(--bg-soft);
    padding: 9pt 12pt; border-radius: 0 5pt 5pt 0; margin: 10pt 0 14pt;
  }
  .callout h4 { margin-bottom: .3em; }

  /* charts */
  .chartrow { display: flex; gap: 16pt; align-items: center; margin: 8pt 0 14pt; }
  .legend { font-size: 9pt; }
  .legend div { margin-bottom: 3pt; }
  .swatch {
    display: inline-block; width: 8pt; height: 8pt; border-radius: 2pt;
    margin-right: 5pt; vertical-align: -1pt;
  }
  .bars { margin: 6pt 0 10pt; }
  .barrow { display: flex; align-items: center; gap: 7pt; margin-bottom: 4pt; }
  .barlabel { width: 96pt; font-size: 9pt; flex: 0 0 auto; }
  .bartrack { flex: 1 1 auto; height: 9pt; background: #eceff4; border-radius: 99pt; overflow: hidden; }
  .bartrack > span { display: block; height: 100%; background: var(--accent); border-radius: 99pt; }
  .barvalue { width: 28pt; text-align: right; font-size: 9pt; font-variant-numeric: tabular-nums; flex: 0 0 auto; }
  .barnote { font-size: 8pt; color: var(--muted); margin: -2pt 0 5pt 103pt; }
  .pctwrap { display: flex; align-items: center; gap: 7pt; }
  .pctlabel { width: 92pt; font-size: 9pt; font-variant-numeric: tabular-nums; flex: 0 0 auto; }

  .finding {
    border: 1px solid var(--line); border-radius: 6pt; padding: 11pt 13pt;
    margin: 0 0 11pt; page-break-inside: avoid; background: #fff;
  }
  .finding-head { display: flex; gap: 8pt; align-items: baseline; margin-bottom: 5pt; }
  .pill {
    display: inline-block; border-radius: 99pt; padding: 1.5pt 8pt;
    font-size: 7.5pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    color: #fff; white-space: nowrap;
  }
  .pill-outline {
    background: #fff; color: var(--muted); border: 1px solid var(--line);
    font-weight: 600; text-transform: none; letter-spacing: 0;
  }
  .finding h3 { flex: 1; margin-top: 0; }
  .kv { margin: 7pt 0 0; }
  .kv .k {
    font-size: 8pt; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); font-weight: 700; margin-bottom: 1pt;
  }

  figure { margin: 9pt 0 0; page-break-inside: avoid; text-align: center; }
  /*
   * Evidence images are shown WHOLE.
   *
   * The previous rule used object-fit: cover with a max-height, which crops:
   * a portrait phone screenshot lost its entire lower half, and the half that
   * survived was presented as if it were the evidence. Constraining both axes
   * and letting the browser pick the dimensions scales the image down instead,
   * so the full screen is always visible. 185mm is the printable width inside
   * the A4 margins and 215mm leaves room for the caption on one page.
   */
  figure img {
    max-width: 100%; max-height: 215mm; width: auto; height: auto;
    border: 1px solid var(--line); border-radius: 4pt;
    display: block; margin: 0 auto;
  }
  figcaption { font-size: 8pt; color: var(--muted); margin-top: 3pt; text-align: left; }

  .heat { position: relative; border: 1px solid var(--line); border-radius: 4pt; overflow: hidden; background: var(--bg-soft); }
  .heat img { width: 100%; display: block; }
  .heat svg { position: absolute; inset: 0; width: 100%; height: 100%; }

  .two { display: flex; gap: 10pt; }
  .two > * { flex: 1 1 0; min-width: 0; }
  ul { margin: 0 0 .7em; padding-left: 15pt; }
  li { margin-bottom: 2pt; }

  .toc { margin-top: 18pt; }
  .toc-item {
    display: flex; align-items: baseline; gap: 8pt;
    border-bottom: 1px dotted var(--line); padding: 4pt 0; font-size: 10pt;
  }
  .toc-item .i {
    width: 16pt; height: 16pt; border-radius: 50%; background: var(--accent);
    color: #fff; font-size: 8.5pt; font-weight: 700; text-align: center;
    line-height: 16pt; flex: 0 0 auto;
  }
  .toc-item .d { color: var(--muted); font-size: 8.5pt; }
</style>
</head>
<body>

<!-- ============================================= COVER -->
<div class="cover">
  <div class="eyebrow">UX validation report</div>
  <h1>${esc(project.name)}</h1>
  <div class="rule"></div>
  <p class="muted" style="font-size:11pt; max-width: 430pt;">
    An automated usability test of this design. Synthetic personas were driven through approved
    test plans in a real browser; every finding in this report is tied to what was captured
    during those runs.
  </p>

  <table style="margin-top:20pt; max-width:450pt;">
    <tbody>
      <tr><th style="width:120pt">Report date</th><td>${esc(dateLabel)}</td></tr>
      <tr><th>Source</th><td><a href="${esc(project.figmaUrl)}">${esc(project.figmaUrl)}</a></td></tr>
      <tr><th>Screens discovered</th><td>${input.screenCount}</td></tr>
      <tr><th>Test sessions</th><td>${sessionsRun}</td></tr>
      <tr><th>Devices tested</th><td>${esc(devices.join(', ') || 'none')}</td></tr>
      <tr><th>Findings</th><td>${findings.length} (${observedCount} directly observed)</td></tr>
    </tbody>
  </table>

  <div class="toc">
    <h4 style="margin-bottom:6pt;">Contents</h4>
    ${sections
      .map(
        (title, i) => `<div class="toc-item">
        <span class="i">${i + 1}</span>
        <span style="flex:1">${esc(title)}</span>
        <span class="d">${esc(TOC_BLURB[title] ?? '')}</span>
      </div>`,
      )
      .join('')}
  </div>

  <div class="callout" style="margin-top:22pt;">
    <h4>There is no single UX score in this report</h4>
    <p class="small" style="margin:0;">
      A single number would require a validated methodology for weighing very different kinds of
      problem against each other, and no such methodology has been established for this data.
      Instead this report gives you severity counts, the strength of the evidence behind each
      finding, and how much of the product was actually examined — each of which can be checked.
    </p>
  </div>
</div>

<!-- ============================================= 1. EXECUTIVE SUMMARY -->
<section style="page-break-before: avoid;">
  <div class="eyebrow">Section ${n('Executive summary')}</div>
  <h2><span class="secnum">${n('Executive summary')}</span>Executive summary</h2>

  <div class="grid">
    ${stat('Findings', String(findings.length), findings.length === 0 ? 'none recorded' : `${blockers.length} serious`)}
    ${stat('Directly observed', String(observedCount), 'backed by evidence')}
    ${stat('Sessions run', String(sessionsRun), `${sessionsCompleted} finished the task`)}
    ${stat('Screens discovered', String(input.screenCount), 'in the design file')}
    ${stat('Interactions recorded', String(totalInteractions), 'clicks, taps, scrolls')}
  </div>

  ${
    findings.length === 0
      ? `<div class="callout"><h4>No findings have been recorded yet</h4>
         <p class="small" style="margin:0;">Run a test plan, open its recording and choose
         “Analyze UX”. Findings are produced from the screenshots and the recorded actions of a
         session, so there has to be a completed session first.</p></div>`
      : `
  <h3 style="margin-top:4pt;">How serious are the findings?</h3>
  <div class="chartrow">
    ${donut(
      SEVERITY_ORDER.map((s) => ({
        label: s,
        value: findings.filter((f) => f.severity === s).length,
        color: SEVERITY_COLOR[s]!,
      })),
      String(findings.length),
      findings.length === 1 ? 'finding' : 'findings',
    )}
    <div class="legend">
      ${SEVERITY_ORDER.map((s) => {
        const c = findings.filter((f) => f.severity === s).length;
        if (c === 0) return '';
        return `<div><span class="swatch" style="background:${SEVERITY_COLOR[s]}"></span>
          <strong>${c}</strong> ${esc(s)} — <span class="muted">${esc(SEVERITY_MEANING[s] ?? '')}</span></div>`;
      }).join('')}
    </div>
  </div>

  <h3>How strong is the evidence?</h3>
  <div class="chartrow">
    ${donut(
      EVIDENCE_EXPLAINED.map((e) => ({
        label: e.label,
        value: findings.filter((f) => f.evidenceType === e.key).length,
        color: e.color,
      })),
      String(observedCount),
      'observed',
    )}
    <div class="legend">
      ${EVIDENCE_EXPLAINED.map((e) => {
        const c = findings.filter((f) => f.evidenceType === e.key).length;
        if (c === 0) return '';
        return `<div><span class="swatch" style="background:${e.color}"></span>
          <strong>${c}</strong> ${esc(e.label.toLowerCase())}</div>`;
      }).join('')}
      <div class="tiny muted" style="margin-top:5pt;max-width:200pt;">
        Section ${n('How to read this report')} explains what each label means.
      </div>
    </div>
  </div>

  <h3>Fix these first</h3>
  <p class="small muted" style="margin-bottom:6pt;">
    Ranked by severity, then by how strongly each one is evidenced. Full detail, with the
    screenshot behind each, is in section ${n('Findings')}.
  </p>
  <table>
    <thead><tr><th style="width:26pt">#</th><th>Issue</th><th style="width:66pt">Severity</th><th style="width:78pt">Evidence</th></tr></thead>
    <tbody>
      ${topIssues
        .map(
          (f, i) => `<tr>
          <td class="num">${i + 1}</td>
          <td><strong>${esc(f.title)}</strong>${f.screenName ? `<div class="tiny muted">on “${esc(f.screenName)}”</div>` : ''}</td>
          <td><span class="pill" style="background:${SEVERITY_COLOR[f.severity]}">${esc(f.severity)}</span></td>
          <td class="small">${esc(EVIDENCE_EXPLAINED.find((e) => e.key === f.evidenceType)?.label ?? f.evidenceType)}</td>
        </tr>`,
        )
        .join('')}
    </tbody>
  </table>`
  }

  ${
    sessionsRun > 0
      ? `<h3>Did the personas finish the task?</h3>
    ${hBars(
      input.executions.map((e) => {
        const steps = e.actions.filter((a) => a.stepId !== null);
        const total = Math.max(e.plan?.steps.length ?? 0, steps.length, 1);
        const ok = steps.filter((a) => a.result === 'ok').length;
        return {
          label: e.execution.device?.label ?? 'not recorded',
          value: ok,
          color: ok === total ? '#16a34a' : ok === 0 ? '#dc2626' : '#d97706',
          note: `${esc(e.plan?.name ?? e.execution.planName ?? 'plan')} — ${ok} of ${total} steps completed`,
        };
      }),
      Math.max(
        1,
        ...input.executions.map((e) =>
          Math.max(e.plan?.steps.length ?? 0, e.actions.filter((a) => a.stepId !== null).length),
        ),
      ),
    )}`
      : ''
  }
</section>

<!-- ============================================= 2. HOW TO READ -->
<section>
  <div class="eyebrow">Section ${n('How to read this report')}</div>
  <h2><span class="secnum">${n('How to read this report')}</span>How to read this report</h2>
  <p>
    Every finding carries a <strong>severity</strong> and an <strong>evidence strength</strong>.
    Severity is how much it would hurt the person using the product. Evidence strength is how
    certain we are that the problem is real. Both matter: a low-severity problem that was
    directly observed may be more actionable than a high-severity one that is only suspected.
  </p>

  <h3>Severity</h3>
  <table>
    <thead><tr><th style="width:80pt">Label</th><th>What it means</th></tr></thead>
    <tbody>
      ${SEVERITY_ORDER.map(
        (s) =>
          `<tr><td><span class="pill" style="background:${SEVERITY_COLOR[s]}">${s}</span></td><td>${esc(
            SEVERITY_MEANING[s] ?? '',
          )}</td></tr>`,
      ).join('')}
    </tbody>
  </table>

  <h3>Evidence strength</h3>
  <table>
    <thead><tr><th style="width:110pt">Label</th><th>What it means</th></tr></thead>
    <tbody>
      ${EVIDENCE_EXPLAINED.map(
        (e) =>
          `<tr><td><span class="swatch" style="background:${e.color}"></span><strong>${esc(e.label)}</strong></td><td>${esc(e.meaning)}</td></tr>`,
      ).join('')}
    </tbody>
  </table>

  <div class="callout">
    <h4>Two things this report is not</h4>
    <p class="small" style="margin:0 0 .4em;">
      <strong>It is not a test with real users.</strong> The personas are synthetic — generated
      profiles that Lenz drove through the product. They are a structured way to ask "what would
      this be like for someone with these goals", not a substitute for watching real people.
    </p>
    <p class="small" style="margin:0;">
      <strong>It is not a test on physical devices.</strong> Where a phone or tablet was tested,
      the browser emulated that device's screen size, pixel density and touch input. Real device
      performance, network conditions and operating-system behaviour are not reproduced.
    </p>
  </div>
</section>

<!-- ============================================= 3. WHAT WAS TESTED -->
<section>
  <div class="eyebrow">Section ${n('What was tested')}</div>
  <h2><span class="secnum">${n('What was tested')}</span>What was tested</h2>
  <p class="muted">
    Each session is one persona following one approved test plan, in a real browser, recorded
    start to finish.
  </p>
  ${
    sessionsRun === 0
      ? '<p class="muted">No test sessions have been run for this project.</p>'
      : `<table>
    <thead>
      <tr>
        <th>Plan</th><th>Persona</th><th>Device</th><th>Outcome</th>
        <th class="num">Steps</th><th class="num">Actions</th><th class="num">Interactions</th>
      </tr>
    </thead>
    <tbody>
      ${input.executions
        .map((e) => {
          const steps = e.actions.filter((a) => a.stepId !== null);
          const ok = steps.filter((a) => a.result === 'ok').length;
          const total = Math.max(e.plan?.steps.length ?? 0, steps.length);
          return `<tr>
            <td>${esc(e.plan?.name ?? e.execution.planName ?? '—')}</td>
            <td>${esc(e.persona?.name ?? e.execution.personaName ?? '—')}</td>
            <td>${esc(e.execution.device?.label ?? 'not recorded')}</td>
            <td>${esc(e.execution.status)}</td>
            <td class="num">${ok}/${total}</td>
            <td class="num">${e.execution.actionCount}</td>
            <td class="num">${e.interactionCount}</td>
          </tr>`;
        })
        .join('')}
    </tbody>
  </table>`
  }

  ${input.executions
    .filter((e) => e.execution.failureReason)
    .map(
      (e) => `<div class="callout"><h4>${esc(e.plan?.name ?? 'Session')} — note from the run</h4>
        <p class="small" style="margin:0;">${esc(e.execution.failureReason ?? '')}</p></div>`,
    )
    .join('')}
</section>

<!-- ============================================= 4. FINDINGS -->
<section>
  <div class="eyebrow">Section ${n('Findings')}</div>
  <h2><span class="secnum">${n('Findings')}</span>Findings</h2>
  ${
    findings.length === 0
      ? `<p class="muted">No findings to report. If test sessions were run, open one and choose
         "Analyze UX" to produce findings from its captured evidence.</p>`
      : `<p class="muted">Grouped by severity, most serious first. Each one states what the problem
         is, what it costs the person using the product, and the change we recommend.</p>
    ${bySeverity
      .map(
        (group) => `
    <h3>
      <span class="pill" style="background:${SEVERITY_COLOR[group.severity]}">${group.severity}</span>
      <span style="margin-left:6pt;">${group.items.length} finding${group.items.length === 1 ? '' : 's'}</span>
    </h3>
    ${group.items.map((f) => findingHtml(f, input)).join('')}`,
      )
      .join('')}`
  }
</section>

<!-- ============================================= 5. INTERACTION EVIDENCE -->
<section>
  <div class="eyebrow">Section ${n('Interaction evidence')}</div>
  <h2><span class="secnum">${n('Interaction evidence')}</span>Interaction evidence</h2>
  <p class="muted">${esc(input.heatmap.dataNote)}</p>

  <h3 style="margin-top:8pt;">Where the personas pressed</h3>
  ${
    input.heatmap.groups.length === 0
      ? '<p class="muted">No positioned clicks or taps were recorded.</p>'
      : input.heatmap.groups.slice(0, 6).map((g) => heatmapHtml(g, input)).join('')
  }

  ${
    input.heatmap.exclusions.length > 0
      ? `<h4>Interactions not shown above</h4>
         <ul class="small muted">${input.heatmap.exclusions
           .map((x) => `<li>${x.count} × ${esc(x.reason)}</li>`)
           .join('')}</ul>`
      : ''
  }

  <h3>How far down each screen the personas got</h3>
  ${
    input.scroll.summaries.length === 0
      ? '<p class="muted">No scrolling was recorded. A screen that fits on one page produces none, which is a valid result rather than missing data.</p>'
      : `${hBars(
          input.scroll.summaries.slice(0, 12).map((s) => ({
            label: (s.screenName ?? s.screenId ?? 'screen').slice(0, 22),
            value: s.maxDepthFraction === null ? 0 : Math.round(s.maxDepthFraction * 100),
            color: '#2563eb',
            note:
              s.maxDepthFraction === null
                ? 'document height was not measurable, so depth is unknown'
                : `${esc(s.deviceId)} · ${s.sessionCount} session(s) · deepest point ${Math.round(s.maxDepthFraction * 100)}% of the page`,
          })),
          100,
        )}
      <p class="tiny muted">
        "Deepest point" is how far through the page the bottom of the screen reached. It does not
        mean the person read that far — no eye movement was measured.
      </p>`
  }
</section>

${hasResponsive ? responsiveHtml(input.responsive!, n('Across devices')) : ''}

<!-- ============================================= COVERAGE -->
<section>
  <div class="eyebrow">Section ${n('Coverage')}</div>
  <h2><span class="secnum">${n('Coverage')}</span>Coverage</h2>
  <p class="muted">
    How much of the product was actually examined. Every shortfall lists its cause — a number
    here is never rounded up to look complete.
  </p>
  ${coverageTable(input.discoveryCoverage, 'Discovery')}
  ${input.executions
    .filter((e) => e.coverage.length > 0)
    .map((e) =>
      coverageTable(
        e.coverage,
        `Session: ${e.plan?.name ?? e.execution.planName ?? e.execution.id} (${e.execution.device?.label ?? 'device not recorded'})`,
      ),
    )
    .join('')}
</section>

<!-- ============================================= LIMITATIONS -->
<section>
  <div class="eyebrow">Section ${n('Limitations')}</div>
  <h2><span class="secnum">${n('Limitations')}</span>Limitations</h2>
  <p class="muted">What this report cannot tell you.</p>
  <ul>
    <li><strong>It is not a study with real users.</strong> Personas are generated profiles, not people. Use these findings to decide what to look at, then confirm with real users.</li>
    <li><strong>Mobile and tablet results come from browser emulation.</strong> Screen size, pixel density and touch input are reproduced. Device speed, network conditions, the on-screen keyboard and operating-system gestures are not.</li>
    <li><strong>A prototype is not the finished product.</strong> Text entry, real data, loading states and error handling usually do not exist in a prototype, so problems in those areas cannot be found here.</li>
    <li><strong>Click positions are from automated testing.</strong> The heatmaps show where Lenz pressed while following the test plans. They are not a record of human behaviour and must not be presented as one.</li>
    <li><strong>Only what was reached was examined.</strong> Any screen listed as missed in section ${n('Coverage')} was not seen at all; absence of findings there means absence of inspection, not absence of problems.</li>
    ${input.omittedImages > 0 ? `<li><strong>${input.omittedImages} screenshot(s) were left out of this file</strong> to keep its size manageable. They are still available in the application.</li>` : ''}
  </ul>

  <div class="callout" style="margin-top:14pt;">
    <h4>Questions this report is good at answering</h4>
    <p class="small" style="margin:0;">
      Did the journey work end to end? Did any interaction lead somewhere unexpected? Are controls
      reachable and large enough to press on a phone? Which screens can nobody get to? Those are
      all checked against recorded evidence, and each answer in section ${n('Findings')} links to
      the screenshot or the recorded fact behind it.
    </p>
  </div>

  <p class="tiny muted" style="margin-top:20pt;">
    Generated by Lenz UX Validation Engine on ${esc(dateLabel)}.
    Findings marked with a model name were drafted by that model from the captured evidence and
    constrained by the rules in section ${n('How to read this report')}; findings without one were
    derived directly from recorded facts.
  </p>
</section>

</body>
</html>`;
}

/** One-line description of each section, shown on the contents page. */
const TOC_BLURB: Record<string, string> = {
  'Executive summary': 'the numbers, and what to fix first',
  'How to read this report': 'what the labels mean',
  'What was tested': 'sessions, personas and devices',
  Findings: 'every issue, its impact and the fix',
  'Interaction evidence': 'where they pressed, how far they scrolled',
  'Across devices': 'the same journey at different screen sizes',
  Coverage: 'how much was examined, and what was missed',
  Limitations: 'what this report cannot tell you',
};

function findingHtml(f: Finding, input: ReportInput): string {
  const image = f.screenshotId ? input.imagesById.get(f.screenshotId) : undefined;
  const shot = f.screenshotId ? input.screenshotsById.get(f.screenshotId) : undefined;
  const evidence = EVIDENCE_EXPLAINED.find((e) => e.key === f.evidenceType);

  return `<div class="finding">
    <div class="finding-head">
      <span class="pill" style="background:${SEVERITY_COLOR[f.severity] ?? '#64748b'}">${esc(f.severity)}</span>
      <h3>${esc(f.title)}</h3>
    </div>
    <p class="tiny muted" style="margin-bottom:6pt;">
      <span class="pill pill-outline">${esc(evidence?.label ?? f.evidenceType)}</span>
      &nbsp;${esc(humanizeCategory(f.category))}
      ${f.screenName ? ` · on “${esc(f.screenName)}”` : ''}
      · confidence ${Math.round(f.confidence * 100)}%
      ${f.generatedByModel ? ` · drafted by ${esc(shortModel(f.generatedByModel))}` : ' · derived from recorded facts'}
    </p>

    <p>${esc(f.description)}</p>

    <div class="kv">
      <div class="k">What this costs the person using it</div>
      <p style="margin:0 0 .5em;">${esc(f.personaImpact)}</p>
    </div>
    <div class="kv">
      <div class="k">Recommended change</div>
      <p style="margin:0;">${esc(f.recommendation)}</p>
    </div>

    ${
      image
        ? `<figure>
            <img src="data:image/png;base64,${image}" alt="">
            <figcaption>Evidence: ${esc(shot?.screenName ?? 'captured screen')}${
              shot?.actionLabel ? ` — ${esc(shot.actionLabel)}` : ''
            }${shot ? ` (captured at ${shot.width}×${shot.height} CSS px)` : ''}</figcaption>
          </figure>`
        : f.screenshotId
          ? '<p class="tiny muted" style="margin-top:6pt;">A screenshot is linked to this finding but was not embedded in this file.</p>'
          : '<p class="tiny muted" style="margin-top:6pt;">No screenshot is linked to this finding.</p>'
    }
  </div>`;
}

/**
 * Heatmap for print.
 *
 * Drawn as SVG radial gradients rather than a canvas density field: overlapping
 * translucent gradients accumulate naturally, and SVG survives PDF rendering
 * without depending on a filter implementation. The points are the exact
 * recorded positions, scaled by the same fraction the UI uses.
 */
function heatmapHtml(g: HeatmapGroup, input: ReportInput): string {
  const image = g.screenshotId && g.screenshotCompatible ? input.imagesById.get(g.screenshotId) : undefined;
  const radius = Math.max(g.viewportWidth, g.viewportHeight) * 0.035;
  const gradientId = `hg-${g.key.replace(/[^a-zA-Z0-9]/g, '')}`;

  const circles = g.points
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${radius.toFixed(1)}" fill="url(#${gradientId})"/>`,
    )
    .join('');

  const dots = g.points
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${(radius * 0.18).toFixed(1)}" fill="${
          p.result === 'failure' ? '#dc2626' : p.result === 'success' ? '#16a34a' : '#64748b'
        }" stroke="#ffffff" stroke-width="${(radius * 0.05).toFixed(1)}"/>`,
    )
    .join('');

  return `<div style="page-break-inside:avoid; margin-bottom:16pt;">
    <h4>${esc(g.screenName ?? g.screenId ?? 'Unidentified screen')}
      <span class="tiny muted" style="font-weight:400;">
        — ${esc(g.deviceId)}, ${g.viewportWidth}×${g.viewportHeight} CSS px
      </span>
    </h4>
    <div class="two">
      <div class="heat" style="max-width:260pt;">
        ${image ? `<img src="data:image/png;base64,${image}" alt="">` : `<div style="padding-top:${((g.viewportHeight / g.viewportWidth) * 100).toFixed(1)}%"></div>`}
        <svg viewBox="0 0 ${g.viewportWidth} ${g.viewportHeight}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <radialGradient id="${gradientId}">
              <stop offset="0%" stop-color="#ef4444" stop-opacity="0.55"/>
              <stop offset="60%" stop-color="#f59e0b" stop-opacity="0.22"/>
              <stop offset="100%" stop-color="#f59e0b" stop-opacity="0"/>
            </radialGradient>
          </defs>
          ${circles}
          ${dots}
        </svg>
      </div>
      <div class="small">
        <table style="margin-top:0;">
          <tbody>
            <tr><th>Presses recorded</th><td class="num">${g.totalPoints}</td></tr>
            <tr><th>Sessions</th><td class="num">${g.sessionCount}</td></tr>
            <tr><th>Worked as intended</th><td class="num">${g.successCount}</td></tr>
            <tr><th>Did not work</th><td class="num">${g.failureCount}</td></tr>
            <tr><th>Could not be verified</th><td class="num">${g.unverifiedCount}</td></tr>
          </tbody>
        </table>
        <p class="tiny muted" style="margin:4pt 0 0;">
          Green dots worked, red dots did not, grey could not be confirmed either way.
          ${g.screenshotNote ? esc(g.screenshotNote) : ''}
        </p>
      </div>
    </div>
  </div>`;
}

function responsiveHtml(r: ResponsiveComparison, sectionNumber: number): string {
  const label = (run: ResponsiveComparison['runs'][number]) => esc(run.device.label);
  return `<section>
  <div class="eyebrow">Section ${sectionNumber}</div>
  <h2><span class="secnum">${sectionNumber}</span>Across devices</h2>
  <p class="muted">${esc(r.note)}</p>

  <table>
    <thead>
      <tr><th>Measure</th>${r.runs.map((run) => `<th>${label(run)}</th>`).join('')}</tr>
    </thead>
    <tbody>
      <tr><td>Screen size tested</td>${r.runs.map((run) => `<td>${run.device.width}×${run.device.height}</td>`).join('')}</tr>
      <tr><td>Finished the task</td>${r.runs.map((run) => `<td>${run.taskCompleted ? 'yes' : 'no'} (${run.stepsCompleted}/${run.stepsTotal} steps)</td>`).join('')}</tr>
      <tr><td>Actions needed</td>${r.runs.map((run) => `<td class="num">${run.actionCount}</td>`).join('')}</tr>
      <tr><td>Steps that failed</td>${r.runs.map((run) => `<td class="num">${run.failedActions}</td>`).join('')}</tr>
      <tr><td>Went to the wrong screen</td>${r.runs.map((run) => `<td class="num">${run.destinationMismatches}</td>`).join('')}</tr>
      <tr><td>Deepest scroll</td>${r.runs.map((run) => `<td class="num">${run.maxDepthFraction === null ? '—' : Math.round(run.maxDepthFraction * 100) + '%'}</td>`).join('')}</tr>
      <tr><td>Controls too small to tap</td>${r.runs
        .map((run) =>
          run.device.hasTouch
            ? `<td class="num">${run.touchTargetConcerns.length}</td>`
            : '<td class="muted">not a touch device</td>',
        )
        .join('')}</tr>
    </tbody>
  </table>

  ${
    r.differences.length === 0
      ? '<p class="muted">No differences were measurable between these runs.</p>'
      : r.differences
          .map(
            (d) => `<div class="finding" style="padding:9pt 11pt;">
      <div class="finding-head">
        <span class="pill" style="background:${
          d.severity === 'failure' ? SEVERITY_COLOR.high : d.severity === 'concern' ? SEVERITY_COLOR.medium : SEVERITY_COLOR.info
        }">${d.severity === 'failure' ? 'failed on some devices' : d.severity === 'concern' ? 'worth checking' : 'difference'}</span>
        <h4 style="flex:1; margin:0;">${esc(d.summary)}</h4>
      </div>
      <p class="small" style="margin:0;">${esc(d.detail)}</p>
    </div>`,
          )
          .join('')
  }

  <div class="callout">
    <h4>A layout that changes is not a fault</h4>
    <p class="small" style="margin:0;">
      Menus collapse, columns stack and pages get longer on small screens — that is responsive
      design working. Only two things above are flagged as problems: a task that finished on one
      size and not another, and a control measured smaller than the published minimum tap size
      (44&nbsp;px, per Apple's guidance; Google's is 48&nbsp;dp).
    </p>
  </div>
</section>`;
}

function coverageTable(metrics: CoverageMetric[], title: string): string {
  if (metrics.length === 0) return '';
  return `<h3>${esc(title)}</h3>
  <table>
    <thead><tr><th style="width:118pt">What was measured</th><th style="width:150pt">Result</th><th>Meaning, and anything missed</th></tr></thead>
    <tbody>
      ${metrics
        .map((m) => {
          const missList =
            m.misses.length > 0
              ? `<ul class="tiny" style="margin:4pt 0 0;">${m.misses
                  .slice(0, 8)
                  .map((x) => `<li>${esc(x.label)} — ${esc(humanizeReason(x.reason))}</li>`)
                  .join('')}${m.misses.length > 8 ? `<li>…and ${m.misses.length - 8} more</li>` : ''}</ul>`
              : '';
          return `<tr>
            <td><strong>${esc(COVERAGE_LABEL[m.dimension] ?? m.dimension)}</strong></td>
            <td>${pctBar(m.numerator, m.denominator, m.percentage)}</td>
            <td class="small">${esc(COVERAGE_EXPLAINED[m.dimension] ?? '')}${
              m.note ? ` <span class="muted">${esc(m.note)}</span>` : ''
            }${missList}</td>
          </tr>`;
        })
        .join('')}
    </tbody>
  </table>`;
}

function stat(key: string, value: string, sub?: string): string {
  return `<div class="stat"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div>${
    sub ? `<div class="s">${esc(sub)}</div>` : ''
  }</div>`;
}

/** Turn an internal enum into something a non-user of Lenz can read. */
export function humanizeCategory(category: string): string {
  const map: Record<string, string> = {
    'navigation-clarity': 'Navigation clarity',
    'visual-hierarchy': 'Visual hierarchy',
    discoverability: 'Discoverability',
    'content-clarity': 'Content clarity',
    'form-usability': 'Form usability',
    'interaction-feedback': 'Interaction feedback',
    'visual-consistency': 'Visual consistency',
    accessibility: 'Accessibility',
    'cognitive-friction': 'Mental effort',
    'unnecessary-steps': 'Unnecessary steps',
    'confusing-labels': 'Confusing labels',
    'journey-interruption': 'Interrupted journey',
  };
  return map[category] ?? category.replace(/-/g, ' ');
}

export function humanizeReason(reason: string): string {
  const map: Record<string, string> = {
    'no-incoming-navigate-edge': 'nothing in the prototype links to this screen',
    'disconnected-canvas': 'this screen sits on its own, unconnected to any flow',
    'classification-ambiguous': 'Lenz could not tell whether this is a screen or a component',
    'api-inaccessible': 'the design file could not be read for this item',
    'render-failed': 'the screenshot did not render',
    'blank-screenshot': 'the screenshot came out blank',
    'destination-mismatch': 'the prototype went somewhere other than expected',
    'capture-timeout': 'the screen took too long to settle',
    'not-attempted': 'this was not attempted in this run',
    'not-exercised-by-this-plan': 'this test plan did not use it',
    'step-skipped': 'the step was skipped',
    'step-failed': 'the step failed',
    'action-limit-reached': 'the run hit its action limit first',
    cancelled: 'the run was stopped',
  };
  return map[reason] ?? reason.replace(/-/g, ' ');
}

function shortModel(model: string): string {
  return model.split('/').pop() ?? model;
}

/** HTML-escape. Every interpolated value passes through this. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ *
 * PDF rendering
 * ------------------------------------------------------------------ */

/**
 * Render report HTML to a PDF.
 *
 * Uses a bare Chromium rather than `BrowserSession`: that class exists to drive
 * the Figma viewer and enforces a Figma-only navigation policy, which has
 * nothing to do with printing a local document. Here the document is entirely
 * self-contained, so ALL network access is refused - the renderer cannot be
 * made to fetch anything, whatever ends up in the HTML.
 *
 * Headless is forced regardless of the HEADLESS setting, because `page.pdf()`
 * is unavailable in a headed browser.
 */
export async function renderPdf(html: string, opts: { title?: string } = {}): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext();
    await context.route('**/*', (route) => {
      const url = route.request().url();
      // data: and about: are the document and its embedded images.
      if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
        return route.continue();
      }
      return route.abort();
    });

    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
    // Images are inline data URIs, so they decode without the network - but the
    // decode itself is still asynchronous and a half-decoded image prints blank.
    await page
      .evaluate(() =>
        Promise.all(
          Array.from(document.images)
            .filter((img) => !img.complete)
            .map(
              (img) =>
                new Promise((resolve) => {
                  img.addEventListener('load', resolve, { once: true });
                  img.addEventListener('error', resolve, { once: true });
                }),
            ),
        ).then(() => undefined),
      )
      .catch((err) => logger.warn({ err: (err as Error).message }, 'Image settle wait failed'));

    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' },
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size:7pt;color:#8a92a8;width:100%;padding:0 16mm;">${esc(
        opts.title ?? 'UX validation report',
      )}</div>`,
      footerTemplate:
        '<div style="font-size:7pt;color:#8a92a8;width:100%;padding:0 16mm;text-align:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
    return pdf;
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Read screenshots into base64, within the size budget.
 *
 * Returns how many were left out so the report can state it. Silently dropping
 * evidence from a document whose whole purpose is evidence would be the worst
 * possible failure here.
 */
export async function loadImages(
  screenshots: Screenshot[],
): Promise<{ images: Map<string, string>; omitted: number }> {
  const images = new Map<string, string>();
  let used = 0;
  let omitted = 0;

  for (const s of screenshots) {
    if (s.status !== 'valid' || !s.path) continue;
    try {
      const buf = await fsp.readFile(s.path);
      const b64 = buf.toString('base64');
      if (used + b64.length > IMAGE_BUDGET_BYTES) {
        omitted++;
        continue;
      }
      used += b64.length;
      images.set(s.id, b64);
    } catch (err) {
      // A missing file is a real condition worth knowing about, not noise.
      logger.warn({ path: s.path, err: (err as Error).message }, 'Could not read screenshot for the report');
      omitted++;
    }
  }

  return { images, omitted };
}
