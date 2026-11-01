import { chromium } from 'playwright';
import fs from 'fs';
const OUT = process.argv[2];
const url = 'https://www.figma.com/proto/TJEIgarZebWrehJFEFycYw/E-commerce_website_Rosella?node-id=1-2';
const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
const t0 = Date.now();
try {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('goto ok', Date.now() - t0, 'ms');
  await p.waitForTimeout(12000);
  console.log('title:', await p.title());
  console.log('url  :', p.url());
  // look for the prototype canvas
  const canvases = await p.locator('canvas').count();
  console.log('canvas count:', canvases);
  const bodyText = (await p.locator('body').innerText().catch(()=> '')).slice(0, 300);
  console.log('bodyText:', JSON.stringify(bodyText));
  const shot = await p.screenshot({ path: OUT + '/proto-1.png' });
  console.log('screenshot bytes:', shot.length);
  // blankness heuristic: count distinct bytes
  const uniq = new Set(shot.slice(0, 200000)).size;
  console.log('distinct byte values in shot:', uniq);
} catch (e) {
  console.log('ERR', e.message.slice(0, 300));
}
await b.close();
