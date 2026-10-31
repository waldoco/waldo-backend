import { sha256Hex } from '../../connectors/google';
import { stableJson } from '../../context-composer/canonical';
import type { OwnerDirectoryEnv } from '../../identity/owner-directory';
import { agentMailDirectory } from './handles';
import { agentMailInbox } from './inbox';
import { renderAgentMail, type AgentMailParts, type AgentMailRendered } from './render';

// Waldo sending as itself from the owner's Waldo address, through the Cloudflare Email Service binding. Only an approval
// card sends: the card freezes the rendered words and the digest of the parts, and approving re-renders the stored draft
// and sends those parts once. The service sets the Message-ID and Date itself and offers no lookup of a send, so a send
// that ends without an answer stays unknown.

export type AgentMailSenderBinding = Readonly<{ send(message: AgentMailParts): Promise<{ messageId: string }> }>;
export type AgentMailSendEnv = Readonly<{ AGENT_MAIL_INBOUND?: string; AGENT_MAIL_SEND?: string; AGENT_MAIL_DOMAIN?: string; AGENT_MAIL_SENDER?: AgentMailSenderBinding }>;

// Sending needs agent mail on, sending on, the domain and the binding; anything missing leaves it off.
export const agentMailSending = (env: AgentMailSendEnv): Readonly<{ domain: string; sender: AgentMailSenderBinding }> | null => {
  const domain = env.AGENT_MAIL_DOMAIN?.toLowerCase();
  return env.AGENT_MAIL_INBOUND === '1' && env.AGENT_MAIL_SEND === '1' && domain && env.AGENT_MAIL_SENDER ? { domain, sender: env.AGENT_MAIL_SENDER } : null;
};

// The error codes the Email Service binding throws, from its Workers API reference.
export const AGENT_MAIL_SEND_CODES = [
  'E_VALIDATION_ERROR', 'E_FIELD_MISSING', 'E_TOO_MANY_RECIPIENTS', 'E_TOO_MANY_ATTACHMENTS', 'E_SENDER_NOT_VERIFIED', 'E_RECIPIENT_NOT_ALLOWED',
  'E_RECIPIENT_SUPPRESSED', 'E_ACCOUNT_SUSPENDED', 'E_SENDER_DOMAIN_NOT_AVAILABLE', 'E_CONTENT_TOO_LARGE', 'E_DELIVERY_FAILED', 'E_RATE_LIMIT_EXCEEDED',
  'E_DAILY_LIMIT_EXCEEDED', 'E_INTERNAL_SERVER_ERROR', 'E_HEADER_NOT_ALLOWED', 'E_HEADER_USE_API_FIELD', 'E_HEADER_VALUE_INVALID', 'E_HEADER_VALUE_TOO_LONG',
  'E_HEADER_NAME_INVALID', 'E_HEADERS_TOO_LARGE', 'E_HEADERS_TOO_MANY',
] as const;
export type AgentMailSendCode = (typeof AGENT_MAIL_SEND_CODES)[number];
const KNOWN: ReadonlySet<string> = new Set(AGENT_MAIL_SEND_CODES);
// The fixed code alone: the message can carry addresses or words from the mail, so it is never read.
export const agentMailSendCode = (error: unknown): AgentMailSendCode | 'other' => {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && KNOWN.has(code) ? code as AgentMailSendCode : 'other';
};

// A refusal is the service saying it sent nothing. E_INTERNAL_SERVER_ERROR, an unknown code, a missing one and a lost
// answer may each have sent, so they are not refusals.
export type AgentMailRefusal = 'sender' | 'recipient' | 'limit' | 'content' | 'delivery';
const REFUSALS: Readonly<Record<Exclude<AgentMailSendCode, 'E_INTERNAL_SERVER_ERROR'>, AgentMailRefusal>> = {
  E_SENDER_NOT_VERIFIED: 'sender', E_SENDER_DOMAIN_NOT_AVAILABLE: 'sender', E_ACCOUNT_SUSPENDED: 'sender',
  E_RECIPIENT_NOT_ALLOWED: 'recipient', E_RECIPIENT_SUPPRESSED: 'recipient',
  E_RATE_LIMIT_EXCEEDED: 'limit', E_DAILY_LIMIT_EXCEEDED: 'limit',
  E_VALIDATION_ERROR: 'content', E_FIELD_MISSING: 'content', E_TOO_MANY_RECIPIENTS: 'content', E_TOO_MANY_ATTACHMENTS: 'content', E_CONTENT_TOO_LARGE: 'content',
  E_HEADER_NOT_ALLOWED: 'content', E_HEADER_USE_API_FIELD: 'content', E_HEADER_VALUE_INVALID: 'content', E_HEADER_VALUE_TOO_LONG: 'content',
  E_HEADER_NAME_INVALID: 'content', E_HEADERS_TOO_LARGE: 'content', E_HEADERS_TOO_MANY: 'content',
  E_DELIVERY_FAILED: 'delivery',
};
export const agentMailRefusal = (code: AgentMailSendCode | 'other'): AgentMailRefusal | null =>
  code === 'other' || code === 'E_INTERNAL_SERVER_ERROR' ? null : REFUSALS[code];
