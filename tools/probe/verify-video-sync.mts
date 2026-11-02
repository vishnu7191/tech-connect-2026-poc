/**
 * Ground-truth measurement of how WALL-CLOCK time maps onto VIDEO time in a
 * Playwright recording.
 *
 * Why this exists: markers on the recap video are placed from timestamps taken
 * on the wall clock, but a recorded webm is not guaranteed to be a real-time
 * representation of it. Measured on this host, the container's reported
 * duration disagreed with the wall time it covers by between 0.3% and 2.7%,
 * which over a minute-long run is enough to put a marker on the wrong screen.
 *
 * Rather than guess at a correction, this drives a page whose background is a
 * known colour at every known instant, records it, then seeks the resulting
 * video and reads the pixel back. The colour identifies exactly which moment of
 * real time that video position shows, so the true mapping is measured rather
 * than assumed.
 *
 *   npx tsx tools/probe/verify-video-sync.mts [seconds]
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const RUN_SECONDS = Number(process.argv[2] ?? 30);
/** How often the page changes colour. Each step is one identifiable instant. */
const STEP_MS = 500;
const outDir = path.join(os.tmpdir(), 'lenz-video-sync');
await fsp.mkdir(outDir, { recursive: true });

/**
 * Colours are spaced around the hue circle with a large stride so that
 * neighbouring steps are far apart: a frame landing one step early or late is
 * then unmistakable rather than a near-match.
 */
const hueFor = (i: number) => (i * 47) % 360;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden}
  #b{height:100vh;width:100vw;display:grid;place-items:center;font:700 64px system-ui;color:#fff}
</style></head><body><div id="b">0</div>
<script>
  var stepMs = ${STEP_MS};
  var el = document.getElementById('b');
  window.__marks = [];
  var last = -1;
  function paint() {
    var i = Math.floor((Date.now() - window.__t0) / stepMs);
    if (i !== last && i >= 0) {
      last = i;
      el.style.background = 'hsl(' + ((i * 47) % 360) + ',100%,50%)';
      el.textContent = i;
      window.__marks.push({ i: i, wall: Date.now() });
    }
    requestAnimationFrame(paint);
  }
  window.__start = function () { window.__t0 = Date.now(); paint(); return window.__t0; };
</script></body></html>`;

const pagePath = path.join(outDir, 'clock.html');
await fsp.writeFile(pagePath, PAGE, 'utf8');

console.log('Lenz video-sync ground truth\n');
console.log(`Recording a ${RUN_SECONDS}s colour clock at ${STEP_MS}ms per step\n`);

const videoDir = path.join(outDir, 'rec');
await fsp.rm(videoDir, { recursive: true, force: true });
await fsp.mkdir(videoDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 800, height: 600 },
  recordVideo: { dir: videoDir, size: { width: 800, height: 600 } },
});

const page = await context.newPage();
/** This is exactly what BrowserSession records as the video's time origin. */
const videoStartedAt = Date.now();
await page.goto('file:///' + pagePath.split(path.sep).join('/'), { waitUntil: 'domcontentloaded' });
const t0: number = await page.evaluate(() => (window as never as { __start(): number }).__start());

await page.waitForTimeout(RUN_SECONDS * 1000);

const marks: Array<{ i: number; wall: number }> = await page.evaluate(
  () => (window as never as { __marks: Array<{ i: number; wall: number }> }).__marks,
);
const endedAt = Date.now();
const video = page.video();
await context.close();
const videoPath = await video!.path();
await browser.close();

const wallSpan = endedAt - videoStartedAt;
console.log(`page created at t+0, clock started at t+${t0 - videoStartedAt}ms`);
console.log(`wall span covered by the recording: ${wallSpan}ms`);
console.log(`steps painted: ${marks.length}`);
console.log(`video file: ${(fs.statSync(videoPath).size / 1024).toFixed(0)}kB\n`);

/* ---- Read the video back ---- */

/**
 * Read the video from a local page that sits BESIDE it.
 *
 * A `file://` video cannot be loaded as a subresource of `about:blank` -
 * Chromium treats that as a cross-origin request from an opaque origin and
 * silently yields a 0x0 element with no duration. A local HTML page referencing
 * the file by a relative path is the one arrangement that reliably works.
 */
const playerPath = path.join(outDir, 'player.html');
const relVideo = path.relative(outDir, videoPath).split(path.sep).join('/');
await fsp.writeFile(
  playerPath,
  `<!doctype html><html><body style="margin:0;background:#000">
   <video id="v" src="${relVideo}" preload="auto" muted playsinline></video></body></html>`,
  'utf8',
);

// --allow-file-access-from-files makes the local video same-origin with the
// local player page, without which drawing it to a canvas taints the canvas and
// getImageData throws. Confined to this probe; the product never needs it.
const reader = await chromium.launch({
  headless: true,
  args: ['--allow-file-access-from-files'],
});
const rpage = await reader.newPage();
await rpage.goto('file:///' + playerPath.split(path.sep).join('/'), { waitUntil: 'load' });

