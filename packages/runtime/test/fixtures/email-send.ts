import { b64url, buildMime, sha256Hex } from '../../src/connectors/google';
import type { EmailSendProposal } from '../../src/channels/approvals';

type Draft = Omit<EmailSendProposal, 'raw' | 'digest'>;

// The bytes send_email freezes for a draft: base64url canonical MIME and their digest. `wire` builds the bytes from
// other words than the card shows, for a proposal whose bytes and fields disagree.
export const emailProposal = async (draft: Draft, wire: Partial<Pick<Draft, 'subject' | 'body' | 'to'>> = {}): Promise<EmailSendProposal> => {
  const { to, cc, bcc, subject, body, message_id, inReplyTo, references } = { ...draft, ...wire };
  const raw = b64url(new TextEncoder().encode(buildMime({ to, ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}), subject, body, messageId: message_id, ...(inReplyTo ? { inReplyTo } : {}), ...(references ? { references } : {}) })));
  return { ...draft, raw, digest: await sha256Hex(raw) };
};

// The MIME text Gmail was handed: its header lines and its body, split where canonical MIME splits them.
export const sentMime = (raw: string): Readonly<{ headers: readonly string[]; body: string }> => {
  const binary = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
  const text = new TextDecoder().decode(Uint8Array.from(binary, character => character.charCodeAt(0)));
  const split = text.indexOf('\r\n\r\n');
  return { headers: text.slice(0, split).split('\r\n'), body: text.slice(split + 4) };
};
