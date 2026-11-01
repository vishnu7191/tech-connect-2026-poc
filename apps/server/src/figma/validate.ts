import { ERROR_CODES } from '@lenz/shared';
import { AppError } from '../core/errors.js';
import type { FigmaCanvas, FigmaFileResponse } from './types.js';

/**
 * Defensive validation of a Figma REST document.
 *
 * Figma's payload is loosely typed and varies by file kind, by age of the file,
 * and by editor. Real examples encountered:
 *   - `"actions": [null]` for a trigger wired with no destination
 *   - canvases with an empty `children` array
 *   - file kinds (FigJam, Slides) whose top level is not a set of frames
 *
 * Every one of those must produce an explanation a user can act on, never a
 * TypeError surfacing as "Cannot read properties of null".
 */

export interface DocumentCheck {
  canvases: FigmaCanvas[];
  totalTopLevelNodes: number;
  /** Non-fatal observations worth reporting in the discovery report. */
  notes: string[];
}

export function validateFigmaDocument(
  file: unknown,
  context: { fileKey: string; kind: string },
): DocumentCheck {
  const bad = (message: string, detail?: string) =>
    new AppError(ERROR_CODES.FIGMA_UNAVAILABLE, message, {
      statusCode: 502,
      internalDetail: detail,
      details: { fileKey: context.fileKey },
    });

  if (!file || typeof file !== 'object') {
    throw bad('Figma returned an empty response for this file. Try again in a moment.');
  }

  const doc = (file as FigmaFileResponse).document as unknown;
  if (!doc || typeof doc !== 'object') {
    throw bad(
      'Figma returned this file without a document body, so there is nothing to discover. This usually means the link points at something other than a design file.',
      'document missing',
    );
  }

  const children = (doc as { children?: unknown }).children;
  if (!Array.isArray(children)) {
    throw bad(
      'This Figma file has no pages that Lenz can read. Check that the link points at a design or prototype file.',
      'document.children is not an array',
    );
  }

  // Keep only well-formed canvases; a malformed entry is skipped and noted
  // rather than allowed to crash the walk.
  const notes: string[] = [];
  const canvases: FigmaCanvas[] = [];
  let skipped = 0;

  for (const c of children) {
    if (!c || typeof c !== 'object') {
      skipped++;
      continue;
    }
    const node = c as FigmaCanvas;
    if (node.type !== 'CANVAS') {
      skipped++;
      continue;
    }
    if (!Array.isArray(node.children)) {
      // A page we cannot read is reported, not silently dropped.
      notes.push(`Page "${node.name ?? node.id}" returned no readable contents and was skipped.`);
      skipped++;
      continue;
    }
    canvases.push(node);
  }

  if (skipped > 0 && canvases.length > 0) {
    notes.push(`${skipped} page(s) in this file were not readable and were skipped.`);
  }

  if (canvases.length === 0) {
    throw bad(
      'Figma returned this file but none of its pages contain readable content. If this is a FigJam board or a Slides deck, Lenz cannot extract screens from it.',
      `0 usable canvases, ${skipped} skipped, kind=${context.kind}`,
    );
  }

  const totalTopLevelNodes = canvases.reduce(
    (sum, c) => sum + (c.children ?? []).filter(Boolean).length,
    0,
  );

  if (totalTopLevelNodes === 0) {
    notes.push(
      'Every page in this file is empty. There are no frames to discover, so screen discovery will return nothing.',
    );
  }

  return { canvases, totalTopLevelNodes, notes };
}
