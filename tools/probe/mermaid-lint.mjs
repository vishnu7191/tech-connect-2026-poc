import fs from 'node:fs';
import { chromium } from 'playwright';

const file = process.argv[2];
const md = fs.readFileSync(file, 'utf8');
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
console.log(`found ${blocks.length} mermaid block(s) in ${file}`);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent('<!doctype html><html><body><div id="out"></div></body></html>');
await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js' });
await page.evaluate(() => window.mermaid.initialize({ startOnLoad: false }));

let failed = 0;
for (let i = 0; i < blocks.length; i++) {
  const res = await page.evaluate(async (src) => {
    try {
      await window.mermaid.parse(src);
      const { svg } = await window.mermaid.render('g' + Math.random().toString(36).slice(2), src);
      return { ok: true, len: svg.length };
    } catch (e) {
      return { ok: false, err: String(e.message ?? e).slice(0, 220) };
    }
  }, blocks[i]);
  const firstLine = blocks[i].trim().split('\n')[0].slice(0, 42);
  if (res.ok) console.log(`  [${i + 1}] OK   ${firstLine.padEnd(44)} svg=${res.len}b`);
  else { failed++; console.log(`  [${i + 1}] FAIL ${firstLine}\n        ${res.err}`); }
}
await browser.close();
console.log(failed ? `\n${failed} diagram(s) failed` : '\nall diagrams render');
process.exit(failed ? 1 : 0);
