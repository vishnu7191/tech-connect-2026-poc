import fs from 'node:fs';
import { extractFromFile } from '../../apps/server/src/figma/extract.js';
import { analyzeGraph } from '../../apps/server/src/graph/analyze.js';

const file = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const t0 = Date.now();
const ex = extractFromFile(file);
const tExtract = Date.now() - t0;

const screens = ex.screens.filter((s) => s.classification !== 'component');
const t1 = Date.now();
const analysis = analyzeGraph({
  screens: ex.screens,
  edges: ex.edges,
  flows: ex.flows,
  urlStartNodeId: '1:2',
});
const tAnalyze = Date.now() - t1;

const byKind = ex.edges.reduce<Record<string, number>>((a, e) => {
  a[e.kind] = (a[e.kind] ?? 0) + 1;
  return a;
}, {});
const byNav = ex.edges.reduce<Record<string, number>>((a, e) => {
  a[e.figmaNavigation] = (a[e.figmaNavigation] ?? 0) + 1;
  return a;
}, {});

const name = (id: string) => ex.screens.find((s) => s.nodeId === id)?.name ?? id;

console.log('=== EXTRACTION ===', tExtract + 'ms');
console.log('total interaction actions :', ex.totalInteractionActions);
console.log('deduped edges             :', ex.edges.length);
console.log('edges by kind             :', JSON.stringify(byKind));
console.log('edges by figma navigation :', JSON.stringify(byNav));
console.log('unresolved destinations   :', ex.unresolvedDestinations);
console.log('unsupported edges         :', ex.edges.filter((e) => !e.supported).length);
console.log('screens(incl. ambiguous)  :', screens.length);
console.log('components excluded       :', ex.screens.length - screens.length);
console.log('canvases                  :', JSON.stringify(ex.canvases));

console.log('\n=== GRAPH ANALYSIS ===', tAnalyze + 'ms');
console.log('reachable    :', analysis.reachable.size);
console.log('unreachable  :', analysis.unreachable.length);
console.log('disconnected :', analysis.disconnected.length);
console.log('flows (components):', analysis.flows.length, '-> sizes', analysis.flows.map((f) => f.length).join(','));

console.log('\n--- ENTRY POINTS ---');
for (const e of analysis.entryPoints.slice(0, 14)) {
  console.log(
    `  #${e.rank} [${e.kind}] ${e.name} (${e.nodeId}) score=${e.score} src=${e.source}${e.flowName ? ' flow=' + e.flowName : ''}`,
  );
}

console.log('\n--- UNREACHABLE (first 20) ---');
for (const id of analysis.unreachable.slice(0, 20)) console.log('  ', id, name(id));

console.log('\n--- SHORTEST PATH Home -> Cart ---');
const cart = ex.screens.find((s) => s.name === 'Cart');
if (cart) {
  const { shortestPath } = await import('../../apps/server/src/graph/analyze.js');
  const p = shortestPath(analysis.adjacency, '1:2', cart.nodeId);
  console.log('  ', p ? p.map(name).join(' -> ') : 'no path');
}
