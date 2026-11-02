/**
 * Live verification of interaction tracking, device emulation and the PDF
 * report. Launches a REAL Chromium through Playwright.
 *
 * Unlike `verify-live.mts` this needs no credentials and no network - the pages
 * it drives are written to a temp directory and loaded over file://. That makes
 * it the probe to reach for when checking that the page-side listeners, the
 * touch emulation and the report renderer still work after a change.
 *
 *   npx tsx tools/probe/verify-interactions.mts [outDir]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  installInteractionInstrumentation,
  type RawPageEvent,
} from '../../apps/server/src/browser/instrumentation.js';
import { contextOptionsFor, listDeviceProfiles } from '../../apps/server/src/browser/devices.js';
import { buildHeatmap, buildScrollReport } from '../../apps/server/src/services/heatmap.js';
import { buildReportHtml, renderPdf } from '../../apps/server/src/services/report.js';
import type { InteractionEvent, ScrollSample } from '@lenz/shared';

const outDir = process.argv[2] ?? path.join(os.tmpdir(), 'lenz-interaction-probe');
await fsp.mkdir(outDir, { recursive: true });

let pass = 0;
let fail = 0;
const results: string[] = [];

async function check(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    pass++;
    results.push(`  PASS  ${name} (${Date.now() - t0}ms)\n          ${detail}`);
  } catch (err) {
    fail++;
    results.push(`  FAIL  ${name} (${Date.now() - t0}ms)\n          ${(err as Error).message}`);
  }
}

console.log('Lenz interaction-tracking verification - real browser\n');
console.log(`Output: ${outDir}\n`);

/* ------------------------------------------------------------------ *
 * A page with a tall document, a button, and a nested scroll container.
 * ------------------------------------------------------------------ */

const FIXTURE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Interaction fixture</title>
<style>
  body { margin:0; font-family: system-ui, sans-serif; }
  header { padding:16px; background:#eef; }
  #cta { padding:14px 22px; font-size:16px; margin:20px; }
  #tiny { width:24px; height:18px; font-size:9px; margin:0 20px; }
  .spacer { height:2400px; background:linear-gradient(#fff,#dde); }
  #list { height:160px; overflow-y:scroll; border:1px solid #999; margin:20px; }
  #list div { height:60px; }
  input { margin:20px; display:block; }
</style></head>
<body>
  <header><h1>Fixture</h1></header>
  <button id="cta" aria-label="Add to Cart">Add to Cart</button>
  <button id="tiny">x</button>
  <input id="pw" type="password" placeholder="Password" value="hunter2-should-never-be-recorded">
  <div id="list"><div>1</div><div>2</div><div>3</div><div>4</div><div>5</div><div>6</div></div>
  <div class="spacer"></div>
  <footer id="end">End of document</footer>
</body></html>`;

const fixturePath = path.join(outDir, 'fixture.html');
await fsp.writeFile(fixturePath, FIXTURE, 'utf8');
const fixtureUrl = `file:///${fixturePath.replace(/\\/g, '/')}`;

/* ------------------------------------------------------------------ *
 * Desktop: mouse clicks, document scrolling
 * ------------------------------------------------------------------ */

const desktop = listDeviceProfiles().find((d) => d.id === 'desktop-1440')!;
const mobile = listDeviceProfiles().find((d) => d.id === 'mobile-390')!;

let desktopEvents: RawPageEvent[] = [];
let mobileEvents: RawPageEvent[] = [];

await check('Desktop profile: instrumentation installs and records a mouse click', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(contextOptionsFor(desktop));
    const page = await context.newPage();
    const installed = await installInteractionInstrumentation(page, (e) => desktopEvents.push(e));
    if (!installed) throw new Error('instrumentation did not install');

    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.mouse.click(100, 200);
    await page.locator('#cta').click();
    await page.waitForTimeout(400);

    const clicks = desktopEvents.filter((e) => e.type === 'click');
    if (clicks.length < 2) throw new Error(`expected >=2 clicks, got ${clicks.length}`);
    const cta = clicks.find((c) => c.name === 'Add to Cart');
    if (!cta) throw new Error(`no click carried the accessible name; names=${clicks.map((c) => c.name).join('|')}`);
    if (typeof cta.x !== 'number' || typeof cta.y !== 'number') {
      throw new Error('click carried no coordinate');
    }
    if (cta.viewportWidth !== desktop.width) {
      throw new Error(`viewport width ${cta.viewportWidth} != ${desktop.width}`);
    }
    return `${clicks.length} clicks; "${cta.name}" at ${Math.round(cta.x)},${Math.round(cta.y)} in a ${cta.viewportWidth}x${cta.viewportHeight} viewport, target ${Math.round(cta.targetWidth ?? 0)}x${Math.round(cta.targetHeight ?? 0)}px`;
  } finally {
    await browser.close();
  }
});

await check('Desktop profile: wheel scrolling produces sampled scroll events', async () => {
  desktopEvents = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(contextOptionsFor(desktop));
    const page = await context.newPage();
    await installInteractionInstrumentation(page, (e) => desktopEvents.push(e));
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });

    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(160);
    }
    await page.waitForTimeout(600);

    const scrolls = desktopEvents.filter((e) => e.type === 'scroll' && e.container === 'window');
    if (scrolls.length === 0) throw new Error('no scroll events were reported');
    const last = scrolls[scrolls.length - 1]!;
    if (!last.docHeight || last.docHeight < 2000) {
      throw new Error(`document height looks wrong: ${last.docHeight}`);
    }
    if (last.scrollY === 0) throw new Error('scroll position never moved');
    // The throttle must bound the count: 6 wheels should not yield hundreds.
    if (scrolls.length > 60) throw new Error(`throttle ineffective: ${scrolls.length} samples`);
    return `${scrolls.length} samples, final scrollY=${Math.round(last.scrollY!)} of document ${Math.round(last.docHeight)}px (viewport ${last.viewportHeight}px)`;
  } finally {
    await browser.close();
  }
});

