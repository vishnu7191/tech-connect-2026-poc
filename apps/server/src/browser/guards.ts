import type { Page } from 'playwright';

/**
 * Detect when the Figma viewer is showing something OTHER than the prototype.
 *
 * This matters more than it looks. If a prototype is private, deleted, or
 * requires sign-in, the viewer still renders a perfectly good-looking page -
 * a login wall or an error screen. Without this check Lenz would screenshot
 * that page, pass verification (it is not blank), and report it as a
 * discovered screen. A confidently wrong result is worse than a failure, so
 * these states are detected and named explicitly.
 */

export type ViewerBlock =
  | 'requires-sign-in'
  | 'no-permission'
  | 'not-found'
  | 'prototype-error'
  | null;

interface Signal {
  block: Exclude<ViewerBlock, null>;
  patterns: RegExp[];
  message: string;
}

const SIGNALS: Signal[] = [
  {
    block: 'requires-sign-in',
    patterns: [
      /\bsign in to (view|continue|figma)\b/i,
      /\blog in to (view|continue)\b/i,
      /\bcreate a free account to view\b/i,
    ],
    message:
      'This prototype requires signing in to Figma. Lenz runs anonymously, so it cannot open it. Make the prototype link shareable ("Anyone with the link can view") and try again.',
  },
  {
    block: 'no-permission',
    patterns: [
      /\byou (don'?t|do not) have access\b/i,
      /\brequest access\b/i,
      /\bnot authorized to (view|access)\b/i,
      /\bthis file is private\b/i,
    ],
    message:
      'This prototype is private. Update its share settings to "Anyone with the link can view", or use a link you have access to.',
  },
  {
    block: 'not-found',
    patterns: [
      /\bthis (file|prototype|page) (is unavailable|was deleted|does not exist)\b/i,
      /\boops[,!]? we can'?t find that\b/i,
      /\b404\b.*\bnot found\b/i,
    ],
    message:
      'Figma could not find this prototype. It may have been deleted, moved, or the link may be incomplete.',
  },
  {
    block: 'prototype-error',
    patterns: [
      /\bsomething went wrong\b/i,
      /\bthis prototype (is|has) (unavailable|an error)\b/i,
      /\breload the page to try again\b/i,
    ],
    message:
      'The Figma viewer reported an error instead of rendering the prototype. This is usually temporary - try running discovery again.',
  },
];

export interface ViewerBlockResult {
  block: ViewerBlock;
  message: string | null;
  evidence: string | null;
}

/**
 * Inspect the page for a blocking state.
 *
 * Deliberately conservative: it only reports a block when the page is ALSO
 * missing the prototype canvas, so a design that happens to contain the words
 * "sign in" (a login screen mockup - very common in the files Lenz tests!) is
 * never mistaken for Figma's own login wall.
 */
export async function detectViewerBlock(page: Page): Promise<ViewerBlockResult> {
  let text = '';
  let hasCanvas = false;

  try {
    hasCanvas = (await page.locator('canvas').count()) > 0;
    // Only the viewer's own chrome, not the prototype content rendered to canvas.
    text = (await page.locator('body').innerText({ timeout: 5000 }).catch(() => '')) ?? '';
  } catch {
    return { block: null, message: null, evidence: null };
  }

  // A rendered prototype canvas means the viewer is working; any matching words
  // belong to the DESIGN, not to Figma's chrome.
  if (hasCanvas) return { block: null, message: null, evidence: null };

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return { block: null, message: null, evidence: null };

  for (const signal of SIGNALS) {
    for (const pattern of signal.patterns) {
      const match = pattern.exec(normalized);
      if (match) {
        return {
          block: signal.block,
          message: signal.message,
          evidence: normalized.slice(Math.max(0, match.index - 40), match.index + 120),
        };
      }
    }
  }

  return { block: null, message: null, evidence: null };
}
