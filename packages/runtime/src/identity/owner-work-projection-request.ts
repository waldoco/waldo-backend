import { z } from 'zod';
import { routerSignature } from './owner-directory';
import { sha256Hex } from '../connectors/google';

const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
const hex = z.string().regex(/^[a-f0-9]{64}$/);
export const ownerWorkProjectionRequestSchema = z.strictObject({
  version: z.literal('owner-work-read.v1'), do_name: z.string().min(1).max(240), physical_do_id: hex,
  directory_owner_id: uuid, state_version: z.int().nonnegative(), admission_revision: z.string().regex(/^[1-9][0-9]{0,18}$/),
  request_id: z.uuid(), at: z.int().nonnegative(), signature: hex,
});
export type OwnerWorkProjectionRequest = z.infer<typeof ownerWorkProjectionRequestSchema>;
export const ownerWorkUnitRowSchema = z.strictObject({
  id: z.string().min(1).max(128), ownerId: z.string().regex(/^owner_[a-f0-9]{64}$/), outcomeId: z.string().min(1).max(128),
  revision: z.int().positive(), responsibility: z.string(), state: z.string().min(1), createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }),
});
export type OwnerWorkUnitRow = z.infer<typeof ownerWorkUnitRowSchema>;
export const ownerWorkProjectionResponseSchema = z.strictObject({
  version: z.literal('owner-work-read.v1'), request_id: z.uuid(), directory_owner_id: uuid,
  canonical_owner_id: z.string().regex(/^owner_[a-f0-9]{64}$/), complete: z.literal(true), snapshot_digest: hex,
  units: z.array(ownerWorkUnitRowSchema),
});
export type OwnerWorkProjectionResponse = z.infer<typeof ownerWorkProjectionResponseSchema>;
const material = (input: Omit<OwnerWorkProjectionRequest, 'signature'>) => JSON.stringify([
  input.version, input.do_name, input.physical_do_id, input.directory_owner_id, input.state_version, input.admission_revision, input.request_id,
]);
export async function signOwnerWorkProjectionRequest(secret: string, input: Omit<OwnerWorkProjectionRequest, 'signature'>): Promise<OwnerWorkProjectionRequest> {
  if (!secret || secret.length < 32) throw Error('owner Work read signing unavailable');
  return ownerWorkProjectionRequestSchema.parse({ ...input, signature: await routerSignature(secret, input.at, material(input)) });
}
export async function verifyOwnerWorkProjectionRequest(secret: string | undefined, raw: OwnerWorkProjectionRequest, now: number) {
  const input = ownerWorkProjectionRequestSchema.parse(raw);
  if (!secret || secret.length < 32 || Math.abs(Math.floor(now / 1000) - input.at) > 60) throw Error('owner Work read rejected');
  const expected = await routerSignature(secret, input.at, material(input));
  let difference = 0; for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ input.signature.charCodeAt(i);
  if (difference) throw Error('owner Work read rejected');
  return input;
}
export const ownerWorkRootName = async (authenticatedUserId: string) => `owner-root:sha256:${await sha256Hex(`waldo-owner-root\0owner_${await sha256Hex(authenticatedUserId)}`)}`;