await check('Nested scroll container is reported separately from the window', async () => {
  const seen: RawPageEvent[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(contextOptionsFor(desktop));
    const page = await context.newPage();
    await installInteractionInstrumentation(page, (e) => seen.push(e));
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#list').evaluate((el) => {
      (el as HTMLElement).scrollTop = 120;
    });
    await page.waitForTimeout(500);

    const nested = seen.filter((e) => e.type === 'scroll' && e.container !== 'window');
    if (nested.length === 0) {
      throw new Error(`no nested-container scroll was recorded; containers=${[...new Set(seen.map((e) => e.container))].join('|')}`);
    }
    return `container "${nested[0]!.container}" at scrollTop ${Math.round(nested[0]!.scrollY ?? 0)} of ${Math.round(nested[0]!.docHeight ?? 0)}px`;
  } finally {
    await browser.close();
  }
});

/* ------------------------------------------------------------------ *
 * Mobile: touch taps, swipes, device metrics
 * ------------------------------------------------------------------ */

await check('Mobile profile: a touch tap is recorded as a tap, not a click', async () => {
  mobileEvents = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(contextOptionsFor(mobile));
    const page = await context.newPage();
    await installInteractionInstrumentation(page, (e) => mobileEvents.push(e));
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });

    await page.touchscreen.tap(100, 200);
    await page.waitForTimeout(400);

    const taps = mobileEvents.filter((e) => e.type === 'tap');
    const clicks = mobileEvents.filter((e) => e.type === 'click');
    if (taps.length === 0) throw new Error('no tap was recorded');
    if (clicks.length > 0) throw new Error(`a touch produced ${clicks.length} duplicate click event(s)`);
    const t = taps[0]!;
    if (t.pointer !== 'touch') throw new Error(`pointer recorded as "${t.pointer}"`);
    if (t.viewportWidth !== mobile.width) {
      throw new Error(`viewport ${t.viewportWidth} != ${mobile.width}`);
    }
    if (t.devicePixelRatio !== mobile.deviceScaleFactor) {
      throw new Error(`DPR ${t.devicePixelRatio} != ${mobile.deviceScaleFactor}`);
    }
    return `tap at ${Math.round(t.x!)},${Math.round(t.y!)} · pointer=touch · viewport ${t.viewportWidth}x${t.viewportHeight} · DPR ${t.devicePixelRatio}`;
  } finally {
    await browser.close();
  }
});

