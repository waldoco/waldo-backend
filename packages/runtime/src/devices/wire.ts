import { CAPABILITIES, CONTRACT_VERSION, LABEL_BYTES, IDENTIFIER_BYTES, KEY_BYTES, NONCE_BYTES, SIGNATURE_BYTES, TIMESTAMP_MAX, OUTBOX_DEPTH_MAX, NOTIFY_TITLE_BYTES, NOTIFY_BODY_BYTES, type Capability } from './contract';
import { decodeBase64url } from './signing';
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
export const identifier = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= IDENTIFIER_BYTES && /^[A-Za-z0-9_-]+$/.test(value);
export function capabilities(value: unknown): Capability[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) return null;
  const ordered = CAPABILITIES.filter((entry) => value.includes(entry));
  return ordered.length === value.length && ordered.every((entry, index) => entry === value[index]) ? ordered : null;
}
const byteString = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && new TextEncoder().encode(value).length >= min && new TextEncoder().encode(value).length <= max;
export type RedeemBody = { code: string; device_pubkey: string; label: string; declared_capabilities: Capability[]; contract_version: '0.2.3' };
export function redeemBody(value: unknown): RedeemBody | null {
  // Closed shape ensures signed data cannot silently widen transport capabilities.
  if (!record(value) || !exact(value, ['code', 'device_pubkey', 'label', 'declared_capabilities', 'contract_version']) || value.contract_version !== CONTRACT_VERSION || typeof value.code !== 'string' || !decodeBase64url(value.code, KEY_BYTES) || typeof value.device_pubkey !== 'string' || !decodeBase64url(value.device_pubkey, KEY_BYTES) || !byteString(value.label, 1, LABEL_BYTES) || !capabilities(value.declared_capabilities)) return null;
  return value as RedeemBody;
}
export function connectDeclaration(path: string): Capability[] | null {
  const prefix = `/devices/connect?contract_version=${CONTRACT_VERSION}&declared_capabilities=`;
  if (!path.startsWith(prefix)) return null;
  return capabilities(path.slice(prefix.length).split(','));
}
export type Heartbeat = { contract_version: string; type: 'heartbeat'; message_id: string; device_id: string; owner_id: string; timestamp: number; nonce: string; signature: string; payload: { declared_capabilities: Capability[]; outbox_depth: number } };
export function heartbeatFrame(value: unknown): Heartbeat | null {
  if (!record(value) || !exact(value, ['contract_version', 'type', 'message_id', 'device_id', 'owner_id', 'timestamp', 'nonce', 'signature', 'payload']) || value.contract_version !== CONTRACT_VERSION || value.type !== 'heartbeat' || typeof value.message_id !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.message_id) || !identifier(value.device_id) || !identifier(value.owner_id) || !Number.isSafeInteger(value.timestamp) || Number(value.timestamp) <= 0 || Number(value.timestamp) > TIMESTAMP_MAX || typeof value.nonce !== 'string' || !decodeBase64url(value.nonce, NONCE_BYTES) || typeof value.signature !== 'string' || !decodeBase64url(value.signature, SIGNATURE_BYTES) || !record(value.payload) || !exact(value.payload, ['declared_capabilities', 'outbox_depth']) || !capabilities(value.payload.declared_capabilities) || !Number.isInteger(value.payload.outbox_depth) || Number(value.payload.outbox_depth) < 0 || Number(value.payload.outbox_depth) > OUTBOX_DEPTH_MAX) return null;
  return value as Heartbeat;
}

export type QueryKind = 'session_status' | 'attempt_status' | 'worktree_watch';
export const queryKind = (value: unknown): value is QueryKind => value === 'session_status' || value === 'attempt_status' || value === 'worktree_watch';
export type QueryPayload = { query_id: string; query_kind: QueryKind };
export type NotifyPayload = { notification_id: string; title: string; body: string; severity: 'info' | 'warning' | 'error' };
export function commandPayload(kind: unknown, value: unknown): value is QueryPayload | NotifyPayload {
  if (!record(value)) return false;
  if (kind === 'machine_state_query') return exact(value, ['query_id', 'query_kind']) && identifier(value.query_id) && queryKind(value.query_kind);
  if (kind === 'notify_local') return exact(value, ['notification_id', 'title', 'body', 'severity']) && identifier(value.notification_id) && byteString(value.title, 1, NOTIFY_TITLE_BYTES) && byteString(value.body, 1, NOTIFY_BODY_BYTES) && ['info', 'warning', 'error'].includes(String(value.severity));
  return false;
}
export type CommandReference = { contract_version: string; type: 'ack' | 'result'; message_id: string; device_id: string; owner_id: string; command_id: string; revision: 1; idempotency_key: string; timestamp: number; nonce: string; signature: string };
export type Ack = CommandReference & { type: 'ack'; payload: { state: 'accepted' | 'rejected' | 'expired'; reason?: string } };
export type Result = CommandReference & { type: 'result'; payload: { status: 'answered' | 'delivered' | 'failed'; answer?: { query_id: string; query_kind: QueryKind; state: string }; reason?: string } };
function reference(value: unknown, type: string): value is CommandReference & { payload: Record<string, unknown> } {
  // Closed signed envelopes prevent reference or authority fields being smuggled through payloads.
  return record(value) && exact(value, ['contract_version', 'type', 'message_id', 'device_id', 'owner_id', 'command_id', 'revision', 'idempotency_key', 'timestamp', 'nonce', 'signature', 'payload']) && value.contract_version === CONTRACT_VERSION && value.type === type && typeof value.message_id === 'string' && /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value.message_id) && identifier(value.device_id) && identifier(value.owner_id) && identifier(value.command_id) && value.revision === 1 && identifier(value.idempotency_key) && Number.isSafeInteger(value.timestamp) && Number(value.timestamp) > 0 && Number(value.timestamp) <= TIMESTAMP_MAX && typeof value.nonce === 'string' && !!decodeBase64url(value.nonce, NONCE_BYTES) && typeof value.signature === 'string' && !!decodeBase64url(value.signature, SIGNATURE_BYTES) && record(value.payload);
}
export function ackFrame(value: unknown): Ack | null {
  if (!reference(value, 'ack')) return null;
  const payload = value.payload;
  if (payload.state === 'accepted' && exact(payload, ['state'])) return value as Ack;
  if (payload.state === 'expired' && exact(payload, ['state', 'reason']) && payload.reason === 'expired') return value as Ack;
  if (payload.state === 'rejected' && exact(payload, ['state', 'reason']) && ['invalid_shape', 'idempotency_conflict', 'unknown_command', 'version_mismatch'].includes(String(payload.reason))) return value as Ack;
  return null;
}
export function resultFrame(value: unknown): Result | null {
  if (!reference(value, 'result')) return null;
  const payload = value.payload;
  if (payload.status === 'delivered' && exact(payload, ['status'])) return value as Result;
  if (payload.status === 'failed' && exact(payload, ['status', 'reason']) && ['processing_failed', 'delivery_unknown'].includes(String(payload.reason))) return value as Result;
  const answer = payload.answer;
  if (payload.status === 'answered' && exact(payload, ['status', 'answer']) && record(answer) && exact(answer, ['query_id', 'query_kind', 'state']) && identifier(answer.query_id) && queryKind(answer.query_kind) && (answer.query_kind === 'worktree_watch' ? ['watching', 'stopped', 'unknown'] : ['idle', 'running', 'done', 'failed', 'unknown']).includes(String(answer.state))) return value as Result;
  return null;
}
