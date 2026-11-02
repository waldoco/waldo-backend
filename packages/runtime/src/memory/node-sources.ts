import { appNodeSourceV13Schema, type AppNodeSourceV13 } from '../../../contracts/src/app/controls';
import type { Claim, ConstellationNode } from './claims';

// A support claim Waldo read from a connected source names that source and the items it rests on in its source_ref:
// welcome:<source>:<pointer>,<pointer>. The pointers are the source's own ids (a thread, an event, a signal), never content.
// welcome:setup:<claim ids> names the owner's own setup answers a read rests on; welcome:web:<finding ids> the look-up findings.
const PREFIX = 'welcome:';
export type WelcomeSource = AppNodeSourceV13;
export const sourceRef = (source: WelcomeSource, pointers: readonly string[]): string => `${PREFIX}${source}:${pointers.join(',')}`;
export const isWelcomeRef = (ref: string | null | undefined): boolean => ref?.startsWith(PREFIX) === true;
export const refPointers = (ref: string | null | undefined): readonly string[] =>
  ref?.startsWith(PREFIX) ? ref.slice(PREFIX.length).split(':').slice(1).join(':').split(',').filter(Boolean) : [];
export const refSource = (ref: string | null | undefined): AppNodeSourceV13 | null => {
  if (!ref?.startsWith(PREFIX)) return null;
  const parsed = appNodeSourceV13Schema.safeParse(ref.slice(PREFIX.length).split(':')[0]);
  return parsed.success ? parsed.data : null;
};

// The note a node was written on: its oldest support that is not the owner's yes. A welcome node's read is stored before the
// node, and evidence added to it later is stored after, so the oldest note is the one its words came from.
export const writtenOn = (claims: readonly Claim[], node: Pick<ConstellationNode, 'supporting_spots'>): Claim | undefined =>
  nodeSupports(claims, node).filter((claim) => claim.kind !== NODE_STATEMENT).sort((a, b) => a.id - b.id)[0];
export const supportIds = (node: Pick<ConstellationNode, 'supporting_spots'>): readonly number[] => {
  try { const ids: unknown = JSON.parse(node.supporting_spots); return Array.isArray(ids) ? ids.filter((id): id is number => Number.isSafeInteger(id)) : []; } catch { return []; }
};
export const nodeSupports = (claims: readonly Claim[], node: Pick<ConstellationNode, 'supporting_spots'>): readonly Claim[] => {
  const ids = new Set(supportIds(node));
  return claims.filter((claim) => ids.has(claim.id));
};

export const nodeSources = (claims: readonly Claim[], node: Pick<ConstellationNode, 'supporting_spots'>): readonly AppNodeSourceV13[] =>
  [...new Set(nodeSupports(claims, node).map((claim) => refSource(claim.source_ref)).filter((source): source is AppNodeSourceV13 => source !== null))];

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

export const HEALTH_NODE_SOURCES: ReadonlySet<AppNodeSourceV13 | null> = new Set<AppNodeSourceV13>(['apple_health', 'health_connect']);
// The sources that are the owner's own: their body's readings and their setup answers.
const OWN_SOURCES: ReadonlySet<AppNodeSourceV13 | null> = new Set<AppNodeSourceV13 | null>([null, ...HEALTH_NODE_SOURCES, 'setup']);
// Words other people may have written (an invite, a mail subject, a web page), whether or not the owner has since confirmed the note.
export const othersWords = (claim: Pick<Claim, 'origin' | 'source_ref'>): boolean =>
  claim.origin === 'untrusted' || !OWN_SOURCES.has(refSource(claim.source_ref));

type Worded = Pick<ConstellationNode, 'id' | 'label' | 'summary' | 'supporting_spots'>;
export const statementConfirms = (claims: readonly Claim[], node: Worded): boolean =>
  nodeSupports(claims, node).some((claim) => statementOf(node.id, claim) && claim.status === 'active' && claim.text === nodeWording(node));

// Confirmed only when the owner said yes to the node's current wording. The wording is Waldo's until then, however its notes
// came to be the owner's: stated by them, or confirmed one by one.
export const nodeConfirmation = (claims: readonly Claim[], node: Worded): 'confirmed' | 'waldos_read' =>
  statementConfirms(claims, node) ? 'confirmed' : 'waldos_read';
