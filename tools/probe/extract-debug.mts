import fs from 'node:fs';
import { extractFromFile } from '../../apps/server/src/figma/extract.js';
import { analyzeGraph } from '../../apps/server/src/graph/analyze.js';

const file = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

console.log('document.type :', file.document?.type);
console.log('canvases      :', file.document?.children?.length);

for (const c of file.document?.children ?? []) {
  const kids = c?.children ?? [];
  console.log(`  canvas ${c?.id} [${c?.type}] "${c?.name}" children=${kids.length}`);
  let nullKids = 0;
  let noType = 0;
  for (const ch of kids) {
    if (ch === null || ch === undefined) nullKids++;
    else if (!ch.type) noType++;
  }
  if (nullKids || noType) console.log(`     !! null children: ${nullKids}, children without type: ${noType}`);
}

// Walk the WHOLE tree looking for null entries inside children arrays.
let nullNodes = 0;
let maxDepth = 0;
const walk = (n: any, d: number) => {
  maxDepth = Math.max(maxDepth, d);
  for (const c of n?.children ?? []) {
    if (c === null || c === undefined) {
      nullNodes++;
      continue;
    }
    walk(c, d + 1);
  }
};
walk(file.document, 0);
console.log('null nodes in tree:', nullNodes, '| max depth:', maxDepth);

try {
  const ex = extractFromFile(file);
  console.log('\nEXTRACT OK');
  console.log('  screens          :', ex.screens.length);
  console.log('  edges            :', ex.edges.length);
  console.log('  interactions     :', ex.totalInteractionActions);
  console.log('  flows            :', ex.flows.length);
  const a = analyzeGraph({
    screens: ex.screens,
    edges: ex.edges,
    flows: ex.flows,
    urlStartNodeId: '47:244',
  });
  console.log('  reachable        :', a.reachable.size);
  console.log('  entryPoints      :', a.entryPoints.length);
} catch (e) {
  console.log('\nEXTRACT THREW:');
  console.log((e as Error).stack?.split('\n').slice(0, 10).join('\n'));
}
