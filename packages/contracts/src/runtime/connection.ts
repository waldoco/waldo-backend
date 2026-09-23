import { z } from 'zod';

export const connectionStatusSchema = z.enum([
  'connecting', 'active', 'reauthorization_required', 'revoked', 'deleting', 'deleted', 'error',
]);

export const connectionSchema = z.strictObject({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  provider: z.string().min(1),
  providerAccountId: z.string().min(1),
  accountLabel: z.string().min(1),
  purpose: z.string().min(1),
  dataClasses: z.array(z.string().min(1)),
  scopes: z.array(z.string().min(1)),
  scopeRevision: z.int().nonnegative(),
  credentialHandle: z.string().min(1),
  credentialGeneration: z.int().nonnegative(),
  adapterVersion: z.string().min(1),
  consentEpoch: z.int().nonnegative(),
  revocationGeneration: z.int().nonnegative(),
  status: connectionStatusSchema,
  updatedAt: z.int().nonnegative(),
});
export type Connection = z.infer<typeof connectionSchema>;

const transitions: Readonly<Record<Connection['status'], readonly Connection['status'][]>> = {
  connecting: ['active', 'error', 'revoked'],
  active: ['active', 'reauthorization_required', 'revoked', 'error'],
  reauthorization_required: ['active', 'revoked', 'error'],
  revoked: ['revoked', 'deleting'],
  deleting: ['deleting', 'deleted', 'error'],
  deleted: ['deleted'],
  error: ['connecting', 'active', 'reauthorization_required', 'revoked', 'deleting', 'error'],
};

export class ConnectionModule {
  private readonly connections = new Map<string, Connection>();

  put(authenticatedOwnerId: string, input: unknown): Connection {
    const next = connectionSchema.parse(input);
    if (next.ownerId !== authenticatedOwnerId) throw new Error('connection owner mismatch');
    const prior = this.connections.get(next.id);
    if (prior) this.validateTransition(prior, next);
    const stored = Object.freeze({
      ...next,
      dataClasses: [...new Set(next.dataClasses)].sort(),
      scopes: [...new Set(next.scopes)].sort(),
    });
    this.connections.set(stored.id, stored);
    return stored;
  }

  get(authenticatedOwnerId: string, id: string): Connection | undefined {
    const connection = this.connections.get(id);
    return connection?.ownerId === authenticatedOwnerId ? connection : undefined;
  }

  list(authenticatedOwnerId: string): readonly Connection[] {
    return Object.freeze([...this.connections.values()]
      .filter((connection) => connection.ownerId === authenticatedOwnerId)
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.providerAccountId.localeCompare(b.providerAccountId)));
  }

  assertUsable(authenticatedOwnerId: string, id: string, requirements: {
    scopes: readonly string[];
    dataClasses: readonly string[];
    credentialGeneration: number;
    revocationGeneration: number;
    consentEpoch: number;
  }): Connection {
    const connection = this.get(authenticatedOwnerId, id);
    if (!connection || connection.status !== 'active') throw new Error('connection unavailable');
    if (connection.credentialGeneration !== requirements.credentialGeneration ||
      connection.revocationGeneration !== requirements.revocationGeneration ||
      connection.consentEpoch !== requirements.consentEpoch) throw new Error('connection generation mismatch');
    if (!requirements.scopes.every((scope) => connection.scopes.includes(scope))) throw new Error('connection scope missing');
    if (!requirements.dataClasses.every((value) => connection.dataClasses.includes(value))) throw new Error('connection data class missing');
    return connection;
  }

  private validateTransition(prior: Connection, next: Connection): void {
    if (prior.ownerId !== next.ownerId) throw new Error('connection owner mismatch');
    if (prior.provider !== next.provider || prior.providerAccountId !== next.providerAccountId) {
      throw new Error('connection account identity is immutable');
    }
    if (!transitions[prior.status].includes(next.status)) throw new Error('connection status transition denied');
    if (next.updatedAt < prior.updatedAt || next.scopeRevision < prior.scopeRevision ||
      next.credentialGeneration < prior.credentialGeneration || next.consentEpoch < prior.consentEpoch ||
      next.revocationGeneration < prior.revocationGeneration) throw new Error('connection generation cannot decrease');
    if (prior.status === 'revoked' && next.status === 'revoked' && next.revocationGeneration !== prior.revocationGeneration) {
      throw new Error('connection revoke is idempotent');
    }
  }
}
