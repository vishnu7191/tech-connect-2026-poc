/**
 * Live verification of external integrations. Makes REAL network calls and
 * requires real credentials in .env. Deliberately NOT part of `npm test`, which
 * must stay fast, offline and deterministic.
 *
 *   npm run verify:live
 */
import { z } from 'zod';
import { AiConfig } from '../../apps/server/src/ai/config.js';
import { AiService } from '../../apps/server/src/ai/service.js';
import { FigmaClient } from '../../apps/server/src/figma/client.js';
import { env } from '../../apps/server/src/config/env.js';

let pass = 0;
let fail = 0;
const results: string[] = [];

async function check(name: string, fn: () => Promise<string>) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    pass++;
    results.push(`  PASS  ${name} (${Date.now() - t0}ms)\n          ${detail}`);
  } catch (err) {
    fail++;
    results.push(`  FAIL  ${name} (${Date.now() - t0}ms)\n          ${(err as Error).message}`);
  }
}

console.log('Lenz live verification - real network calls\n');

/* ---------------- AI provider configuration ---------------- */

let config: AiConfig;
await check('AI provider config loads and resolves ${ENV_VAR} placeholders', async () => {
  config = AiConfig.load();
  const p = config.providers.map((x) => `${x.id}(key=${x.apiKey ? 'resolved' : 'none'})`).join(', ');
  return `providers: ${p}`;
});

await check('Public provider view contains NO credentials', async () => {
  const pub = JSON.stringify(config.toPublic());
  if (env.NVIDIA_API_KEY && pub.includes(env.NVIDIA_API_KEY)) {
    throw new Error('LEAK: API key present in the public provider view');
  }
  if (/nvapi-|figd_/.test(pub)) throw new Error('LEAK: credential-like string in public view');
  return 'no credential material in the redacted view';
});

await check('Every AI task resolves to a concrete provider+model', async () => {
  const lines = Object.entries(config.getTaskAssignments()).map(([task]) => {
    const { provider, model } = config.resolveTask(task as never);
    return `${task}->${provider.id}/${model.id.split('/').pop()}`;
  });
  return lines.join(', ');
});

/* ---------------- NVIDIA NIM: live calls ---------------- */

const ai = new AiService(config!);

await check('NIM text completion (live)', async () => {
  const res = await ai.complete('personaGeneration', {
    messages: [{ role: 'user', content: 'Reply with exactly: LENZ_OK' }],
    maxOutputTokens: 2000,
  });
  if (!res.content.includes('LENZ_OK')) throw new Error(`unexpected content: ${res.content.slice(0, 120)}`);
  return `model=${res.modelId} latency=${res.latencyMs}ms reasoningTokens=${res.usage.reasoningTokens} mode=${res.mode}`;
});

await check('NIM structured output validated against a Zod schema (live)', async () => {
  const schema = z.object({
    colors: z.array(z.string()).min(2),
    count: z.number(),
  });
  const res = await ai.completeStructured(
    'testPlanGeneration',
    {
      messages: [{ role: 'user', content: 'List exactly 2 primary colors with their count.' }],
      maxOutputTokens: 3000,
    },
    schema,
    { schemaName: 'colors' },
  );
  return `valid=${res.structuredValid} repairs=${res.repairAttempts} data=${JSON.stringify(res.data)}`;
});

await check('NIM vision with image input (live)', async () => {
  // A 2x2 red PNG - tiny but a genuine image payload.
  const redPng =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z4AATAxIYBQMMUEAAAAA//8DAAJ8APpFjYUeAAAAAElFTkSuQmCC';
  const res = await ai.complete('uxEvaluation', {
    messages: [
      {
        role: 'user',
        content: 'What is the dominant color of this image? Answer with one word.',
        images: [{ mimeType: 'image/png', base64: redPng }],
      },
    ],
    maxOutputTokens: 3000,
  });
  return `answer="${res.content.trim().slice(0, 60)}" latency=${res.latencyMs}ms`;
});

await check('Capability guard rejects vision on a text-only model', async () => {
  try {
    await ai.complete('uxEvaluation', {
      messages: [
        { role: 'user', content: 'describe', images: [{ mimeType: 'image/png', base64: 'AAAA' }] },
      ],
      override: { providerId: 'nvidia-nim', modelId: 'nvidia/llama-3.1-nemotron-70b-instruct' },
    });
    throw new Error('expected a CapabilityError but the call succeeded');
  } catch (err) {
    const msg = (err as Error).message;
    if (!/does not declare support/i.test(msg)) throw err;
    return 'blocked before any network call was made';
  }
});

await check('Reasoning-model truncation is retried, not surfaced as failure', async () => {
  // Deliberately tiny budget: the reasoning trace alone exceeds it, which
  // produced content:null / finish_reason:length during investigation. The
  // adapter must retry with a larger budget and still return an answer.
  const res = await ai.complete('screenAnalysis', {
    messages: [{ role: 'user', content: 'Reply with exactly: RETRY_OK' }],
    maxOutputTokens: 16,
  });
  if (!res.content.trim()) throw new Error('empty content after retry');
  return `recovered, content="${res.content.trim().slice(0, 40)}"`;
});

/* ---------------- Figma REST ---------------- */

if (env.FIGMA_ACCESS_TOKEN) {
  const figma = new FigmaClient(env.FIGMA_ACCESS_TOKEN);

  await check('Figma token is valid', async () => {
    const me = await figma.getMe();
    return `authenticated as ${me.handle}`;
  });

  await check('Figma file metadata for Rosella (live)', async () => {
    const meta = await figma.getFileShallow('TJEIgarZebWrehJFEFycYw');
    return `name="${meta.name}" role=${meta.role} canvases=${meta.document.children.length}`;
  });

  await check('Figma full-file discovery extracts the real graph (live)', async () => {
    const { extractFromFile } = await import('../../apps/server/src/figma/extract.js');
    const file = await figma.getFile('TJEIgarZebWrehJFEFycYw');
    const ex = extractFromFile(file);
    const screens = ex.screens.filter((s) => s.classification !== 'component').length;
    const byKind = ex.edges.reduce<Record<string, number>>((a, e) => {
      a[e.kind] = (a[e.kind] ?? 0) + 1;
      return a;
    }, {});
    if (screens === 0) throw new Error('no screens discovered');
    return `screens=${screens} components=${ex.screens.length - screens} edges=${JSON.stringify(byKind)} flows=${ex.flows.length}`;
  });
} else {
  results.push('  SKIP  Figma checks - FIGMA_ACCESS_TOKEN not set');
}

/* ---------------- Report ---------------- */

console.log(results.join('\n'));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
