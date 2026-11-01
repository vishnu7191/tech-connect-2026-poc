/**
 * Audit of how Lenz calls NVIDIA NIM, against what the endpoint actually
 * supports. Verifies request shape, reasoning controls, and parameters we may
 * be leaving unused.
 */
import { AiConfig } from '../../apps/server/src/ai/config.js';

const cfg = AiConfig.load();
const provider = cfg.getProvider('nvidia-nim')!;
const MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const EP = `${provider.baseUrl}/chat/completions`;

async function call(label: string, body: Record<string, unknown>) {
  const t0 = Date.now();
  try {
    const r = await fetch(EP, {
      method: 'POST',
      headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, ...body }),
    });
    const j: any = await r.json();
    const ms = Date.now() - t0;
    if (j.error) {
      console.log(`${label.padEnd(34)} HTTP ${r.status}  ERROR ${JSON.stringify(j.error).slice(0, 120)}`);
      return;
    }
    const c = j.choices?.[0];
    const u = j.usage ?? {};
    const reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
    console.log(
      `${label.padEnd(34)} HTTP ${r.status}  ${String(ms).padStart(5)}ms  ` +
        `out=${String(u.completion_tokens ?? 0).padStart(5)}  reasoning=${String(reasoning).padStart(5)}  ` +
        `finish=${c?.finish_reason}  content="${(c?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 48)}"`,
    );
  } catch (e) {
    console.log(`${label.padEnd(34)} EXCEPTION ${(e as Error).message.slice(0, 100)}`);
  }
}

const Q = [{ role: 'user', content: 'Name the capital of France. Answer in one word.' }];

console.log('=== baseline: how Lenz calls it today ===');
await call('default (reasoning on)', { messages: Q, max_tokens: 4000, temperature: 0.3 });

console.log('\n=== can reasoning be disabled for simple tasks? ===');
await call('chat_template_kwargs thinking=F', {
  messages: Q, max_tokens: 4000, temperature: 0.3,
  chat_template_kwargs: { thinking: false },
});
await call('chat_template_kwargs thinking=T', {
  messages: Q, max_tokens: 4000, temperature: 0.3,
  chat_template_kwargs: { thinking: true },
});
await call('system /no_think', {
  messages: [{ role: 'system', content: '/no_think' }, ...Q],
  max_tokens: 4000, temperature: 0.3,
});
await call('reasoning_effort=low', { messages: Q, max_tokens: 4000, temperature: 0.3, reasoning_effort: 'low' });

console.log('\n=== other parameters we do not currently send ===');
await call('top_p', { messages: Q, max_tokens: 4000, temperature: 0.3, top_p: 0.9 });
await call('frequency/presence penalty', {
  messages: Q, max_tokens: 4000, temperature: 0.3, frequency_penalty: 0.1, presence_penalty: 0.1,
});
await call('seed (reproducibility)', { messages: Q, max_tokens: 4000, temperature: 0.3, seed: 42 });
await call('stop sequences', { messages: Q, max_tokens: 4000, temperature: 0.3, stop: ['\n\n'] });
