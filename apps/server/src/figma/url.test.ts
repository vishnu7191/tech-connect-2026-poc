import { describe, it, expect } from 'vitest';
import {
  parseFigmaUrl,
  normalizeNodeId,
  nodeIdToUrlForm,
  buildPrototypeUrl,
  extractNodeIdFromViewerUrl,
  isAllowedFigmaHost,
} from './url.js';

// The three URLs named in the brief as initial validation scenarios.
const ROSELLA_WITH_START =
  'https://www.figma.com/proto/TJEIgarZebWrehJFEFycYw/E-commerce_website_Rosella?node-id=1-2';
const ROSELLA_NO_START =
  'https://www.figma.com/proto/TJEIgarZebWrehJFEFycYw/E-commerce_website_Rosella';
const MAKE_URL =
  'https://www.figma.com/make/p1kRdgwLVWLh06BbR8fpIB/Lenz-UX-Validation-Engine?fullscreen=1&t=ZhDIpp5vzXN3hGNi-1&code-node-id=0-6';

describe('normalizeNodeId', () => {
  it('converts URL form to Figma internal form', () => {
    expect(normalizeNodeId('1-2')).toBe('1:2');
    expect(normalizeNodeId('463-985')).toBe('463:985');
  });
  it('accepts the colon form unchanged (real links use both)', () => {
    expect(normalizeNodeId('47:244')).toBe('47:244');
  });
  it('round-trips with nodeIdToUrlForm', () => {
    expect(nodeIdToUrlForm(normalizeNodeId('80-18')!)).toBe('80-18');
  });
  it('returns null for empty input', () => {
    expect(normalizeNodeId(null)).toBeNull();
    expect(normalizeNodeId('  ')).toBeNull();
  });
  it('rejects junk rather than inventing an id', () => {
    expect(normalizeNodeId('not-a-node')).toBeNull();
    expect(normalizeNodeId('<script>')).toBeNull();
  });
  it('handles a percent-encoded colon', () => {
    expect(normalizeNodeId('47%3A244')).toBe('47:244');
  });
});

describe('parseFigmaUrl - Scenario A (prototype with start point)', () => {
  const parsed = parseFigmaUrl(ROSELLA_WITH_START);
  it('classifies as proto', () => expect(parsed.kind).toBe('proto'));
  it('extracts the file key', () => expect(parsed.fileKey).toBe('TJEIgarZebWrehJFEFycYw'));
  it('extracts and normalizes the start node', () => expect(parsed.startNodeId).toBe('1:2'));
  it('flags an explicit start point', () => expect(parsed.hasExplicitStartPoint).toBe(true));
  it('supports REST discovery', () => expect(parsed.supportsRestDiscovery).toBe(true));
  it('reports full workflow support', () => expect(parsed.support).toBe('full'));
});

describe('parseFigmaUrl - Scenario B (prototype WITHOUT start point)', () => {
  const parsed = parseFigmaUrl(ROSELLA_NO_START);
  // The critical requirement: a missing node-id must never be an error.
  it('parses successfully without node-id', () => expect(parsed.kind).toBe('proto'));
  it('yields a null start node rather than throwing', () => expect(parsed.startNodeId).toBeNull());
  it('flags that no explicit start point was given', () =>
    expect(parsed.hasExplicitStartPoint).toBe(false));
  it('still extracts the same file key as Scenario A', () =>
    expect(parsed.fileKey).toBe('TJEIgarZebWrehJFEFycYw'));
});

describe('parseFigmaUrl - Scenario C (Figma Make)', () => {
  const parsed = parseFigmaUrl(MAKE_URL);
  it('classifies as make', () => expect(parsed.kind).toBe('make'));
  it('extracts the make file key', () => expect(parsed.fileKey).toBe('p1kRdgwLVWLh06BbR8fpIB'));
  it('extracts code-node-id', () => expect(parsed.codeNodeId).toBe('0:6'));
  it('disables REST prototype discovery', () => expect(parsed.supportsRestDiscovery).toBe(false));
  it('reports browser-only support', () => expect(parsed.support).toBe('browser-only'));
});

describe('parseFigmaUrl - every recognised Figma link type', () => {
  const cases: Array<[string, string, string]> = [
    ['design', 'https://www.figma.com/design/ABC123DEF456/My-Design', 'structural'],
    ['file', 'https://www.figma.com/file/ABC123DEF456/My-Design', 'structural'],
    ['board', 'https://www.figma.com/board/ABC123DEF456/My-Board', 'structural'],
    ['slides', 'https://www.figma.com/slides/ABC123DEF456/My-Deck', 'structural'],
    ['deck', 'https://www.figma.com/deck/ABC123DEF456/My-Deck', 'structural'],
    ['proto', 'https://www.figma.com/proto/ABC123DEF456/My-Proto', 'full'],
    ['make', 'https://www.figma.com/make/ABC123DEF456/My-App', 'browser-only'],
  ];

  for (const [kind, url, support] of cases) {
    it(`classifies /${kind}/ links and states their support level`, () => {
      const p = parseFigmaUrl(url);
      expect(p.kind).toBe(kind);
      expect(p.support).toBe(support);
      // Every type must explain itself to the user.
      expect(p.supportNote.length).toBeGreaterThan(20);
    });
  }
});

