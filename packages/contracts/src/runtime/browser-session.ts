import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { idempotencyKeySchema } from './outbox';

const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const publicUrlSchema = z.url().refine((url) => /^https:\/\/(?![^/]*@)/.test(url), 'browser URL must be credential-free HTTPS');

export const browserSessionSchema = z.strictObject({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  provider: z.literal('browserbase_stagehand_http_v3'),
  providerSessionId: z.string().min(1),
  contextHandle: z.string().min(1).nullable(),
  mode: z.enum(['public', 'authenticated_takeover']),
  state: z.enum(['starting', 'active', 'takeover', 'ending', 'ended', 'lost', 'error']),
  generation: z.int().nonnegative(),
  expiresAt: z.int().nonnegative(),
  updatedAt: z.int().nonnegative(),
});
export type BrowserSession = z.infer<typeof browserSessionSchema>;

const browserCommandBase = {
  ownerId: z.string().min(1),
  sessionId: z.string().min(1),
  generation: z.int().nonnegative(),
  capabilityManifestDigest: digestSchema,
  idempotencyKey: idempotencyKeySchema,
  expiresAt: z.int().nonnegative(),
};

export const browserCommandSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...browserCommandBase, operation: z.literal('navigate'), url: publicUrlSchema }),
  z.strictObject({ ...browserCommandBase, operation: z.literal('observe'), instruction: z.string().min(1).max(1000) }),
  z.strictObject({ ...browserCommandBase, operation: z.literal('extract'), instruction: z.string().min(1).max(1000), schemaDigest: digestSchema }),
  z.strictObject({ ...browserCommandBase, operation: z.literal('act'), actionRef: z.string().min(1), actionDigest: digestSchema, approvalRef: z.string().min(1).nullable() }),
  z.strictObject({ ...browserCommandBase, operation: z.literal('end') }),
]);
export type BrowserCommand = z.infer<typeof browserCommandSchema>;

export interface BrowserExecutor {
  issue(session: BrowserSession, command: BrowserCommand): Promise<unknown>;
  recover(session: BrowserSession, command: BrowserCommand): Promise<
    | { status: 'known_not_applied' }
    | { status: 'observed'; result: unknown }
    | { status: 'indeterminate' }
  >;
}

export class BrowserSessionBoundary {
  private readonly sessions = new Map<string, BrowserSession>();

  constructor(private readonly options: Readonly<{
    executor: BrowserExecutor;
    authorizeManifest: (digest: string, operation: BrowserCommand['operation']) => boolean;
    now?: () => number;
  }>) {}

  put(authenticatedOwnerId: string, input: unknown): BrowserSession {
    const next = browserSessionSchema.parse(input);
    if (next.ownerId !== authenticatedOwnerId) throw new Error('browser owner mismatch');
    const prior = this.sessions.get(next.id);
    if (prior && (prior.ownerId !== next.ownerId || next.generation < prior.generation || next.updatedAt < prior.updatedAt)) {
      throw new Error('browser stale or cross-owner session');
    }
    const stored = Object.freeze({ ...next });
    this.sessions.set(stored.id, stored);
    return stored;
  }

  async dispatch(authenticatedOwnerId: string, input: unknown): Promise<unknown> {
    const command = browserCommandSchema.parse(input);
    if (command.ownerId !== authenticatedOwnerId) throw new Error('browser owner mismatch');
    if (command.expiresAt <= (this.options.now?.() ?? Date.now())) throw new Error('browser command expired');
    const session = this.sessions.get(command.sessionId);
    if (!session || session.ownerId !== authenticatedOwnerId || session.state !== 'active') throw new Error('browser session unavailable');
    if (session.expiresAt <= (this.options.now?.() ?? Date.now()) || session.generation !== command.generation) throw new Error('browser session generation mismatch');
    if (!this.options.authorizeManifest(command.capabilityManifestDigest, command.operation)) throw new Error('browser operation not authorized');
    if (session.mode !== 'public' && command.operation !== 'end') throw new Error('browser takeover required');
    if (command.operation === 'act' && command.approvalRef === null) throw new Error('browser act requires approval');
    const recovered = await this.options.executor.recover(session, command);
    if (recovered.status === 'observed') return recovered.result;
    if (recovered.status === 'indeterminate') throw new Error('browser outcome indeterminate');
    return this.options.executor.issue(session, command);
  }
}
