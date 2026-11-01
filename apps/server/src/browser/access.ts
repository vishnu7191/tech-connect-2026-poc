import { chromium } from 'playwright';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import { buildPrototypeUrl } from '../figma/url.js';

/**
 * Determine why a Figma file could not be read, by looking at what a browser
 * actually sees.
 *
 * The REST API is deliberately unhelpful here: it returns 404 for both "this
 * file does not exist" and "this file exists but you cannot see it", so that an
 * attacker cannot probe for file keys. That is good security and terrible
 * diagnostics - on its own it forces Lenz to tell the user a hedged
 * "may lack permission, or may be private", which is not actionable.
 *
 * Opening the prototype anonymously resolves the ambiguity: a sign-in wall
 * means private, a rendered canvas means public (so discovery can continue in
 * the browser even without API access).
 */

export type AccessVerdict =
  | 'public-renders' // anyone can view it - browser discovery is viable
  | 'requires-sign-in' // private or restricted to specific people
  | 'not-found' // wrong key, or deleted
  | 'unknown'; // probe itself failed

export interface AccessProbe {
  verdict: AccessVerdict;
  /** What to tell the user, including what to do about it. */
  message: string;
  /** Whether browser-based discovery can proceed. */
  canUseBrowser: boolean;
  evidence: string | null;
}

const SIGN_IN_PATTERNS = [
  /want to check out this file\?/i,
  /\bsign up or log ?in\b/i,
  /\blog in to (view|continue)\b/i,
  /\bsign in to (view|continue)\b/i,
  /\bcontinue with google\b/i,
  /\byou (don'?t|do not) have access\b/i,
  /\brequest access\b/i,
];

const NOT_FOUND_PATTERNS = [
  /\bthis (file|prototype|page) (is unavailable|was deleted|does not exist)\b/i,
  /\boops[,!]? we can'?t find\b/i,
  /\bpage not found\b/i,
];

/**
 * Open the prototype anonymously and classify what the viewer shows.
 * Uses its own short-lived browser so it can run before the main session.
 */
export async function probeFigmaAccess(
  fileKey: string,
  fileName: string | null,
  nodeId: string | null,
): Promise<AccessProbe> {
  const url = nodeId
    ? buildPrototypeUrl(fileKey, fileName, nodeId)
    : `https://www.figma.com/proto/${fileKey}/${encodeURIComponent((fileName ?? 'file').replace(/\s+/g, '-'))}`;

  let browser;
  try {
    browser = await chromium.launch({ headless: env.HEADLESS, args: ['--disable-dev-shm-usage'] });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The viewer needs time to either render or redirect to a sign-in wall.
    await page.waitForTimeout(9000);

    const canvasCount = await page.locator('canvas').count();
    const text = ((await page.locator('body').innerText().catch(() => '')) ?? '')
      .replace(/\s+/g, ' ')
      .trim();

    // A rendered prototype canvas is decisive: the file is publicly viewable.
    if (canvasCount > 0) {
      return {
        verdict: 'public-renders',
        canUseBrowser: true,
        message:
          'The prototype is publicly viewable in a browser, even though the REST API could not read it.',
        evidence: null,
      };
    }

    for (const p of SIGN_IN_PATTERNS) {
      const m = p.exec(text);
      if (m) {
        return {
          verdict: 'requires-sign-in',
          canUseBrowser: false,
          message:
            'This Figma file is private. Lenz opens prototypes anonymously, and Figma showed a sign-in wall instead of the design. ' +
            'In Figma, open Share and set link access to "Anyone with the link" (Can view), then run discovery again. ' +
            'If it belongs to someone else, ask them to share it or to send you a copy.',
          evidence: text.slice(Math.max(0, m.index - 30), m.index + 120),
        };
      }
    }

    for (const p of NOT_FOUND_PATTERNS) {
      const m = p.exec(text);
      if (m) {
        return {
          verdict: 'not-found',
          canUseBrowser: false,
          message:
            'Figma could not find this file. Check the link is complete and correct - it may have been deleted or moved.',
          evidence: text.slice(Math.max(0, m.index - 30), m.index + 120),
        };
      }
    }

    return {
      verdict: 'unknown',
      canUseBrowser: false,
      message:
        'The Figma viewer did not render this prototype and did not explain why. The file may be private, or Figma may be having trouble.',
      evidence: text.slice(0, 160) || null,
    };
  } catch (err) {
    logger.warn({ fileKey, err: (err as Error).message }, 'Figma access probe failed');
    return {
      verdict: 'unknown',
      canUseBrowser: false,
      message:
        'Lenz could not open this file in a browser to determine why the API rejected it. Check the link and your network connection.',
      evidence: null,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
