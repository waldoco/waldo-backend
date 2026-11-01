import { appNodeSourceV1Schema, type AppNodeSourceV1 } from '../../../contracts/src/app/controls';
import type { Claim, ConstellationNode } from './claims';

// A support claim Waldo read from a connected source names that source and the items it rests on in its source_ref:
// welcome:<source>:<pointer>,<pointer>. The pointers are the source's own ids (a thread, an event, a signal), never content.
// welcome:setup:<claim ids> names the owner's own setup answers a read rests on; it carries no app source, since the owner said it.
const PREFIX = 'welcome:';
export type WelcomeSource = AppNodeSourceV1 | 'setup';
export const sourceRef = (source: WelcomeSource, pointers: readonly string[]): string => `${PREFIX}${source}:${pointers.join(',')}`;
export const isWelcomeRef = (ref: string | null | undefined): boolean => ref?.startsWith(PREFIX) === true;
export const refSource = (ref: string | null | undefined): AppNodeSourceV1 | null => {
  if (!ref?.startsWith(PREFIX)) return null;
  const parsed = appNodeSourceV1Schema.safeParse(ref.slice(PREFIX.length).split(':')[0]);
  return parsed.success ? parsed.data : null;
};

export const supportIds = (node: Pick<ConstellationNode, 'supporting_spots'>): readonly number[] => {
  try { const ids: unknown = JSON.parse(node.supporting_spots); return Array.isArray(ids) ? ids.filter((id): id is number => Number.isSafeInteger(id)) : []; } catch { return []; }
};
export const nodeSupports = (claims: readonly Claim[], node: Pick<ConstellationNode, 'supporting_spots'>): readonly Claim[] => {
  const ids = new Set(supportIds(node));
  return claims.filter((claim) => ids.has(claim.id));
};

export const nodeSources = (claims: readonly Claim[], node: Pick<ConstellationNode, 'supporting_spots'>): readonly AppNodeSourceV1[] =>
  [...new Set(nodeSupports(claims, node).map((claim) => refSource(claim.source_ref)).filter((source): source is AppNodeSourceV1 => source !== null))];

// The owner's yes to a node's wording is one claim of this kind, cited by the node. It records that yes and nothing else: it is
// never listed, recalled, pinned or counted as evidence, and its node is confirmed only while its text is the node's wording.
// source_ref: node:<node id>:<where the owner said yes>, for example node:12:app:node.confirm.
export const NODE_STATEMENT = 'node_statement';
export const nodeWording = (node: Pick<ConstellationNode, 'label' | 'summary'>): string => `${node.label}: ${node.summary}`;
export const statementRef = (nodeId: number, where: string): string => `node:${nodeId}:${where}`;
const statementOf = (nodeId: number, claim: Pick<Claim, 'kind' | 'source_ref'>): boolean =>
  claim.kind === NODE_STATEMENT && claim.source_ref?.startsWith(`node:${nodeId}:`) === true;
export const nodeStatementIds = (claims: readonly Claim[], nodeId: number): readonly number[] =>
  claims.filter((claim) => statementOf(nodeId, claim)).map((claim) => claim.id);

export const HEALTH_NODE_SOURCES: ReadonlySet<AppNodeSourceV1 | null> = new Set<AppNodeSourceV1>(['apple_health', 'health_connect']);
// Words other people may have written (an invite, a mail subject), whether or not the owner has since confirmed the note.
export const othersWords = (claim: Pick<Claim, 'origin' | 'source_ref'>): boolean =>
  claim.origin === 'untrusted' || (refSource(claim.source_ref) !== null && !HEALTH_NODE_SOURCES.has(refSource(claim.source_ref)));

type Worded = Pick<ConstellationNode, 'id' | 'label' | 'summary' | 'supporting_spots'>;
export const statementConfirms = (claims: readonly Claim[], node: Worded): boolean =>
  nodeSupports(claims, node).some((claim) => statementOf(node.id, claim) && claim.status === 'active' && claim.text === nodeWording(node));

// Confirmed only when the owner said yes to the node's current wording. The wording is Waldo's until then, however its notes
// came to be the owner's: stated by them, or confirmed one by one.
export const nodeConfirmation = (claims: readonly Claim[], node: Worded): 'confirmed' | 'waldos_read' =>
  statementConfirms(claims, node) ? 'confirmed' : 'waldos_read';
