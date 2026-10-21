import type { Claim, Interpretation } from './memory-model';

// Which nodes and links the Memory map shows, from the saved Spots and patterns this read returned. The rule is
// the landing's (after andrewtrousdale.com): Waldo in the middle with a first ring round him, and choosing a node
// narrows the web to the way back to Waldo, that node, what it is made of, and what turns up with it (greyer).
// Support edges come from saved membership. Root spokes are layout only; dotted pattern edges
// are derived shared-support context, never a stored association.

export const ROOT = 'waldo';
export type Shape = 'root' | 'hexagon' | 'circle' | 'square' | 'triangle';
export type GNode = { id: string; shape: Shape; title: string; summary: string; number?: number; connected?: boolean };
export type GLink = { id: string; source: string; target: string; kind: 'angled' | 'solid' | 'dashed' | 'dotted'; distance: number; relation: 'layout' | 'saved-support' | 'shared-support' };

/** A Spot's shape says where it came from: you said it, you confirmed it, or he inferred it. */
export const SOURCE: Record<string, { name: string; shape: Shape }> = {
  stated: { name: 'You said this', shape: 'circle' },
  confirmed: { name: 'You confirmed this', shape: 'square' },
  inferred: { name: 'He inferred this', shape: 'triangle' },
};
const sourceOf = (spot: Claim) => SOURCE[spot.source] ?? { name: 'Saved', shape: 'circle' as const };

export type MapModel = {
  patterns: Interpretation[];
  returnedPatterns: number;
  allPatterns: Interpretation[];
  spots: Map<string, Claim>;
  spotsOf: Map<string, string[]>;
  patternsOf: Map<string, string[]>;
  number: Map<string, number>;
};

const FIRST_RING = 2, MAX_PATTERNS = 12, MAX_SPOTS = 14, MAX_LOOSE = 6, MAX_SPOTS_FOCUS = 30;
const SPOKE = 168, LEG = 92, FAR = 150;

export function buildModel(patterns: Interpretation[], spots: Claim[]): MapModel {
  const byId = new Map(spots.map(spot => [spot.id, spot]));
  const shown = patterns.slice(0, MAX_PATTERNS);
  const spotsOf = new Map<string, string[]>(), patternsOf = new Map<string, string[]>();
  for (const pattern of shown) {
    const present = pattern.support.claim_ids.filter(id => byId.has(id));
    spotsOf.set(pattern.id, present);
    for (const id of present) patternsOf.set(id, [...(patternsOf.get(id) ?? []), pattern.id]);
  }
  return { allPatterns: patterns, returnedPatterns: patterns.length, patterns: shown, spots: byId, spotsOf, patternsOf, number: new Map(shown.map((p, i) => [p.id, i + 1])) };
}

export const patternNode = (model: MapModel, pattern: Interpretation, connected = false): GNode => {
  const count = model.spotsOf.get(pattern.id)?.length ?? 0;
  return { id: pattern.id, shape: 'hexagon', title: pattern.label, summary: `${count} returned ${count === 1 ? 'Spot' : 'Spots'}${pattern.stored_status === 'active' ? '' : ' · ' + pattern.stored_status}`, number: model.number.get(pattern.id), connected };
};
export const spotNode = (spot: Claim, connected = false): GNode => {
  const source = sourceOf(spot);
  return { id: spot.id, shape: source.shape, title: spot.text, summary: source.name, connected };
};
export const rootNode = (model: MapModel): GNode => ({ id: ROOT, shape: 'root', title: 'Waldo', summary: `${model.patterns.length} patterns · ${model.spots.size} Spots` });
export const nodeOf = (model: MapModel, id: string): GNode | null => {
  if (id === ROOT) return rootNode(model);
  const pattern = model.patterns.find(p => p.id === id);
  if (pattern) return patternNode(model, pattern);
  const spot = model.spots.get(id);
  return spot ? spotNode(spot) : null;
};

export type Focus = 'patterns' | 'spots';
export function visible(model: MapModel, current: string | null, focus: Focus = 'patterns'): { nodes: GNode[]; links: GLink[] } {
  const nodes = new Map<string, GNode>([[ROOT, rootNode(model)]]);
  const links: GLink[] = [];
  const add = (node: GNode) => { if (!nodes.has(node.id)) nodes.set(node.id, node); };
  const spoke = (pattern: Interpretation) => { add(patternNode(model, pattern)); links.push({ id: `${ROOT}>${pattern.id}`, source: ROOT, target: pattern.id, kind: 'angled', distance: SPOKE, relation: 'layout' }); };
  const leg = (parent: string, spot: Claim) => { add(spotNode(spot)); links.push({ id: `${parent}>${spot.id}`, source: parent, target: spot.id, kind: spot.source === 'inferred' ? 'dashed' : 'solid', distance: LEG, relation: parent === ROOT ? 'layout' : 'saved-support' }); };
  const dotted = (a: string, node: GNode) => { add(node); links.push({ id: `${a}~${node.id}`, source: a, target: node.id, kind: 'dotted', distance: FAR, relation: a === ROOT ? 'layout' : model.spots.has(a) ? 'saved-support' : 'shared-support' }); };
  const pattern = current ? model.patterns.find(p => p.id === current) : undefined;
  const spot = current ? model.spots.get(current) : undefined;

  if (pattern) {
    spoke(pattern);
    for (const id of (model.spotsOf.get(pattern.id) ?? []).slice(0, MAX_SPOTS)) leg(pattern.id, model.spots.get(id)!);
    // patterns that share a Spot with this one turn up with it
    const near = new Set((model.spotsOf.get(pattern.id) ?? []).flatMap(id => model.patternsOf.get(id) ?? []));
    near.delete(pattern.id);
    for (const id of near) dotted(pattern.id, patternNode(model, model.patterns.find(p => p.id === id)!, true));
  } else if (spot) {
    const [first, ...others] = model.patternsOf.get(spot.id) ?? [];
    const parent = model.patterns.find(p => p.id === first);
    if (parent) { spoke(parent); leg(parent.id, spot); } else leg(ROOT, spot);
    for (const id of others) dotted(spot.id, patternNode(model, model.patterns.find(p => p.id === id)!, true));
  } else if (focus === 'spots') {
    // every Spot on the page, each on its first pattern; Spots no pattern uses yet hang straight off Waldo
    for (const each of [...model.spots.values()].slice(0, MAX_SPOTS_FOCUS)) {
      const parent = model.patterns.find(p => p.id === model.patternsOf.get(each.id)?.[0]);
      if (parent) { if (!nodes.has(parent.id)) spoke(parent); leg(parent.id, each); } else leg(ROOT, each);
    }
  } else {
    for (const each of model.patterns) {
      spoke(each);
      for (const id of (model.spotsOf.get(each.id) ?? []).slice(0, FIRST_RING)) if (!nodes.has(id)) leg(each.id, model.spots.get(id)!);
    }
    // Spots no pattern on this page uses yet hang loose off Waldo, greyer
    const loose = [...model.spots.values()].filter(s => !model.patternsOf.has(s.id)).slice(0, MAX_LOOSE);
    for (const each of loose) dotted(ROOT, spotNode(each, true));
  }
  return { nodes: [...nodes.values()], links };
}
