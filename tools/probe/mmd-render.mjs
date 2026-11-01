import fs from 'node:fs';
import { chromium } from 'playwright';
const [src, out, w = '1500'] = process.argv.slice(2);
const code = fs.readFileSync(src, 'utf8');
const b = await chromium.launch({ headless: true });
const p = await b.newPage({ viewport: { width: Number(w), height: 900 }, deviceScaleFactor: 2 });
await p.setContent('<!doctype html><html><body style="margin:0;padding:24px;background:#fff"><div id="o"></div></body></html>');
await p.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js' });
await p.evaluate(() => window.mermaid.initialize({ startOnLoad: false, theme: 'base', themeVariables: { fontFamily: 'Segoe UI, Inter, sans-serif' } }));
const r = await p.evaluate(async (c) => { try { const { svg } = await window.mermaid.render('g', c); document.getElementById('o').innerHTML = svg; return 'ok'; } catch (e) { return 'ERR ' + e.message.slice(0, 200); } }, code);
console.log(r);
if (r === 'ok') { await p.waitForTimeout(400); await p.locator('#o').screenshot({ path: out }); console.log('->', out); }
await b.close();
