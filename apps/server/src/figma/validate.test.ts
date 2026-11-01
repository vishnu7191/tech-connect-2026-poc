import { describe, it, expect } from 'vitest';
import { validateFigmaDocument } from './validate.js';

const ctx = { fileKey: 'ABC123DEF456', kind: 'proto' };

const canvas = (id: string, children: unknown[] = []) => ({
  id,
  name: `Page ${id}`,
  type: 'CANVAS',
  children,
});

const wrap = (children: unknown) => ({ document: { id: '0:0', type: 'DOCUMENT', children } });

describe('validateFigmaDocument - accepts healthy documents', () => {
  it('returns usable canvases and a node count', () => {
    const r = validateFigmaDocument(wrap([canvas('0:1', [{ id: '1:1', type: 'FRAME' }])]), ctx);
    expect(r.canvases).toHaveLength(1);
    expect(r.totalTopLevelNodes).toBe(1);
    expect(r.notes).toHaveLength(0);
  });

  it('counts across multiple pages', () => {
    const r = validateFigmaDocument(
      wrap([
        canvas('0:1', [{ id: '1:1', type: 'FRAME' }, { id: '1:2', type: 'FRAME' }]),
        canvas('0:2', [{ id: '2:1', type: 'FRAME' }]),
      ]),
      ctx,
    );
    expect(r.canvases).toHaveLength(2);
    expect(r.totalTopLevelNodes).toBe(3);
  });
});

describe('validateFigmaDocument - explains bad payloads instead of crashing', () => {
  it('rejects a null response with a readable message', () => {
    expect(() => validateFigmaDocument(null, ctx)).toThrow(/empty response/i);
  });

  it('rejects a response with no document body', () => {
    expect(() => validateFigmaDocument({}, ctx)).toThrow(/without a document body/i);
  });

  it('rejects a document whose children are not an array', () => {
    expect(() => validateFigmaDocument(wrap('nope'), ctx)).toThrow(/no pages/i);
  });

  it('rejects a document with no usable canvases', () => {
    expect(() => validateFigmaDocument(wrap([{ id: 'x', type: 'FRAME' }]), ctx)).toThrow(
      /none of its pages contain readable content/i,
    );
  });

  it('mentions FigJam and Slides when nothing is readable', () => {
    // Guides the user toward the real cause rather than a generic failure.
    expect(() => validateFigmaDocument(wrap([]), ctx)).toThrow(/FigJam|Slides/i);
  });
});

describe('validateFigmaDocument - tolerates partial damage', () => {
  it('skips null page entries but keeps the good ones', () => {
    const r = validateFigmaDocument(wrap([null, canvas('0:1', [{ id: '1:1', type: 'FRAME' }])]), ctx);
    expect(r.canvases).toHaveLength(1);
    expect(r.notes.join(' ')).toMatch(/not readable/i);
  });

  it('skips a page whose children are missing, and says so', () => {
    const r = validateFigmaDocument(
      wrap([{ id: '0:9', name: 'Broken', type: 'CANVAS' }, canvas('0:1', [{ id: '1:1', type: 'FRAME' }])]),
      ctx,
    );
    expect(r.canvases).toHaveLength(1);
    expect(r.notes.join(' ')).toMatch(/Broken/);
  });

  it('ignores non-canvas top-level nodes', () => {
    const r = validateFigmaDocument(
      wrap([{ id: 'x', type: 'COMPONENT_SET', children: [] }, canvas('0:1', [{ id: '1:1', type: 'FRAME' }])]),
      ctx,
    );
    expect(r.canvases).toHaveLength(1);
  });

  it('notes an entirely empty file rather than failing', () => {
    const r = validateFigmaDocument(wrap([canvas('0:1', [])]), ctx);
    expect(r.totalTopLevelNodes).toBe(0);
    expect(r.notes.join(' ')).toMatch(/empty/i);
  });

  it('does not count null children toward the node total', () => {
    const r = validateFigmaDocument(wrap([canvas('0:1', [null, { id: '1:1', type: 'FRAME' }])]), ctx);
    expect(r.totalTopLevelNodes).toBe(1);
  });
});
