import { z } from 'zod';
import { appChannelRevisionV1Schema, appLinkableChannelV1Schema, type AppChannelMutationV1 } from '../../../contracts/src/app/channels';
import { signedRpc, linkCodeHash, type OwnerDirectoryEnv } from './owner-directory';
import { ownerRuntimeAuthority, type OwnerRuntimeAuthority, type OwnerRuntimeLocator } from './owner-runtime-authority';
import { appSessionAuthority, type AppSessionAuthority } from './app-session-authority';
import { RightsError } from '../rights/jobs';

type Provider = AppChannelMutationV1['provider'];
export type OwnerChannelDirectory = {
  inventory(): Promise<{ revision: string; linked: Provider[] }>;
  issueLink(provider: Provider, expectedRevision: string): Promise<{ revision: string; code: string; expiresAt: number }>;
  unlink(provider: Provider, expectedRevision: string): Promise<{ revision: string }>;
};
const resultSchema = z.strictObject({ owner_id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i), do_name: z.string(), revision: appChannelRevisionV1Schema });
const inventorySchema = resultSchema.extend({ linked: z.array(appLinkableChannelV1Schema).max(2) });
const linkSchema = resultSchema.extend({ expires_at: z.int().nonnegative() });

// A channel reference cannot choose the owner. Both signed witnesses must bind
// to the real physical DO; mutations compare the current revision in SQL too.
export function ownerChannelDirectory(env: OwnerDirectoryEnv, owner: OwnerRuntimeAuthority, session: AppSessionAuthority,
  locator: OwnerRuntimeLocator, fetcher: typeof fetch = fetch): OwnerChannelDirectory {
  const rpc = signedRpc(env, fetcher), authority = ownerRuntimeAuthority(env, fetcher), sessionRead = appSessionAuthority(env, fetcher);
  const revision = `${owner.stateVersion}:${owner.admissionRevision}`;
  const check = async (allowChannelChange = false) => {
    const fresh = await authority.resolve(locator), live = await sessionRead(locator.doName, session.sessionHash);
    locator.assertCurrent();
    if (owner.ownerId !== session.ownerId || owner.doName !== session.doName || owner.doName !== locator.doName || session.revision !== revision
      || fresh.ownerId !== owner.ownerId || fresh.authenticatedUserId !== owner.authenticatedUserId || fresh.doName !== owner.doName
      || fresh.stateVersion !== owner.stateVersion || live.ownerId !== owner.ownerId || live.doName !== owner.doName
      || live.sessionHash !== session.sessionHash || live.expires !== session.expires || live.revision !== `${fresh.stateVersion}:${fresh.admissionRevision}`
      || (!allowChannelChange && live.revision !== revision)) throw new RightsError('rejected');
    return live.revision;
  };
  const invoke = async (fn: string, message: string, args: Record<string, string | number>) => {
    if (!rpc) throw new RightsError('unavailable');
    await check();
    return rpc(fn, message, { p_do_name: owner.doName, p_session_hash: session.sessionHash, p_expected_revision: revision, ...args });
  };
  const validate = async <T extends z.infer<typeof resultSchema>>(raw: unknown, schema: z.ZodType<T>, changed = false): Promise<T> => {
    if (raw === null) throw new RightsError('conflict');
    const row = schema.parse(raw), current = await check(changed);
    if (row.owner_id.toLowerCase() !== owner.ownerId || row.do_name !== owner.doName || row.revision !== current) throw new RightsError('rejected');
    return row;
  };
  const prefix = (kind: string) => `app.channels.${kind}.${owner.doName}.${session.sessionHash}.${revision}`;
  const mutation = (provider: Provider, expected: string) => {
    if (!appLinkableChannelV1Schema.safeParse(provider).success) throw new RightsError('invalid');
    if (expected !== revision) throw new RightsError('conflict');
  };
  return {
    async inventory() {
      const row = await validate(await invoke('owner_channel_inventory', prefix('inventory'), {}), inventorySchema);
      if (new Set(row.linked).size !== row.linked.length) throw new RightsError('unavailable');
      return { revision: row.revision, linked: row.linked };
    },
    async issueLink(provider, expected) {
      mutation(provider, expected);
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const code = [...crypto.getRandomValues(new Uint8Array(10))].map(byte => alphabet[byte % alphabet.length]).join('');
      const hash = await linkCodeHash(code);
      const row = await validate(await invoke('issue_link_code', `${prefix('link')}.${provider}.${hash}`, { p_provider: provider, p_code_hash: hash }), linkSchema);
      if (row.expires_at <= Date.now() || row.expires_at > Date.now() + 10 * 60_000 + 5000) throw new RightsError('unavailable');
      return { revision: row.revision, code, expiresAt: row.expires_at };
    },
    async unlink(provider, expected) {
      mutation(provider, expected);
      const row = await validate(await invoke('unlink_presence', `${prefix('unlink')}.${provider}`, { p_provider: provider }), resultSchema, true);
      return { revision: row.revision };
    },
  };
}
