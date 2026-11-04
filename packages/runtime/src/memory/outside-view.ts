import { numericHealthIn } from '../scribe/sanitiser';
import type { Claim, ClaimStore, ConstellationNode } from './claims';
import { HEALTH_NODE_SOURCES, nodeStatementIds, nodeSupports, refSource } from './node-sources';

// What a model call built from outside content may read of the owner's memory: no health note, no stated reading and no read
// Waldo drew from a health source, and no constellation node drawn from health (a health reading, the health domain, or resting
// on any of those), so outside words can neither select health nor sit beside it. Edges follow their nodes.
// An area can only keep more out: a claim filed under body or mind stays out whatever its kind.
export const outsideSafe = (claim: Claim): boolean =>
  claim.kind !== 'health' && claim.area !== 'body' && claim.area !== 'mind' && !numericHealthIn(claim.text) && !HEALTH_NODE_SOURCES.has(refSource(claim.source_ref));

export const outsideView = (store: ClaimStore): ClaimStore => {
  const nodes = () => {
    const all = store.allClaims();
    const fromHealth = (node: ConstellationNode) => node.domain === 'health' || nodeSupports(all, node).some((claim) => !outsideSafe(claim));
    return store.nodes().filter((node) => !fromHealth(node));
  };
  return {
    ...store,
    claims: (status) => store.claims(status).filter(outsideSafe),
    recall: (query, limit, near) => store.recall(query, limit, near).filter(outsideSafe),
    nodes,
    edges: () => { const kept = new Set(nodes().map((node) => node.id)); return store.edges().filter((edge) => kept.has(edge.from_id) && kept.has(edge.to_id)); },
    statements: () => { const statements = store.statements(), kept = new Set(nodes().flatMap((node) => nodeStatementIds(statements, node.id))); return statements.filter((claim) => kept.has(claim.id)); },
  };
};
