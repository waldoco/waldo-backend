import { numericHealthIn } from '../scribe/sanitiser';
import type { Claim, ClaimStore, ConstellationNode } from './claims';
import { HEALTH_NODE_SOURCES, nodeStatementIds, nodeSupports, nodeWording, refSource, statementConfirms, supportIds } from './node-sources';

// What a model call built from outside content may read of the owner's memory: no health note, no stated reading and no read
// Waldo drew from a health source, and no constellation node drawn from health (a health reading, the health, body or mind
// domain, or resting on any of those), so outside words can neither select health nor sit beside it. Edges follow their nodes.
// An area can only keep more out: a claim filed under body or mind stays out whatever its kind.
export const outsideSafe = (claim: Claim): boolean =>
  claim.kind !== 'health' && claim.area !== 'body' && claim.area !== 'mind' && !numericHealthIn(claim.text) && !HEALTH_NODE_SOURCES.has(refSource(claim.source_ref));

export const outsideView = (store: ClaimStore): ClaimStore => keptView(store, outsideSafe);

// What a run Waldo started is shown up front while its outside-content mark follows what it reads: the outside view, less every
// note the owner did not state themselves (read_memory's own rule for outside text: notes learned from outside content, imports,
// merges, Waldo's own reads, legacy rows), so nothing shown before its first read was written by someone else. read_memory
// still reaches those notes, and its result marks the run.
export const ownNotesView = (store: ClaimStore): ClaimStore => keptView(store, (claim) => outsideSafe(claim) && claim.origin === 'owner');

const keptView = (store: ClaimStore, kept: (claim: Claim) => boolean): ClaimStore => {
  const nodes = () => {
    const all = store.allClaims();
    const dropped = (node: ConstellationNode) => ['health', 'body', 'mind'].includes(node.domain) || nodeSupports(all, node).some((claim) => !kept(claim));
    return store.nodes().filter((node) => !dropped(node));
  };
  return {
    ...store,
    builtFromOutside: true,
    claims: (status) => store.claims(status).filter(kept),
    recall: (query, limit, near) => store.recall(query, limit, near).filter(kept),
    recallReplaced: (query, limit) => store.recallReplaced(query, limit).filter(kept),
    replacedClaims: (limit) => store.replacedClaims(limit).filter(kept),
    nodes,
    edges: () => { const kept = new Set(nodes().map((node) => node.id)); return store.edges().filter((edge) => kept.has(edge.from_id) && kept.has(edge.to_id)); },
    statements: () => { const statements = store.statements(), kept = new Set(nodes().flatMap((node) => nodeStatementIds(statements, node.id))); return statements.filter((claim) => kept.has(claim.id)); },
  };
};

const fromHealth = (all: readonly Claim[], node: ConstellationNode): boolean =>
  ['health', 'body', 'mind'].includes(node.domain) || nodeSupports(all, node).some((claim) => !outsideSafe(claim));

// The patterns this view keeps out that may still ride with the owner's shared health into a run Waldo starts, where that health
// already sits beside outside content: live, drawn from health, confirmed by the owner in their current wording, and stating no
// reading, while the owner keeps health in memory. Each is its wording only, on one line (a pattern the owner reworded is its
// label and summary both, so it is said once); the health notes under it never go with it.
export const confirmedBodyPatterns = (store: ClaimStore): readonly string[] => {
  if (store.keepsHealth?.() === false) return [];
  const all = store.allClaims(), live = new Set([...store.claims(), ...store.claims('promoted'), ...store.statements()].map((claim) => claim.id));
  return store.nodes().filter((node) => node.status === 'active' && fromHealth(all, node) && statementConfirms(all, node)
    && supportIds(node).every((id) => live.has(id)) && !numericHealthIn(nodeWording(node)))
    .map((node) => (node.label === node.summary ? node.label : nodeWording(node)).replace(/\s+/g, ' ').trim());
};