const meta = await rpage.evaluate(async () => {
  const v = document.getElementById('v') as HTMLVideoElement;
  (window as never as { __v: HTMLVideoElement }).__v = v;
  await new Promise((res) => {
    if (v.readyState >= 2) return res(null);
    v.addEventListener('loadeddata', res, { once: true });
    v.addEventListener('error', res, { once: true });
    setTimeout(res, 20000);
  });
  if (!Number.isFinite(v.duration)) {
    v.currentTime = 1e7;
    await new Promise((res) => {
      v.addEventListener('seeked', res, { once: true });
      setTimeout(res, 5000);
    });
    v.currentTime = 0;
    await new Promise((res) => {
      v.addEventListener('seeked', res, { once: true });
      setTimeout(res, 3000);
    });
  }
  return {
    duration: v.duration,
    seekableEnd: v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null,
    w: v.videoWidth,
    h: v.videoHeight,
    err: v.error ? v.error.code : null,
  };
});

const realDuration = Number.isFinite(meta.duration) ? meta.duration : (meta.seekableEnd ?? 0);
console.log(`video: ${meta.w}x${meta.h}, duration=${(realDuration * 1000).toFixed(0)}ms`);
console.log(`duration / wall span = ${((realDuration * 1000) / wallSpan).toFixed(4)}\n`);

/** Sample the centre pixel at a given video time and recover the step index. */
async function stepAtVideoTime(seconds: number): Promise<number | null> {
  return rpage.evaluate(async (t) => {
    const v = (window as never as { __v: HTMLVideoElement }).__v;
    v.currentTime = t;
    await new Promise((res) => {
      v.addEventListener('seeked', res, { once: true });
      setTimeout(res, 4000);
    });
    const c = document.createElement('canvas');
    c.width = 60;
    c.height = 60;
    const ctx = c.getContext('2d')!;
    // Sample away from the centred digits so the reading is the background.
    ctx.drawImage(v, 20, 20, 60, 60, 0, 0, 60, 60);
    const d = ctx.getImageData(5, 5, 1, 1).data;
    const r = d[0]! / 255;
    const g = d[1]! / 255;
    const b = d[2]! / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 0.15) return null; // not a saturated colour: unusable frame
    let h = 0;
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h = Math.round(h * 60);
    if (h < 0) h += 360;
    return h;
  }, seconds);
}

/**
 * For each sampled video position, recover which real instant it shows and
 * compare that with the instant each candidate mapping predicts.
 */
const byHue = new Map<number, number[]>();
for (const m of marks) {
  const hue = hueFor(m.i);
  const list = byHue.get(hue) ?? [];
  list.push(m.wall);
  byHue.set(hue, list);
}

const samplePoints = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.95];
const rows: Array<{ vt: number; trueWallOffset: number; linear: number; scaled: number }> = [];

for (const frac of samplePoints) {
  const vt = realDuration * frac;
  const hue = await stepAtVideoTime(vt);
  if (hue === null) {
    console.log(`  video t=${vt.toFixed(2)}s -> unreadable frame`);
    continue;
  }
  const candidates = byHue.get(hue);
  if (!candidates || candidates.length === 0) {
    console.log(`  video t=${vt.toFixed(2)}s -> hue ${hue} matches no painted step`);
    continue;
  }
  // The painted instant this frame shows, as an offset from the video origin.
  const trueWallOffset =
    candidates.reduce((best, w) => {
      const predicted = videoStartedAt + vt * 1000;
      return Math.abs(w - predicted) < Math.abs(best - predicted) ? w : best;
    }, candidates[0]!) - videoStartedAt;

  // Mapping A: video time == wall offset (what the player does today).
  const linear = vt * 1000;
  // Mapping B: rescaled by duration / wall span.
  const scaled = ((vt * 1000) / (realDuration * 1000)) * wallSpan;

  rows.push({ vt: vt * 1000, trueWallOffset, linear, scaled });
}

console.log('video position -> which real instant it actually shows\n');
console.log('  videoMs   showsWallMs   linearErr   scaledErr');
for (const r of rows) {
  console.log(
    `  ${r.vt.toFixed(0).padStart(7)}   ${r.trueWallOffset.toFixed(0).padStart(11)}   ` +
      `${(r.linear - r.trueWallOffset).toFixed(0).padStart(9)}   ${(r.scaled - r.trueWallOffset).toFixed(0).padStart(9)}`,
  );
}

const absAvg = (f: (r: (typeof rows)[number]) => number) =>
  rows.length ? rows.reduce((a, r) => a + Math.abs(f(r)), 0) / rows.length : NaN;

const linearErr = absAvg((r) => r.linear - r.trueWallOffset);
const scaledErr = absAvg((r) => r.scaled - r.trueWallOffset);

console.log('');
console.log(`  mean |error|, treating video time as wall offset : ${linearErr.toFixed(0)}ms`);
console.log(`  mean |error|, rescaled by duration/wallspan      : ${scaledErr.toFixed(0)}ms`);
console.log('');
console.log(
  scaledErr < linearErr - 50
    ? '  => RESCALING IS BETTER. Markers should be scaled by wallSpan/duration.'
    : linearErr < scaledErr - 50
      ? '  => DIRECT MAPPING IS BETTER. Do not rescale; the drift is not linear.'
      : '  => The two are equivalent within measurement noise; prefer the simpler direct mapping.',
);

await reader.close();
console.log(`\nArtifacts: ${outDir}`);
