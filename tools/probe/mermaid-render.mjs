import fs from 'node:fs';
import { chromium } from 'playwright';
const md = fs.readFileSync(process.argv[2], 'utf8');
const idx = Number(process.argv[3] ?? 1) - 1;
const out = process.argv[4];
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 1200 } });
await page.setContent('<!doctype html><html><body style="margin:0;background:#fff"><div id="out"></div></body></html>');
await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js' });
await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false, theme: 'default' }));
await page.evaluate(async (src) => {
  const { svg } = await window.mermaid.render('g1', src);
  document.getElementById('out').innerHTML = svg;
}, blocks[idx]);
await page.waitForTimeout(600);
await page.locator('#out').screenshot({ path: out });
console.log('rendered diagram', idx + 1, '->', out);
await browser.close();