describe('parseFigmaUrl - real-world link shapes', () => {
  it('handles the colon node-id form with tracking params', () => {
    // The exact link a user reported failing on.
    const p = parseFigmaUrl(
      'https://figma.com/proto/ceJt3Yi03Morfp70HnMdWaJl/Mobile-App?node-id=47:244&scaling=scale-down&utm_source=chatgpt.com',
    );
    expect(p.kind).toBe('proto');
    expect(p.fileKey).toBe('ceJt3Yi03Morfp70HnMdWaJl');
    expect(p.startNodeId).toBe('47:244');
  });

  it('accepts a link pasted without a scheme', () => {
    expect(parseFigmaUrl('figma.com/proto/ABC123DEF456/X').kind).toBe('proto');
  });

  it('accepts a link with no file-name segment', () => {
    const p = parseFigmaUrl('https://www.figma.com/proto/ABC123DEF456');
    expect(p.fileKey).toBe('ABC123DEF456');
    expect(p.fileName).toBeNull();
  });

  it('tolerates a trailing slash', () => {
    expect(parseFigmaUrl('https://www.figma.com/proto/ABC123DEF456/Name/').fileKey).toBe('ABC123DEF456');
  });

  it('unwraps an embed link to the real file', () => {
    const inner = encodeURIComponent('https://www.figma.com/proto/ABC123DEF456/Name?node-id=1-2');
    const p = parseFigmaUrl(`https://www.figma.com/embed?embed_host=share&url=${inner}`);
    expect(p.kind).toBe('proto');
    expect(p.startNodeId).toBe('1:2');
  });

  it('captures branch-id when present', () => {
    const p = parseFigmaUrl('https://www.figma.com/design/ABC123DEF456/N?branch-id=xyz');
    expect(p.branchId).toBe('xyz');
  });

  it('ignores unrelated tracking parameters', () => {
    const p = parseFigmaUrl('https://www.figma.com/proto/ABC123DEF456/N?utm_source=x&t=abc');
    expect(p.fileKey).toBe('ABC123DEF456');
  });
});

describe('parseFigmaUrl - actionable errors, not dead ends', () => {
  it('explains a community link instead of rejecting it as unparseable', () => {
    expect(() =>
      parseFigmaUrl('https://www.figma.com/community/file/1234567890/Some-Kit'),
    ).toThrow(/duplicate/i);
  });

  it('names the unsupported segment and lists what IS supported', () => {
    expect(() => parseFigmaUrl('https://www.figma.com/whiteboardy/ABC123DEF456/X')).toThrow(
      /does not recognise .*Supported links/is,
    );
  });

  it('tells the user to open a file when given the Figma home page', () => {
    expect(() => parseFigmaUrl('https://www.figma.com/')).toThrow(/home page/i);
  });

  it('rejects a malformed file key with guidance', () => {
    expect(() => parseFigmaUrl('https://www.figma.com/proto/abc/X')).toThrow(/file key/i);
  });

  it('asks for a link when given empty input', () => {
    expect(() => parseFigmaUrl('')).toThrow(/paste a figma link/i);
  });
});

describe('parseFigmaUrl - SSRF defence', () => {
  it('rejects a non-Figma host', () => {
    expect(() => parseFigmaUrl('https://evil.example.com/proto/ABC123DEF456/x')).toThrow(
      /only opens figma\.com/i,
    );
  });
  it('rejects internal addresses', () => {
    expect(() => parseFigmaUrl('http://169.254.169.254/latest/meta-data')).toThrow();
    expect(() => parseFigmaUrl('http://localhost:4000/admin')).toThrow();
    expect(() => parseFigmaUrl('http://127.0.0.1/proto/ABC123DEF456/x')).toThrow();
  });
  it('rejects non-http protocols', () => {
    expect(() => parseFigmaUrl('file:///etc/passwd')).toThrow();
    expect(() => parseFigmaUrl('javascript:alert(1)')).toThrow();
  });
  it('rejects look-alike hosts', () => {
    expect(() => parseFigmaUrl('https://figma.com.evil.net/proto/ABC123DEF456/x')).toThrow();
    expect(isAllowedFigmaHost('figma.com.evil.net')).toBe(false);
    expect(isAllowedFigmaHost('notfigma.com')).toBe(false);
  });
  it('does not let an embed wrapper smuggle a foreign host', () => {
    const inner = encodeURIComponent('https://evil.example.com/proto/ABC123DEF456/x');
    expect(() => parseFigmaUrl(`https://www.figma.com/embed?url=${inner}`)).toThrow(
      /only opens figma\.com/i,
    );
  });
  it('allows figma.com and the Make preview suffix', () => {
    expect(isAllowedFigmaHost('www.figma.com')).toBe(true);
    expect(isAllowedFigmaHost('abc-123-figmacachedpreview.figma.site')).toBe(true);
  });
});

describe('prototype URL building and viewer URL reading', () => {
  it('builds a URL targeting a specific node', () => {
    const u = buildPrototypeUrl('TJEIgarZebWrehJFEFycYw', 'E-commerce website Rosella', '145:61');
    expect(u).toContain('node-id=145-61');
    expect(u).toContain('TJEIgarZebWrehJFEFycYw');
  });
  it('handles a null file name', () => {
    expect(buildPrototypeUrl('ABC123DEF456', null, '1:2')).toContain('node-id=1-2');
  });
  it('reads the current node id back from a viewer URL (ADR-0004)', () => {
    // Exactly the transition observed live: Home -> Dresses.
    expect(
      extractNodeIdFromViewerUrl(
        'https://www.figma.com/proto/TJEIgarZebWrehJFEFycYw/E-commerce_website_Rosella?node-id=145-61',
      ),
    ).toBe('145:61');
  });
  it('returns null when the viewer URL has no node id', () => {
    expect(extractNodeIdFromViewerUrl('https://www.figma.com/proto/X/Y')).toBeNull();
  });
  it('returns null for a malformed viewer URL', () => {
    expect(extractNodeIdFromViewerUrl('not a url')).toBeNull();
  });
});
