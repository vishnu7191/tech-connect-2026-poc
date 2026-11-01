import { chromium } from 'playwright';
const OUT = process.argv[2];
const base = 'https://www.figma.com/proto/TJEIgarZebWrehJFEFycYw/E-commerce_website_Rosella';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();

async function dismissBanners() {
  for (const sel of ['button:has-text("Allow all cookies")', 'button:has-text("Do not allow cookies")']) {
    try { const l = p.locator(sel).first(); if (await l.isVisible({ timeout: 1500 })) { await l.click(); console.log('  dismissed:', sel); await p.waitForTimeout(500); } } catch {}
  }
}
// ---- TEST 1: direct node-id URL navigation ----
console.log('== TEST 1: direct URL nav to Details (80:18) ==');
await p.goto(base + '?node-id=80-18', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(9000);
await dismissBanners();
await p.waitForTimeout(2000);
console.log('  url:', p.url());
await p.screenshot({ path: OUT + '/nav-details.png' });

// ---- TEST 2: click navigation from Home ----
console.log('== TEST 2: click nav from Home (1:2) ==');
await p.goto(base + '?node-id=1-2', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForTimeout(9000);
await dismissBanners();
await p.waitForTimeout(1500);
console.log('  url before click:', p.url());
// "Explore Now" button approx center from screenshot: x=264,y=491
await p.mouse.click(264, 491);
await p.waitForTimeout(6000);
console.log('  url after  click:', p.url());
await p.screenshot({ path: OUT + '/nav-afterclick.png' });
await b.close();
