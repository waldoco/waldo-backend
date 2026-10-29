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

// Confirmed once every support is the owner's own word; Waldo's read until then.
export const nodeConfirmation = (claims: readonly Claim[], node: Pick<ConstellationNode, 'supporting_spots'>): 'confirmed' | 'waldos_read' => {
  const supports = nodeSupports(claims, node);
  return supports.length > 0 && supports.every((claim) => claim.verification_status === 'owner-grounded') ? 'confirmed' : 'waldos_read';
};
