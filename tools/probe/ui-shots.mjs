/**
 * Capture screenshots of the Lenz frontend for visual review.
 * Requires `npm run dev` (both server and web) to be running.
 */
import { chromium } from 'playwright';

const OUT = process.argv[2];
const BASE = 'http://localhost:5173';

const browser = await chromium.launch({ headless: true });
const page = await (await browser.newContext({ viewport: { width: 1480, height: 1000 } })).newPage();

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message.slice(0, 200)}`));

async function shot(path, name, { wait = 2500, click } = {}) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(wait);
  if (click) {
    for (const sel of click) {
      try {
        await page.locator(sel).first().click({ timeout: 4000 });
        await page.waitForTimeout(1600);
      } catch {
        console.log(`  (could not click ${sel})`);
      }
    }
  }
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false });
  console.log(`captured ${name}  <- ${path}`);
}

// Discover ids from the API so the script works against real data.
const projects = await page.evaluate(async () => {
  const r = await fetch('http://localhost:5173/api/v1/projects');
  return r.json();
}).catch(() => []);

await page.goto(BASE, { waitUntil: 'networkidle' });
const list = await page.evaluate(async () => (await fetch('/api/v1/projects')).json());
const withScreens = list.find((p) => p.screenCount > 0) ?? list[0];
const execs = withScreens
  ? await page.evaluate(async (id) => (await fetch(`/api/v1/projects/${id}/executions`)).json(), withScreens.id)
  : [];

console.log('project:', withScreens?.id, '| executions:', execs.length);

await shot('/', 'ui-dashboard');
await shot('/projects/new', 'ui-new-project');
if (withScreens) {
  await shot(`/projects/${withScreens.id}`, 'ui-project-overview');
  await shot(`/projects/${withScreens.id}`, 'ui-project-screens', { click: ['button:has-text("Screens")'] });
  await shot(`/projects/${withScreens.id}`, 'ui-project-graph', { click: ['button:has-text("Navigation graph")'] });
  await shot(`/projects/${withScreens.id}`, 'ui-project-entry', { click: ['button:has-text("Entry points")'] });
  await shot(`/projects/${withScreens.id}`, 'ui-project-coverage', { click: ['button:has-text("Coverage")'] });
  await shot(`/projects/${withScreens.id}/personas`, 'ui-personas');
  await shot(`/projects/${withScreens.id}/test-plans`, 'ui-test-plans');
  await shot(`/projects/${withScreens.id}/findings`, 'ui-findings');
}
if (execs[0]) await shot(`/executions/${execs[0].id}`, 'ui-recap', { wait: 4000 });
await shot('/model-lab', 'ui-model-lab');
await shot('/model-lab', 'ui-model-lab-tasks', { click: ['button:has-text("Task routing")'] });

console.log('\nconsole errors:', errors.length);
for (const e of [...new Set(errors)].slice(0, 10)) console.log('  -', e);

await browser.close();
