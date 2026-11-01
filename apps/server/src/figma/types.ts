/**
 * Minimal structural types for the Figma REST file payload.
 * Only the fields Lenz actually consumes are modelled; the real payload is
 * large (8.67 MB for Rosella) and fully typing it would add no safety.
 */

export interface FigmaRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FigmaAction {
  type: 'NODE' | 'URL' | 'BACK' | 'CLOSE' | 'OPEN_FILE' | 'UPDATE_MEDIA_RUNTIME' | string;
  destinationId?: string | null;
  navigation?: string;
  url?: string;
  transition?: unknown;
  preserveScrollPosition?: boolean;
}

export interface FigmaInteraction {
  trigger?: { type?: string; timeout?: number; delay?: number } | null;
  actions?: FigmaAction[];
}

export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FigmaNode[];
  absoluteBoundingBox?: FigmaRect | null;
  interactions?: FigmaInteraction[];
  /** Legacy single-destination fields, still present on some files. */
  transitionNodeID?: string | null;
  componentPropertyDefinitions?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface FigmaFlowStartingPoint {
  nodeId: string;
  name: string;
}

export interface FigmaCanvas extends FigmaNode {
  type: 'CANVAS';
  prototypeStartNodeID?: string | null;
  flowStartingPoints?: FigmaFlowStartingPoint[];
  prototypeDevice?: { type?: string; rotation?: string; size?: { width: number; height: number } };
}

export interface FigmaDocument extends FigmaNode {
  type: 'DOCUMENT';
  children: FigmaCanvas[];
}

export interface FigmaFileResponse {
  document: FigmaDocument;
  name: string;
  lastModified: string;
  thumbnailUrl?: string;
  version: string;
  role: string;
  editorType: string;
  linkAccess?: string;
  components?: Record<string, unknown>;
  componentSets?: Record<string, unknown>;
}

export interface FigmaImagesResponse {
  err: string | null;
  images: Record<string, string | null>;
}