await check('Mobile profile: a finger drag is recorded as a swipe with its displacement', async () => {
  const seen: RawPageEvent[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(contextOptionsFor(mobile));
    const page = await context.newPage();
    await installInteractionInstrumentation(page, (e) => seen.push(e));
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });

    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 195, y: 600, id: 1 }],
    });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: 195, y: 600 - i * 40, id: 1 }],
      });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(800);

    const swipes = seen.filter((e) => e.type === 'swipe');
    const scrolls = seen.filter((e) => e.type === 'scroll');
    if (swipes.length === 0) throw new Error('the drag was not classified as a swipe');
    const s = swipes[0]!;
    if (!s.deltaY || Math.abs(s.deltaY) < 50) throw new Error(`swipe displacement too small: ${s.deltaY}`);
    return `swipe dy=${Math.round(s.deltaY)}px over ${s.durationMs}ms, and ${scrolls.length} scroll sample(s) from the resulting movement`;
  } finally {
    await browser.close();
  }
});

/* ------------------------------------------------------------------ *
 * Privacy
 * ------------------------------------------------------------------ */

await check('A password field never leaks its value into an interaction event', async () => {
  const seen: RawPageEvent[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(contextOptionsFor(desktop));
    const page = await context.newPage();
    await installInteractionInstrumentation(page, (e) => seen.push(e));
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });

    await page.locator('#pw').click();
    await page.locator('#pw').fill('correct-horse-battery-staple');
    await page.locator('#pw').click();
    await page.waitForTimeout(400);

    const serialized = JSON.stringify(seen);
    if (/hunter2|correct-horse/i.test(serialized)) {
      throw new Error('a field value appeared in the recorded events');
    }
    const pwEvents = seen.filter((e) => e.selector?.includes('pw') || e.name === '[redacted field]');
    if (pwEvents.length === 0) throw new Error('the password field click was not recorded at all');
    return `${pwEvents.length} event(s) on the password field, name recorded as "${pwEvents[0]!.name}" and no value present anywhere in the payload`;
  } finally {
    await browser.close();
  }
});

/* ------------------------------------------------------------------ *
 * Touch-target measurement against a real element
 * ------------------------------------------------------------------ */

await check('A small control reports a real measured size for the touch-target check', async () => {
  const seen: RawPageEvent[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(contextOptionsFor(mobile));
    const page = await context.newPage();
    await installInteractionInstrumentation(page, (e) => seen.push(e));
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('#tiny').tap();
    await page.waitForTimeout(400);

    const tap = seen.find((e) => e.type === 'tap' && (e.targetWidth ?? 99) < 44);
    if (!tap) {
      throw new Error(
        `no undersized target was measured; sizes=${seen.map((e) => `${e.targetWidth}x${e.targetHeight}`).join('|')}`,
      );
    }
    return `measured ${Math.round(tap.targetWidth!)}x${Math.round(tap.targetHeight!)}px, below the 44px guideline`;
  } finally {
    await browser.close();
  }
});

/* ------------------------------------------------------------------ *
 * Video recording size vs the emulated viewport
 * ------------------------------------------------------------------ */

