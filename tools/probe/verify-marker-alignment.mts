/**
 * Does the recap video, at a marker's time, actually show the screen the click
 * happened on?
 *
 * This is the end-to-end check for marker synchronisation, and it needs a real
 * execution: the arithmetic can be unit-tested, but whether the recorded
 * timestamp corresponds to the right frame can only be measured.
 *
 *   npx tsx tools/probe/verify-marker-alignment.mts <executionId> [apiBase]
 *
 * Method: each click's `screenId` is the screen it was performed ON. The video
 * is seeked to the marker's time and the frame fingerprinted, then matched
 * against the run's own screenshots. If the nearest screenshot is the screen
 * the click was on, the marker is aligned; if it is the screen the click
 * navigated TO, the marker is late.
 *
 * History: this probe is why `clickAndVerify` returns `dispatchedAt`. The
 * interaction used to be timestamped after the call had finished polling for
 * the resulting navigation - about 1.2s late - and only 1 of 4 markers landed
 * on the right screen. Stamping the dispatch instead took it to 4 of 4.
 */
import { chromium } from 'playwright';

const EXEC = process.argv[2];
const base = process.argv[3] ?? 'http://127.0.0.1:4000/api/v1';

if (!EXEC) {
  console.error('usage: npx tsx tools/probe/verify-marker-alignment.mts <executionId> [apiBase]');
  process.exit(2);
}

interface Fp {
  node: string | null;
  fp: number[];
}

const timeline = await (await fetch(`${base}/executions/${EXEC}/timeline`)).json();
const shots = await (await fetch(`${base}/executions/${EXEC}/screenshots`)).json();
const valid = shots.filter((s: any) => s.status === 'valid' && s.path);

console.log(`execution ${EXEC}`);
console.log(
  `  videoStartOffsetMs=${timeline.videoStartOffsetMs}  video=${timeline.video?.width}x${timeline.video?.height}`,
);
console.log(`  screenshots=${valid.length}  interactions=${timeline.interactions.length}\n`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
// Same origin as the API, so drawing the video to a canvas does not taint it.
await page.goto(`${base}/health`);

await page.evaluate(async (src) => {
  const v = document.createElement('video');
  v.src = src;
  v.preload = 'auto';
  v.muted = true;
  document.body.appendChild(v);
  (window as any).__v = v;
  await new Promise((res) => {
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', res, { once: true });
    setTimeout(res, 20000);
  });
  // A 16x16 grayscale grid. Crude on purpose: the job is only to say which of
  // a handful of very different screens a frame is, not to judge similarity.
  (window as any).__fp = (el: CanvasImageSource) => {
    const c = document.createElement('canvas');
    c.width = 16;
    c.height = 16;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(el, 0, 0, 16, 16);
    const d = ctx.getImageData(0, 0, 16, 16).data;
    const out: number[] = [];
    for (let i = 0; i < d.length; i += 4) {
      out.push((d[i]! * 0.3 + d[i + 1]! * 0.59 + d[i + 2]! * 0.11) | 0);
    }
    return out;
  };
}, `${base}/executions/${EXEC}/video/file`);

const prints: Fp[] = [];
for (const s of valid) {
  const fp = await page.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await new Promise((res) => {
      img.onload = res;
      img.onerror = res;
      setTimeout(res, 8000);
    });
    return img.naturalWidth ? (window as any).__fp(img) : null;
  }, `${base}/screenshots/${s.id}/file`);
  if (fp) prints.push({ node: s.nodeId, fp });
}

const dist = (a: number[], b: number[]) =>
  a.reduce((acc, v, i) => acc + Math.abs(v - b[i]!), 0) / a.length;

const identify = async (seconds: number) => {
  const fp: number[] = await page.evaluate(async (t) => {
    const v = (window as any).__v as HTMLVideoElement;
    v.currentTime = t;
    await new Promise((res) => {
      v.addEventListener('seeked', res, { once: true });
      setTimeout(res, 5000);
    });
    return (window as any).__fp(v);
  }, Math.max(0, seconds));
  let best: { d: number; node: string | null } | null = null;
  for (const p of prints) {
    const d = dist(fp, p.fp);
    if (!best || d < best.d) best = { d, node: p.node };
  }
  return best!;
};

const clicks = timeline.interactions.filter(
  (e: any) => e.coordinateStatus === 'recorded' && (e.type === 'click' || e.type === 'tap'),
);

if (clicks.length === 0) {
  console.log('No positioned clicks in this execution - nothing to align.');
  await browser.close();
  process.exit(0);
}

const actions = new Map<string, any>(timeline.actions.map((a: any) => [a.id, a]));
let markerHit = 0;
let actionHit = 0;

console.log('clickedOn   markerT   frame@marker   frame@actionOffset (old behaviour)');
for (const e of clicks) {
  const t = (e.videoOffsetMs ?? e.elapsedMs) / 1000;
  const a = actions.get(e.actionId);
  const oldT = a ? (a.offsetMs - (timeline.videoStartOffsetMs || 0)) / 1000 : t;

  const atMarker = await identify(t);
  const atAction = await identify(oldT);
  if (atMarker.node === e.screenId) markerHit++;
  if (atAction.node === e.screenId) actionHit++;

  console.log(
    `${String(e.screenId).padEnd(11)} ${t.toFixed(1).padStart(6)}s   ` +
      `${String(atMarker.node).padEnd(10)}${atMarker.node === e.screenId ? '*' : ' '}   ` +
      `${String(atAction.node).padEnd(10)}${atAction.node === e.screenId ? '*' : ' '}`,
  );
}

console.log(`\nmarkers landing on the screen they were performed on: ${markerHit}/${clicks.length}`);
console.log(`same measured at the action offset:                   ${actionHit}/${clicks.length}`);

await browser.close();

if (markerHit < clicks.length) {
  console.log('\nFAIL: at least one marker does not sit on the screen its click happened on.');
  process.exitCode = 1;
} else {
  console.log('\nPASS: every marker sits on the screen its click happened on.');
}
