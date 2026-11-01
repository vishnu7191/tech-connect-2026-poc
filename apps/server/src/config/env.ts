import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
/** apps/server/src/config -> repo root */
export const REPO_ROOT = path.resolve(here, '../../../..');

loadDotenv({ path: path.join(REPO_ROOT, '.env') });

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATA_DIR: z.string().default('./data'),
  HEADLESS: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  FIGMA_ACCESS_TOKEN: z.string().optional(),
  NVIDIA_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function buildEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = buildEnv();

export const paths = {
  root: REPO_ROOT,
  data: path.isAbsolute(env.DATA_DIR) ? env.DATA_DIR : path.join(REPO_ROOT, env.DATA_DIR),
  get db() {
    return path.join(this.data, 'lenz.db');
  },
  get evidence() {
    return path.join(this.data, 'evidence');
  },
  get aiProviders() {
    return path.join(REPO_ROOT, 'config', 'ai-providers.json');
  },
};

/** Figma REST discovery requires a token; without one we degrade to browser-only. */
export const hasFigmaToken = (): boolean => Boolean(env.FIGMA_ACCESS_TOKEN?.trim());
