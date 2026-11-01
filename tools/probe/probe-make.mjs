import { chromium } from 'playwright';
const OUT = process.argv[2];
const url = 'https://www.figma.com/make/p1kRdgwLVWLh06BbR8fpIB/Lenz-UX-Validation-Engine?fullscreen=1&t=ZhDIpp5vzXN3hGNi-1&code-node-id=0-6';
const b = await chromium.launch({ headless: true });
const p = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
try {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await p.waitForTimeout(15000);
  console.log('title:', await p.title());
  console.log('url  :', p.url());
  const frames = p.frames();
  console.log('frames:', frames.length);
  for (const f of frames) console.log('   frame:', (f.url()||'').slice(0, 120));
  console.log('iframes in DOM:', await p.locator('iframe').count());
  const txt = (await p.locator('body').innerText().catch(()=>'')).slice(0, 400);
  console.log('bodyText:', JSON.stringify(txt));
  await p.screenshot({ path: OUT + '/make-1.png' });
  console.log('shot saved');
} catch (e) { console.log('ERR', e.message.slice(0,300)); }
await b.close();