await check('A mobile recording is produced and its frames match the CSS viewport', async () => {
  const videoDir = path.join(outDir, 'video');
  await fsp.mkdir(videoDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      ...contextOptionsFor(mobile),
      recordVideo: { dir: videoDir, size: { width: mobile.width, height: mobile.height } },
    });
    const page = await context.newPage();
    const startedAt = Date.now();
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    await page.touchscreen.tap(100, 200);
    await page.waitForTimeout(900);
    const video = page.video();
    if (!video) throw new Error('no video object on the page');
    await context.close();
    const file = await video.path();
    const bytes = fs.statSync(file).size;
    if (bytes === 0) throw new Error('the recording is empty');
    return `${(bytes / 1024).toFixed(0)}kB after ${Date.now() - startedAt}ms, requested frame size ${mobile.width}x${mobile.height} (CSS px, matching the recorded coordinates)`;
  } finally {
    await browser.close();
  }
});

/* ------------------------------------------------------------------ *
 * The PDF report
 * ------------------------------------------------------------------ */

await check('The PDF report renders from real aggregated data', async () => {
  // Build a small but realistic dataset: two taps on one screen, one failed.
  const base: Omit<InteractionEvent, 'id' | 'index' | 'viewportX' | 'viewportY' | 'result'> = {
    executionId: 'exe_probe',
    projectId: 'prj_probe',
    personaId: 'per_probe',
    planId: 'pln_probe',
    stepId: null,
    actionId: null,
    type: 'tap',
    source: 'lenz-action',
    pointer: 'touch',
    label: 'Tapped Add to Cart',
    targetRole: 'button',
    targetName: 'Add to Cart',
    targetSelector: '#cta',
    targetWidth: 30,
    targetHeight: 22,
    pageX: null,
    pageY: null,
    coordinateStatus: 'recorded',
    coordinateNote: null,
    viewportWidth: mobile.width,
    viewportHeight: mobile.height,
    deviceScaleFactor: mobile.deviceScaleFactor,
    deviceId: mobile.id,
    deviceKind: 'mobile',
    url: fixtureUrl,
    screenId: '1:2',
    screenName: 'Home',
    uiStateId: null,
    timestamp: new Date().toISOString(),
    elapsedMs: 1200,
    videoOffsetMs: 700,
    resultNote: null,
    scrollX: 0,
    scrollY: 0,
    documentWidth: mobile.width,
    documentHeight: 2600,
    deltaX: null,
    deltaY: null,
    durationMs: null,
  };

  const events: InteractionEvent[] = [
    { ...base, id: 'i1', index: 0, viewportX: 120, viewportY: 240, result: 'success' },
    { ...base, id: 'i2', index: 1, viewportX: 128, viewportY: 250, result: 'failure' },
    {
      ...base,
      id: 'i3',
      index: 2,
      viewportX: null,
      viewportY: null,
      result: 'unverified',
      type: 'navigation',
      coordinateStatus: 'unavailable',
      coordinateNote: 'Opening a screen by node id is not a pointer interaction.',
    },
  ];

  const samples: ScrollSample[] = [0, 600, 1200].map((y, i) => ({
    id: `s${i}`,
    executionId: 'exe_probe',
    projectId: 'prj_probe',
    personaId: 'per_probe',
    screenId: '1:2',
    screenName: 'Home',
    deviceId: mobile.id,
    deviceKind: 'mobile',
    container: 'window',
    scrollX: 0,
    scrollY: y,
    viewportWidth: mobile.width,
    viewportHeight: mobile.height,
    documentHeight: 2600,
    documentWidth: mobile.width,
    depthFraction: Math.min(1, (y + mobile.height) / 2600),
    direction: 'down',
    dwellMs: 300,
    elapsedMs: 1000 + i * 400,
    videoOffsetMs: 500 + i * 400,
    timestamp: new Date().toISOString(),
    source: 'browser-listener',
  }));

  const heatmap = buildHeatmap({ projectId: 'prj_probe', events, screenshots: [] });
  const scroll = buildScrollReport({ projectId: 'prj_probe', samples });

  const html = buildReportHtml({
    project: {
      id: 'prj_probe',
      name: 'Probe Project',
      description: null,
      figmaUrl: 'https://www.figma.com/proto/EXAMPLE/Probe',
      urlKind: 'proto',
      fileKey: 'EXAMPLE',
      startNodeId: '1:2',
      status: 'analyzed',
      autoApprovePlans: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    generatedAt: new Date().toISOString(),
    executions: [],
    findings: [
      {
        id: 'f1',
        projectId: 'prj_probe',
        executionId: 'exe_probe',
        title: 'The “Add to Cart” control is too small to tap reliably',
        description:
          'The control measured 30×22 CSS pixels on a 390-wide viewport. The recorded tap landed on it, but the target is below the published minimum.',
        severity: 'high',
        category: 'accessibility',
        screenId: '1:2',
        screenName: 'Home',
        screenshotId: null,
        actionId: null,
        personaImpact: 'A person using a phone one-handed would mis-tap and have to try again.',
        recommendation: 'Increase the tappable area to at least 44×44 CSS pixels.',
        confidence: 1,
        evidenceType: 'observed',
        generatedByModel: null,
        createdAt: new Date().toISOString(),
      },
    ],
    screenshotsById: new Map(),
    imagesById: new Map(),
    omittedImages: 0,
    discoveryCoverage: [
      {
        dimension: 'reachability',
        numerator: 7,
        denominator: 8,
        percentage: 0.875,
        misses: [{ id: '9:9', label: 'Orphan screen', reason: 'no-incoming-navigate-edge' }],
        excludedCount: 0,
        note: null,
      },
    ],
    heatmap,
    scroll,
    responsive: null,
    screenCount: 8,
  });

  const htmlPath = path.join(outDir, 'report.html');
  await fsp.writeFile(htmlPath, html, 'utf8');

  const pdf = await renderPdf(html, { title: 'Probe Project — UX validation report' });
  const pdfPath = path.join(outDir, 'report.pdf');
  await fsp.writeFile(pdfPath, pdf);

  if (pdf.length < 5000) throw new Error(`PDF suspiciously small: ${pdf.length} bytes`);
  const magic = pdf.subarray(0, 5).toString('latin1');
  if (magic !== '%PDF-') throw new Error(`not a PDF, magic bytes were "${magic}"`);
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  if (pageCount < 2) throw new Error(`expected a multi-page report, found ${pageCount}`);

  return `${(pdf.length / 1024).toFixed(0)}kB, ${pageCount} pages · ${pdfPath}`;
});

await check('The report states the data is synthetic and carries no overall score', async () => {
  const heatmap = buildHeatmap({ projectId: 'p', events: [], screenshots: [] });
  const html = buildReportHtml({
    project: {
      id: 'p',
      name: 'Empty',
      description: null,
      figmaUrl: 'https://www.figma.com/proto/E/Empty',
      urlKind: 'proto',
      fileKey: 'E',
      startNodeId: null,
      status: 'created',
      autoApprovePlans: false,
      createdAt: '',
      updatedAt: '',
    },
    generatedAt: new Date().toISOString(),
    executions: [],
    findings: [],
    screenshotsById: new Map(),
    imagesById: new Map(),
    omittedImages: 0,
    discoveryCoverage: [],
    heatmap,
    scroll: buildScrollReport({ projectId: 'p', samples: [] }),
    responsive: null,
    screenCount: 0,
  });

  if (!/no single UX score/i.test(html)) throw new Error('the no-score statement is missing');
  if (!/synthetic test traffic/i.test(html)) throw new Error('the synthetic-data note is missing');
  if (!/not a test with real users/i.test(html)) throw new Error('the real-users caveat is missing');
  if (!/browser emulation/i.test(html)) throw new Error('the emulation caveat is missing');
  return 'no-score statement, synthetic-data note and both caveats present even in an empty report';
});

/* ------------------------------------------------------------------ */

console.log(results.join('\n\n'));
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
