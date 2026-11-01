import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Redaction is defence in depth: even if a secret is accidentally attached to a
 * log context, it never reaches the output.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'apiKey',
      '*.apiKey',
      'headers.authorization',
      'headers["x-figma-token"]',
      'req.headers.authorization',
      'NVIDIA_API_KEY',
      'FIGMA_ACCESS_TOKEN',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
    : {}),
});

export type Logger = typeof logger;
