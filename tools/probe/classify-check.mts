import { classifyNode } from '../../apps/server/src/figma/classify.js';
import fs from 'node:fs';

const file = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

// Collect NAVIGATE destinations + flow starts from the real file.
const navDest = new Set<string>();
const flowStarts = new Set<string>();
const topOwner = new Map<string, string>();

function walk(n: any, top: string) {
  topOwner.set(n.id, top);
  for (const it of n.interactions ?? []) {
    for (const a of it.actions ?? []) {
      if (a.type === 'NODE' && a.destinationId && a.navigation === 'NAVIGATE') navDest.add(a.destinationId);
    }
  }
  for (const c of n.children ?? []) walk(c, top);
}
for (const canvas of file.document.children) {
  if (canvas.prototypeStartNodeID) flowStarts.add(canvas.prototypeStartNodeID);
  for (const f of canvas.flowStartingPoints ?? []) flowStarts.add(f.nodeId);
  for (const top of canvas.children ?? []) walk(top, top.id);
}

let screens = 0, components = 0, ambiguous = 0;
const screenNames: string[] = [], ambiguousNames: string[] = [];
const componentFrames: string[] = [];

for (const canvas of file.document.children) {
  for (const node of canvas.children ?? []) {
    const r = classifyNode({
      node,
      isFlowStart: flowStarts.has(node.id),
      hasInboundNavigate: navDest.has(node.id),
    });
    if (r.classification === 'screen') { screens++; screenNames.push(`${node.name} [${node.type}] ${r.score}`); }
    else if (r.classification === 'ambiguous') { ambiguous++; ambiguousNames.push(`${node.name} [${node.type}] ${r.score}`); }
    else { components++; if (node.type === 'FRAME') componentFrames.push(`${node.name} [${node.type}] ${r.score} w${Math.round(node.absoluteBoundingBox?.width??0)}`); }
  }
}
console.log('SCREENS:', screens, '| COMPONENTS:', components, '| AMBIGUOUS:', ambiguous);
console.log('\n--- classified as SCREEN ---'); screenNames.forEach(n => console.log('  ', n));
console.log('\n--- AMBIGUOUS (needs review) ---'); ambiguousNames.forEach(n => console.log('  ', n));
console.log('\n--- FRAMEs classified as component (possible false negatives) ---'); componentFrames.forEach(n => console.log('  ', n));
