import { appSubjectFor } from '../channels/app-api';
import { commonOwnerAuthority } from './common-owner-authority';
import type { OwnerDirectoryEnv } from './owner-directory';
import { ownerRuntimeAuthority } from './owner-runtime-authority';

// How this Durable Object's owner reached it: a Telegram presence or the app account binding.
export type OwnerBinding = Readonly<{ surface: 'telegram' | 'app'; doName: string; subject: string }>;
export type VerifiedOwnerBinding = Readonly<{ directoryOwnerId: string; custodyDigest: string; stateVersion: number; doName: string; subject: string }>;
type BindingKv = Readonly<{ get<T>(key: string): T | undefined }>;
type OwnerNamespace = Readonly<{ idFromName(name: string): { toString(): string } }> | undefined;

// The binding this object holds for its owner: the Telegram presence first, else the app binding. Both must name this
// physical object; on any other object there is no binding, whatever the stored keys say.
export function localOwnerBinding(kv: BindingKv, owners: OwnerNamespace, actualDoId: string): OwnerBinding | undefined {
  const doName = kv.get<string>('do_name');
  if (!doName || !owners || owners.idFromName(doName).toString() !== actualDoId) return undefined;
  const telegram = kv.get<string>('telegram_subject');
  if (telegram && /^\d{1,32}$/.test(telegram) && kv.get<boolean>('telegram_unlinked') !== true) return { surface: 'telegram', doName, subject: telegram };
  const app = kv.get<string>('app_subject');
  if (app && app === String(appSubjectFor(doName)) && kv.get<boolean>('app_unlinked') !== true) return { surface: 'app', doName, subject: app };
  return undefined;
}

export function ownerBindingCurrent(kv: BindingKv, owners: OwnerNamespace, actualDoId: string, binding: OwnerBinding): boolean {
  const current = localOwnerBinding(kv, owners, actualDoId);
  return !!current && current.surface === binding.surface && current.doName === binding.doName && current.subject === binding.subject;
}

const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');

// The directory's current answer for a binding; null when it no longer admits the owner. The custody digest changes when
// the binding or its admission does, so custody pinned under one answer is not reused under another.
export async function verifyOwnerBinding(env: OwnerDirectoryEnv, binding: OwnerBinding, actualDoId: string, owners: OwnerNamespace): Promise<VerifiedOwnerBinding | null> {
  if (binding.surface === 'telegram') {
    const found = await commonOwnerAuthority(env).resolve('telegram', binding.subject, binding.doName);
    return found ? { directoryOwnerId: found.directoryOwnerId, custodyDigest: found.custodyDigest, stateVersion: found.stateVersion, doName: found.doName, subject: found.subject } : null;
  }
  if (!owners) throw new Error('owner runtime authority rejected');
  let found;
  try {
    found = await ownerRuntimeAuthority(env).resolve({ doName: binding.doName, actualDoId, expectedDoId: name => owners.idFromName(name).toString(), assertCurrent: () => undefined });
  } catch (error) {
    if (error instanceof Error && error.message === 'owner runtime authority revoked') return null;
    throw error;
  }
  const custodyDigest = await sha256(JSON.stringify(['app', found.ownerId, found.authenticatedUserId, found.doName, binding.subject, found.stateVersion, found.admissionRevision]));
  return { directoryOwnerId: found.ownerId, custodyDigest, stateVersion: found.stateVersion, doName: found.doName, subject: binding.subject };
}