// Why it was not sent, in the owner's words.
export const AGENT_MAIL_REFUSED: Readonly<Record<AgentMailRefusal, string>> = {
  sender: 'sending from your Waldo address is not set up on the mail service',
  recipient: 'the mail service will not send to one of those addresses',
  limit: 'the mail service has reached its sending limit for now',
  content: 'the mail service refused the email as written',
  delivery: 'the mail service could not deliver it',
};

// The frozen card of a send as Waldo. body is the rendered plain text, the exact words the card shows; the parts are not
// stored (they carry the mark as base64), only their digest, so approving re-renders them from the fields here.
export type AgentMailSendProposal = Readonly<{
  operation_ref?: string;
  idempotency_key: string;
  handle: string;
  from: Readonly<{ name: string; address: string }>;
  owner_first_name: string | null;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  body_markdown: string;
  body: string;
  in_reply_to?: string;
  references?: readonly string[];
  parts_digest: string;
}>;
export type AgentMailDraftFields = Pick<AgentMailSendProposal, 'owner_first_name' | 'to' | 'cc' | 'subject' | 'body_markdown' | 'in_reply_to' | 'references'> & Readonly<{ from: Readonly<{ address: string }> }>;

// The parts depend only on In-Reply-To and References of the wire. The service sets the real Message-ID and Date, so a
// draft renders with fixed ones that only pass the renderer's checks, and every render of it is the same.
export const renderAgentMailDraft = (draft: AgentMailDraftFields): AgentMailRendered => renderAgentMail(
  { subject: draft.subject, body_markdown: draft.body_markdown },
  { address: draft.from.address, ownerFirstName: draft.owner_first_name },
  { to: draft.to, cc: draft.cc },
  { messageId: `<draft@${draft.from.address.slice(draft.from.address.lastIndexOf('@') + 1)}>`, date: 0,
    ...(draft.in_reply_to ? { inReplyTo: draft.in_reply_to } : {}), ...(draft.references?.length ? { references: draft.references } : {}) },
);
export const agentMailPartsDigest = async (parts: AgentMailParts): Promise<string> => `sha256:${await sha256Hex(stableJson(parts))}`;

// The parts to send, only while the stored draft still renders to the words and sender the card showed and to the parts
// its digest froze; with a domain, only from the owner's handle there.
export const agentMailIntact = async (p: AgentMailSendProposal, domain?: string): Promise<AgentMailParts | null> => {
  try {
    if (/[\r\n]/.test(p.subject) || (domain !== undefined && p.from.address !== `${p.handle}@${domain}`)) return null;
    const rendered = renderAgentMailDraft(p);
    if (!rendered.ok || rendered.preview.text !== p.body || rendered.preview.subject !== p.subject
      || rendered.preview.from.name !== p.from.name || rendered.preview.from.address !== p.from.address) return null;
    return await agentMailPartsDigest(rendered.parts) === p.parts_digest ? rendered.parts : null;
  } catch { return null; }
};

export type AgentMailDeskDep = Readonly<{
  intact(p: AgentMailSendProposal): Promise<AgentMailParts | null>;
  send(parts: AgentMailParts): Promise<{ messageId: string }>;
  sent(messageId: string, p: AgentMailSendProposal): void;
}>;
// The approval desk's sender, absent while sending is off. Approving re-checks that the owner still holds the handle the
// card sends from, so a released address never sends; a directory that cannot say counts as not held.
export const agentMailDeskDep = (env: AgentMailSendEnv & OwnerDirectoryEnv, storage: DurableObjectStorage, doName: () => string | undefined): AgentMailDeskDep | undefined => {
  const on = agentMailSending(env);
  if (!on) return undefined;
  return {
    intact: async p => {
      const parts = await agentMailIntact(p, on.domain), name = doName(), directory = name ? agentMailDirectory(env, name) : null;
      if (!parts || !directory) return null;
      try { return (await directory.current())?.handle === p.handle ? parts : null; } catch { return null; }
    },
    send: parts => on.sender.send(parts),
    sent: (messageId, p) => agentMailInbox(storage).recordOutbound(messageId, p.in_reply_to),
  };
};
