import { describe, it, expect } from 'vitest';
import { extractFromFile } from './extract.js';
import type { FigmaFileResponse } from './types.js';

/**
 * Regression tests for malformed / sparse Figma payloads.
 *
 * The null-action case is REAL: the file `ceJt3Yi03Morfp70HnMdWaJl` ("Mobile App")
 * returns `{"trigger":{"type":"ON_CLICK"},"actions":[null]}` for 9 of its 76
 * actions. Reading `action.type` on that crashed discovery with
 * "Cannot read properties of null (reading 'type')".
 */

const frame = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  type: 'FRAME',
  absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
  ...extra,
});

const buildFile = (children: unknown[]): FigmaFileResponse =>
  ({
    name: 'Test',
    lastModified: '',
    version: '1',
    role: 'viewer',
    editorType: 'figma',
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [
        {
          id: '0:1',
          name: 'Page 1',
          type: 'CANVAS',
          prototypeStartNodeID: null,
          flowStartingPoints: [],
          children,
        },
      ],
    },
  }) as unknown as FigmaFileResponse;

describe('extractFromFile - null actions (real Figma payload shape)', () => {
  const file = buildFile([
    frame('1:1', 'Home', {
      children: [
        {
          id: '1:2',
          name: 'Dead Button',
          type: 'RECTANGLE',
          absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 40 },
          // Exactly what Figma returned: a trigger with a null action.
          interactions: [{ trigger: { type: 'ON_CLICK' }, actions: [null] }],
        },
        {
          id: '1:3',
          name: 'Working Button',
          type: 'RECTANGLE',
          absoluteBoundingBox: { x: 10, y: 60, width: 100, height: 40 },
          interactions: [
            { trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '2:1', navigation: 'NAVIGATE' }] },
          ],
        },
      ],
    }),
    frame('2:1', 'Details'),
  ]);

  it('does not throw on a null action', () => {
    expect(() => extractFromFile(file)).not.toThrow();
  });

  it('still counts the null action as a discovered interaction', () => {
    // It must not vanish from the totals - that would understate the file.
    expect(extractFromFile(file).totalInteractionActions).toBe(2);
  });

  it('records it as a dead interaction with its trigger and node', () => {
    const dead = extractFromFile(file).deadInteractions;
    expect(dead).toHaveLength(1);
    expect(dead[0]!.nodeName).toBe('Dead Button');
    expect(dead[0]!.trigger).toBe('ON_CLICK');
    expect(dead[0]!.ownerNodeId).toBe('1:1');
  });

  it('does not turn a dead interaction into a graph edge', () => {
    const ex = extractFromFile(file);
    expect(ex.edges).toHaveLength(1);
    expect(ex.edges[0]!.toNodeId).toBe('2:1');
  });
});

describe('extractFromFile - other defensive cases', () => {
  it('tolerates a null interaction entry', () => {
    const file = buildFile([
      frame('1:1', 'Home', {
        children: [{ id: '1:2', name: 'X', type: 'RECTANGLE', interactions: [null] }],
      }),
    ]);
    expect(() => extractFromFile(file)).not.toThrow();
  });

  it('tolerates null entries in a children array', () => {
    const file = buildFile([frame('1:1', 'Home', { children: [null] }), null]);
    expect(() => extractFromFile(file)).not.toThrow();
  });

  it('handles a canvas with no interactions at all', () => {
    const ex = extractFromFile(buildFile([frame('1:1', 'Home')]));
    expect(ex.totalInteractionActions).toBe(0);
    expect(ex.edges).toHaveLength(0);
    expect(ex.deadInteractions).toHaveLength(0);
  });

  it('handles a canvas declaring no entry point (Scenario B)', () => {
    const ex = extractFromFile(buildFile([frame('1:1', 'Home')]));
    expect(ex.flows).toHaveLength(0);
    expect(ex.canvases[0]!.hasEntryPoint).toBe(false);
  });
});
