import { z } from 'zod';
import {
  replyApprovalPartV1Schema, replyChartSeriesPartV1Schema, replyFilePartV1Schema, replyQuickRepliesPartV1Schema,
  replyReceiptPartV1Schema, replyVisibilityV1Schema, replyVoicePartV1Schema, REPLY_TEXT_MAX_CHARS,
} from './parts';

export const APP_AGENT_VERSION = 'app.v1' as const;
// The contract revisions an app build reads, as `name=revision` pairs, e.g. `approvals=2`. Installed builds parse
// strictly and drop what they cannot read, so a response grows past a contract's first revision only for a request
// that names a later one. No header, a value that does not parse or a contract it leaves out reads revision 1.
// Names this backend does not know are kept, so a newer build can declare them.
export const APP_CONTRACT_HEADER = 'x-waldo-app-contract' as const;
const contractPair = /^([a-z][a-z0-9_]{0,31})=([1-9][0-9]{0,3})$/;
export const appContractHeaderV1Schema = z.string().max(512).transform((value, ctx) => {
  const revisions: Record<string, number> = {};
  for (const pair of value.split(',')) {
    const match = contractPair.exec(pair);
    if (!match || Object.hasOwn(revisions, match[1]!)) { ctx.addIssue({ code: 'custom', message: 'expected distinct name=revision pairs' }); return z.NEVER; }
    revisions[match[1]!] = Number(match[2]);
  }
  return revisions;
});
export const appContractRevision = (header: string | null | undefined, contract: string): number => {
  const parsed = appContractHeaderV1Schema.safeParse(header);
  return parsed.success && Object.hasOwn(parsed.data, contract) ? parsed.data[contract]! : 1;
};
export const APP_SEND_MAX_WIRE_BYTES = 32768;
export const appJsonWireBytes = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return Infinity;
  let bytes = 0;
  for (const character of serialized) { const point = character.codePointAt(0)!; bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return bytes;
};
export const appSendWireFits = (value: unknown): boolean => appJsonWireBytes(value) <= APP_SEND_MAX_WIRE_BYTES;
// The console invite code (runtime identity/invite-code.ts). Sign-in admits a new member only
// by its hash, so both the code request and the verify carry it; the app upper-cases first.
const invite = z.string().regex(/^[A-HJ-NP-Z2-9]{20}$/);
export const appCodeRequestSchema = z.strictObject({ email: z.email().max(254), invite: invite.optional() });
export const appCodeResultSchema = z.strictObject({ ok: z.literal(true) });
// phone is the number a new member joins with, in E.164 as the console stores it. It is unverified contact data until the
// owner texts their link code to Waldo from it. A member who already has an account is not changed by it.
const joinPhone = z.string().regex(/^\+[1-9]\d{6,14}$/);
// link is the ticket from an /auth/id_token answer of confirm_with_email_code: with it, the code also confirms that Apple
// or Google identity for later sign-ins. Without it, or with one that expired, the code still signs the owner in.
const signinLink = z.string().min(20).max(2048);
export const appVerifyRequestV1Schema = z.strictObject({ email: z.email().max(254), code: z.string().regex(/^\d{4,10}$/), invite: invite.optional(), phone: joinPhone.optional(), link: signinLink.optional() });
// Sign in with Apple or Google: id_token is the identity token the platform SDK returned. nonce is the raw value whose
// SHA-256, lower-case hex, the app handed the SDK; Supabase hashes it the same way and compares it with the token's nonce
// claim. Supabase also checks the signature, the issuer and that the audience is a client id the provider lists. The owner
// is resolved from the email Supabase confirms, never one the app sends, then as /auth/verify resolves it, with the same
// invite and phone. A token Supabase refuses, or one with no confirmed email, gets the generic 403. request_id names the
// attempt for the client's own retries; the backend keeps no record of it, so a repeat may open another session, though it
// never creates a second owner or spends an invite twice. authorization_code is Apple's one-time code from the same sign-in: accepted and
// unused until the backend holds Apple's Sign in with Apple key, after which it is exchanged for the refresh token that
// account deletion revokes with Apple.
const idToken = z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
const idTokenNonce = z.string().regex(/^[A-Za-z0-9._~-]{16,128}$/);
const idTokenRequestId = z.string().regex(/^[A-Za-z0-9_-]{8,80}$/);
export const appIdTokenRequestV1Schema = z.discriminatedUnion('provider', [
  z.strictObject({ provider: z.literal('apple'), id_token: idToken, nonce: idTokenNonce, request_id: idTokenRequestId, invite: invite.optional(), phone: joinPhone.optional(), authorization_code: z.string().regex(/^[A-Za-z0-9._-]{16,1024}$/).optional() }),
  z.strictObject({ provider: z.literal('google'), id_token: idToken, nonce: idTokenNonce, request_id: idTokenRequestId, invite: invite.optional(), phone: joinPhone.optional() }),
]);
// absolute_expires_at is when this credential stops working. renew_after, when sent, is when the app should call
// /auth/renew for a new credential.
export const appSessionV1Schema = z.strictObject({
  state: z.literal('active'), session_ref: z.string().regex(/^sess_[a-f0-9]{64}$/),
  account_ref: z.string().regex(/^acct_[a-f0-9]{64}$/), surface: z.literal('app'),
  absolute_expires_at: z.int().nonnegative(), renew_after: z.int().nonnegative().optional(),
});
export const appVerifyResultV1Schema = z.union([
  appSessionV1Schema.extend({ credential: z.string().min(20).max(512) }),
  z.strictObject({ state: z.literal('needs_invite') }),
]);
// confirm_with_email_code: the identity reached an existing owner but has not signed them in before. Nothing is signed in;
// Waldo has emailed a code to `email`, the owner's address, which the token already named. The app sends that code to
// /auth/verify with `link`; the session comes from there, and later sign-ins with this identity go straight through.
export const appIdTokenResultV1Schema = z.union([
  ...appVerifyResultV1Schema.options,
  z.strictObject({ state: z.literal('confirm_with_email_code'), email: z.email().max(254), link: signinLink }),
]);
export const appSignoutResultV1Schema = z.strictObject({ result: z.enum(['revoked', 'already_gone']) });
// A new credential for a new session, and when to renew that. The presented credential keeps working for 5 more
// minutes, then stops; it renews once, so a second renewal of it is refused.
export const appRenewResultV1Schema = appSessionV1Schema.extend({ credential: z.string().min(20).max(512), renew_after: z.int().nonnegative() });
export const appClientMessageIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const appSendRequestV1Schema = z.strictObject({
  client_message_id: appClientMessageIdV1Schema, text: z.string().trim().min(1).max(4000),
});
export const appSendResultV1Schema = z.strictObject({
  accepted: z.literal(true), message_id: z.string().min(1),
  state: z.enum(['admitted', 'running', 'completed', 'interrupted', 'revoked']).optional(),
});
// Chat revision 2 (`chat=2`): a running message's receipt carries `draft`, the reply written so far, a prefix of the reply
// its transcript row will hold. Revision 1 clients never receive the field.
export const APP_CHAT_DRAFT_REVISION = 2;
// Chat revision 3 (`chat=3`) adds `activity`: what kind of work the running turn's tools are on, from the tool's name only
// (never its arguments or output), and since when (epoch ms). Set when a tool starts; gone once the reply's draft shows or
// the turn ends. Revision 2 receipts never carry it. A closed vocabulary the client words itself; a new kind is a contract
// change the app lane hears of first.
export const APP_CHAT_ACTIVITY_REVISION = 3;
// Chat revision 4 (`chat=4`): a reply may carry `file` parts, one per file its turn produced for the owner (today an exported
// PDF). The app opens one at GET /app/v1/files/<encodeURIComponent(file_ref)> with its own session; file_ref stays opaque.
// A part comes before the receipt part, which stays last, and `text` is unchanged. Revision 3 readers never receive one.
export const APP_CHAT_FILES_REVISION = 4;
export const APP_CHAT_ACTIVITY_KINDS = ['mail', 'calendar', 'tasks', 'web', 'files', 'health', 'memory', 'reminders', 'artifacts', 'settings', 'skills', 'actions', 'working'] as const;
export type AppChatActivityKind = typeof APP_CHAT_ACTIVITY_KINDS[number];
export const appChatActivityV1Schema = z.strictObject({ kind: z.enum(APP_CHAT_ACTIVITY_KINDS), since: z.int().nonnegative() });
export const appMessageReceiptV1Schema=appSendResultV1Schema.extend({state:z.enum(['admitted','running','completed','interrupted','revoked']),closed_reason:z.enum(['interrupted','session_revoked','cancelled','archived','deleted','thread_changed']).optional(),effects_unconfirmed:z.boolean().optional(),draft:z.string().min(1).max(REPLY_TEXT_MAX_CHARS).optional(),activity:appChatActivityV1Schema.optional()});
export const appMessagePartV1Schema = z.union([
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('operation'), operation_id: z.string(), state: z.enum(['admitted', 'running', 'completed', 'interrupted', 'revoked']), message: z.string() }),
  z.strictObject({ type: z.literal('artifact'), artifact_id: z.string(), revision: z.int().positive(), title: z.string(), download_path: z.string() }),
  replyApprovalPartV1Schema, replyQuickRepliesPartV1Schema, replyChartSeriesPartV1Schema, replyFilePartV1Schema, replyVoicePartV1Schema,
  replyReceiptPartV1Schema,
]);
// Chat revision 6 (`chat=6`): a main-chat reply the owner rated carries `rating`, so a rating survives a relaunch. An unrated
// reply, a user row and every thread row leave the key out, and revisions below 6 never receive it.
export const APP_CHAT_RATING_REVISION = 6;
// `text` is never empty when `parts` holds anything other than a text part, so a reader that draws only `text`
// always shows the message. `created_at` is epoch ms when the row was stored; rows stored before the time
// was kept have none, and no time is ever invented for them.
export const appMessageV1Schema = z.strictObject({
  id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), parts: z.array(appMessagePartV1Schema),
  channel: z.string(), parent_id: z.string().nullable(), visibility: replyVisibilityV1Schema.optional(),
  created_at: z.int().nonnegative().optional(),
  rating: z.enum(['up', 'down']).optional(),
});
// The history row `id`, URL-encoded in a path.
export const appMessageIdV1Schema = z.string().min(1).max(256);
// Only assistant messages can be rated; any other id is not found. A rating changes style and which messages
// arrive, never what is true or what Waldo may do. null clears it. Repeating a request_id returns its first result.
export const appRatingRequestV1Schema = z.strictObject({ request_id: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/), rating: z.enum(['up', 'down']).nullable() });
export const appRatingResultV1Schema = z.strictObject({ request_id: appRatingRequestV1Schema.shape.request_id, message_id: appMessageIdV1Schema, rating: appRatingRequestV1Schema.shape.rating });
export const appHistoryResultV1Schema = z.strictObject({ messages: z.array(appMessageV1Schema), next_cursor: z.string().nullable() });
// Codes name the non-generic failures a client can act on. The generic error stays code-free, so a
// pre-authentication answer cannot say whether an address is invited. step_up_required (403): the action needs a sign-in
// from the last two hours; the app signs in again (an email code, Apple or Google) and retries it.
export const appErrorCodeV1Schema = z.enum(['client_message_id_reused', 'inbox_full', 'request_reused', 'stale_read', 'no_longer_eligible', 'receipt_capacity', 'step_up_required']);
export const appProblemV1Schema = z.strictObject({ error: z.string(), code: appErrorCodeV1Schema.optional(), message: z.string().max(1000).optional() })
  .refine(problem => problem.error !== 'unavailable' || problem.code === undefined, { error: 'the generic error carries no code', path: ['code'] });
