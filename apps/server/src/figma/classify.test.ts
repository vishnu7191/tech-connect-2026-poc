import { describe, it, expect } from 'vitest';
import { classifyNode } from './classify.js';
import fixture from './__fixtures__/rosella-nodes.json' with { type: 'json' };
import type { FigmaNode } from './types.js';

/**
 * These fixtures are REAL nodes captured from the live Rosella file
 * (TJEIgarZebWrehJFEFycYw), not invented shapes. Classification is a heuristic,
 * so it is pinned against ground truth from the actual file.
 */
const byId = new Map(fixture.nodes.map((n) => [n.id, n as unknown as FigmaNode]));
const node = (id: string): FigmaNode => {
  const n = byId.get(id);
  if (!n) throw new Error(`fixture missing ${id}`);
  return n;
};

const classify = (id: string, opts: { isFlowStart?: boolean; hasInboundNavigate?: boolean } = {}) =>
  classifyNode({
    node: node(id),
    isFlowStart: opts.isFlowStart ?? false,
    hasInboundNavigate: opts.hasInboundNavigate ?? false,
  });

describe('classifyNode - real screens', () => {
  it('classifies Home (1440x5446 FRAME, declared flow start) as a screen', () => {
    const r = classify('1:2', { isFlowStart: true, hasInboundNavigate: true });
    expect(r.classification).toBe('screen');
    expect(r.deviceClass).toBe('desktop');
  });

  it('classifies Details (1440x2449 FRAME) as a screen', () => {
    expect(classify('80:18', { isFlowStart: true }).classification).toBe('screen');
  });

  it('classifies Login as a screen even though its node type is COMPONENT', () => {
    // Real trap: Rosella's Login screen is a COMPONENT, not a FRAME.
    // Type alone would misclassify it; the flow-start signal must win.
    const r = classify('238:293', { isFlowStart: true, hasInboundNavigate: true });
    expect(r.classification).toBe('screen');
  });
});

describe('classifyNode - real design-system components', () => {
  it('rejects the Heart COMPONENT_SET (74x236)', () => {
    const r = classify('21:70');
    expect(r.classification).toBe('component');
  });

  it('rejects Acc_android COMPONENT_SET despite its large 430x4334 size', () => {
    // Size alone would call this a screen - the COMPONENT_SET type must dominate.
    const r = classify('513:8382');
    expect(r.classification).toBe('component');
  });
});

describe('classifyNode - genuinely ambiguous surfaces are flagged, not guessed', () => {
  it('flags "search" (390x30) rather than silently picking a side', () => {
    expect(classify('515:1111').classification).toBe('ambiguous');
  });

  it('flags "Menu  login" (195x380 overlay-sized)', () => {
    const r = classify('425:555');
    expect(r.classification).toBe('ambiguous');
    expect(r.deviceClass).toBe('overlay');
  });
});

describe('classifyNode - signal transparency (ADR-0002)', () => {
  it('records every signal that fired so the verdict is auditable', () => {
    const r = classify('21:70');
    expect(r.signals.length).toBeGreaterThan(0);
    expect(r.signals.some((s) => s.signal === 'type-component-set')).toBe(true);
    // Each signal carries a human-readable justification.
    expect(r.signals.every((s) => typeof s.weight === 'number')).toBe(true);
  });

  it('lets a declared flow start override otherwise weak evidence', () => {
    const withoutFlow = classify('202:782');                      // Sizechart 755x759
    const withFlow = classify('202:782', { isFlowStart: true });
    expect(withFlow.score).toBeGreaterThan(withoutFlow.score);
    expect(withFlow.classification).toBe('screen');
  });
});

describe('real canvas metadata - Scenario A vs B coexist in one file', () => {
  it('Mockup declares a start node and 5 flows', () => {
    const mockup = fixture.canvases.find((c) => c.name === 'Mockup')!;
    expect(mockup.prototypeStartNodeID).toBe('1:2');
    expect(mockup.flowStartingPoints).toHaveLength(5);
  });

  it('Wireframe declares NO entry point - the in-file Scenario B case', () => {
    const wf = fixture.canvases.find((c) => c.name === 'Wireframe')!;
    expect(wf.prototypeStartNodeID).toBeNull();
    expect(wf.flowStartingPoints).toHaveLength(0);
    // Its 14 frames must still be discovered, not dropped.
    expect(wf.childCount).toBe(14);
  });
});
