import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env, hasFigmaToken, paths } from './config/env.js';
import { logger } from './core/logger.js';
import { getDb } from './db/index.js';
import { Repositories } from './db/repositories.js';
import { getJobQueue } from './jobs/queue.js';
import { getAiConfig } from './ai/config.js';
import { registerRoutes } from './routes/index.js';

export async function buildServer() {
  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: 8 * 1024 * 1024,
    // Trust proxy is intentionally OFF: without a known proxy in front,
    // X-Forwarded-* headers are attacker-controlled.
    trustProxy: false,
  });

  await app.register(cors, {
    origin: env.NODE_ENV === 'development' ? true : false,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  });

  const repos = new Repositories(getDb());
  const jobs = getJobQueue(repos);
  await registerRoutes(app, { repos, jobs });

  return app;
}

async function main() {
  // Validate configuration BEFORE binding a port, so a misconfigured server
  // fails loudly at startup instead of on the first AI call.
  let aiSummary: string;
  try {
    const cfg = getAiConfig();
    const enabled = cfg.providers.filter((p) => p.enabled);
    aiSummary = enabled
      .map((p) => `${p.id} (${p.models.filter((m) => m.enabled).length} models)`)
      .join(', ');
  } catch (err) {
    logger.fatal((err as Error).message);
    process.exit(1);
  }

  const app = await buildServer();

  try {
    await app.listen({ port: env.PORT, host: '127.0.0.1' });
  } catch (err) {
    logger.fatal({ err }, 'Could not start the server');
    process.exit(1);
  }

  logger.info(
    {
      port: env.PORT,
      dataDir: paths.data,
      figmaToken: hasFigmaToken() ? 'configured' : 'MISSING (browser-only discovery)',
      aiProviders: aiSummary,
      headless: env.HEADLESS,
    },
    'Lenz server ready',
  );

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Only run when executed directly, so tests can import buildServer().
const isDirectRun = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');
if (isDirectRun || process.env.LENZ_START === '1') {
  void main();
}