// "Connect iMessage": a one-time code the owner sends from their own iPhone to the Waldo iMessage address, which
// links that number to their own Waldo. send_url opens Messages with the text filled in. 503 where the shared
// Waldo number is not configured.
export const appIMessageLinkCodeV1Schema = z.strictObject({
  code: z.string().regex(/^[A-HJ-NP-Z2-9]{10}$/), text: z.string().regex(/^waldo [A-HJ-NP-Z2-9]{10}$/),
  address: z.string().min(3).max(320), send_url: z.string().startsWith('sms:').max(512), expires_in_seconds: z.literal(600),
});
// Before sign-in: whether this server admits a new account with no invite. Open, sign-up asks for no invite code; closed, it
// does. A Worker without the route answers 404, which reads as closed.
export const appAuthOptionsV1Schema = z.strictObject({ open_signup: z.boolean() });
export const appCoreRoutesV1 = [
  { method: 'GET', path: '/app/v1/auth/options', response: appAuthOptionsV1Schema, authenticated: false, success_status: 200 },
  { method: 'POST', path: '/app/v1/auth/code', request: appCodeRequestSchema, response: appCodeResultSchema, authenticated: false, success_status: 200 },
  { method: 'POST', path: '/app/v1/auth/verify', request: appVerifyRequestV1Schema, response: appVerifyResultV1Schema, authenticated: false, success_status: 200 },
  // A Worker without this route answers 404; the app then offers the email code only.
  { method: 'POST', path: '/app/v1/auth/id_token', request: appIdTokenRequestV1Schema, response: appIdTokenResultV1Schema, authenticated: false, success_status: 200 },
  { method: 'GET', path: '/app/v1/session', response: appSessionV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/auth/signout', response: appSignoutResultV1Schema, authenticated: true, success_status: 200 },
  // A Worker without this route answers 404; the app then keeps its credential.
  { method: 'POST', path: '/app/v1/auth/renew', response: appRenewResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/channels/imessage/link-code', response: appIMessageLinkCodeV1Schema, authenticated: true, success_status: 200 },
  { method:'GET', path:'/app/v1/chat/main/messages/{client_message_id}',response:appMessageReceiptV1Schema,authenticated:true,success_status:200 },
  { method: 'GET', path: '/app/v1/chat/main', response: appHistoryResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/chat/main/messages', request: appSendRequestV1Schema, response: appSendResultV1Schema, authenticated: true, success_status: 202, max_request_bytes: APP_SEND_MAX_WIRE_BYTES },
  // Stops that turn. A turn that already closed returns its recorded receipt; an effect dispatched before the
  // stop leaves effects_unconfirmed true. A Worker without this route answers 404.
  { method: 'POST', path: '/app/v1/chat/main/messages/{client_message_id}/cancel', response: appMessageReceiptV1Schema, authenticated: true, success_status: 200 },
  { method: 'PUT', path: '/app/v1/chat/main/messages/{message_id}/rating', request: appRatingRequestV1Schema, response: appRatingResultV1Schema, authenticated: true, success_status: 200 },
] as const;

export type AppSessionV1 = z.infer<typeof appSessionV1Schema>;
export type AppSendV1 = z.infer<typeof appSendRequestV1Schema>;
export type AppMessageV1 = z.infer<typeof appMessageV1Schema>;
